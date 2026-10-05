// slapd: reads the MacBook's built-in accelerometer (Apple Silicon SPU,
// AppleSPUHIDDevice, vendor usage page 0xFF00 / usage 3) and writes one JSON
// line per detected hit, its time and peak, to stdout (and, with --out,
// appended to a file). The spank Claude Code plugin spawns it, reads its
// stdout and turns each peak into a level.
//
// Runs unprivileged on macOS 27; older releases refuse the HID device
// without root, so prefix sudo there:
//   ./slapd                      # detect hits
//   ./slapd --raw                # print live magnitude, to pick a threshold
//   ./slapd --threshold 0.08     # less sensitive
//
// Several slapd may read the sensor at once (the HID device opens shared); the
// plugin decides which Claude Code session reacts.

import Foundation
import IOKit
import IOKit.hid

// MARK: config

struct Config {
    var out: String?
    var threshold = 0.05   // g of dynamic acceleration that counts as a hit
    var cooldown = 0.35    // s between two hits
    var window = 0.06      // s after the trigger to find the peak
    var raw = false
}

func parseArgs() -> Config {
    var c = Config()
    var args = CommandLine.arguments.dropFirst()
    while let a = args.popFirst() {
        switch a {
        case "--out": c.out = args.popFirst()
        case "--threshold": c.threshold = Double(args.popFirst() ?? "") ?? c.threshold
        case "--cooldown": c.cooldown = (Double(args.popFirst() ?? "") ?? c.cooldown * 1000) / 1000
        case "--raw": c.raw = true
        case "-h", "--help":
            print("usage: slapd [--out FILE] [--threshold G] [--cooldown MS] [--raw]")
            exit(0)
        default:
            fail("unknown argument: \(a)")
        }
    }
    return c
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write("slapd: \(msg)\n".data(using: .utf8)!)
    exit(1)
}

func warn(_ msg: String) {
    FileHandle.standardError.write("slapd: \(msg)\n".data(using: .utf8)!)
}

// MARK: output

final class Sink {
    let file: FileHandle?

    init(path: String?) {
        guard let path else {
            file = nil
            return
        }
        let url = URL(fileURLWithPath: path)
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o755])
        if !fm.fileExists(atPath: path) {
            fm.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o644])
        }
        file = FileHandle(forWritingAtPath: path)
        file?.seekToEndOfFile()
        if file == nil { warn("cannot write \(path), stdout only") }
    }

    func emit(_ obj: [String: Any], toFile: Bool = true) {
        var line = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
        line.append(0x0A)
        FileHandle.standardOutput.write(line)
        if toFile { file?.write(line) }
    }
}

func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

// A Double as JSON with 4 decimals, not its full binary expansion.
func num(_ v: Double) -> NSDecimalNumber { NSDecimalNumber(string: String(format: "%.4f", v)) }

// MARK: detection

// Gravity is tracked with a slow low-pass per axis; what is left is the
// dynamic acceleration. A hit is that magnitude crossing the threshold (and
// well above the running noise floor), then the peak within a short window.
final class Detector {
    let cfg: Config
    let sink: Sink

    var gravity = [0.0, 0.0, 0.0]
    var primed = false
    var lastT = 0.0
    var noise = 0.0

    var eventStart: Double?
    var eventPeak = 0.0
    var lastHit = -1.0

    var rawPeak = 0.0
    var rawSince = 0.0

    init(cfg: Config, sink: Sink) {
        self.cfg = cfg
        self.sink = sink
    }

    func sample(x: Double, y: Double, z: Double, t: Double) {
        if !primed {
            gravity = [x, y, z]
            primed = true
            lastT = t
            rawSince = t
            return
        }
        let dt = max(t - lastT, 0.0001)
        lastT = t

        let a = 1 - exp(-dt / 0.25)
        gravity[0] += a * (x - gravity[0])
        gravity[1] += a * (y - gravity[1])
        gravity[2] += a * (z - gravity[2])
        let dx = x - gravity[0], dy = y - gravity[1], dz = z - gravity[2]
        let mag = (dx * dx + dy * dy + dz * dz).squareRoot()

        if cfg.raw {
            rawPeak = max(rawPeak, mag)
            if t - rawSince >= 0.1 {
                sink.emit(["type": "raw", "peak": num(rawPeak), "noise": num(noise)], toFile: false)
                rawPeak = 0
                rawSince = t
            }
        }

        if let start = eventStart {
            eventPeak = max(eventPeak, mag)
            if t - start >= cfg.window {
                sink.emit([
                    "type": "slap",
                    "ts": nowMs(),
                    "peak": num(eventPeak),
                ])
                eventStart = nil
                lastHit = t
            }
            return
        }

        let isHit = mag > max(cfg.threshold, noise * 6) && t - lastHit > cfg.cooldown
        if isHit {
            eventStart = t
            eventPeak = mag
        } else {
            noise += (1 - exp(-dt / 2.0)) * (mag - noise)
        }
    }
}

// MARK: IOKit

func wakeSensorDrivers() {
    var it: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleSPUHIDDriver"), &it) == KERN_SUCCESS
    else { return }
    defer { IOObjectRelease(it) }

    var svc = IOIteratorNext(it)
    while svc != 0 {
        for (key, value) in [("SensorPropertyReportingState", 1), ("SensorPropertyPowerState", 1), ("ReportInterval", 1000)] {
            IORegistryEntrySetCFProperty(svc, key as CFString, NSNumber(value: Int32(value)))
        }
        IOObjectRelease(svc)
        svc = IOIteratorNext(it)
    }
}

func intProperty(_ svc: io_service_t, _ key: String) -> Int? {
    IORegistryEntryCreateCFProperty(svc, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Int
}

func openAccelerometer() -> IOHIDDevice {
    var it: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleSPUHIDDevice"), &it) == KERN_SUCCESS
    else { fail("no AppleSPUHIDDevice services") }
    defer { IOObjectRelease(it) }

    var svc = IOIteratorNext(it)
    while svc != 0 {
        let isAccel = intProperty(svc, "PrimaryUsagePage") == 0xFF00 && intProperty(svc, "PrimaryUsage") == 3
        let device = isAccel ? IOHIDDeviceCreate(kCFAllocatorDefault, svc) : nil
        IOObjectRelease(svc)
        if isAccel {
            guard let device else { fail("cannot create accelerometer device; run with sudo") }
            let result = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
            guard result == kIOReturnSuccess else {
                fail("cannot open accelerometer (IOReturn 0x\(String(UInt32(bitPattern: result), radix: 16))); run with sudo")
            }
            return device
        }
        svc = IOIteratorNext(it)
    }
    fail("no accelerometer found (needs an Apple Silicon MacBook)")
}

func int32LE(_ p: UnsafeMutablePointer<UInt8>, _ o: Int) -> Int32 {
    Int32(bitPattern: UInt32(p[o]) | UInt32(p[o + 1]) << 8 | UInt32(p[o + 2]) << 16 | UInt32(p[o + 3]) << 24)
}

// MARK: main

let cfg = parseArgs()

let sink = Sink(path: cfg.out)
let detector = Detector(cfg: cfg, sink: sink)

wakeSensorDrivers()
let device = openAccelerometer()

let reportSize = 4096
let reportBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: reportSize)

// Reports are 22 bytes: x, y, z as little-endian Int32 at offsets 6, 10, 14,
// in 1/65536 g.
IOHIDDeviceRegisterInputReportCallback(device, reportBuffer, reportSize, { _, _, _, _, _, report, length in
    guard length >= 18 else { return }
    let s = 1.0 / 65536.0
    detector.sample(
        x: Double(int32LE(report, 6)) * s,
        y: Double(int32LE(report, 10)) * s,
        z: Double(int32LE(report, 14)) * s,
        t: ProcessInfo.processInfo.systemUptime)
}, nil)
IOHIDDeviceScheduleWithRunLoop(device, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

sink.emit(["type": "start", "ts": nowMs(), "pid": Int(getpid()), "threshold": num(cfg.threshold)])
warn("listening; hit the laptop or the table (ctrl-c to stop)")
CFRunLoopRun()
