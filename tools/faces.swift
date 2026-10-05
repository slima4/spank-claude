// Turns each face series, assets/faces/<series>/level_<1-5>.png, into terminal
// Raster cells for the spank plugin: plugin/hooks/faces.ts. Also writes each
// face at 256px to plugin/assets/faces/<series>/, the picture /slaps image
// draws, when that copy is missing; delete one to redraw it. (A clone's file
// times say nothing about which is newer, so they are not compared.) Stops
// before writing anything if the manifest's face_series setting does not
// offer every series.
//
// Each cell is a half block (two pixels stacked), so a face of R rows is 2R
// columns wide and looks square. The white sticker background is cut away by
// a flood fill from the image's edges, so the face sits on the terminal's own
// background; whites inside the face (eyes, teeth) are kept.
//
//   swift tools/faces.swift [--preview DIR]
//
// --preview writes each face as a PNG drawn on a dark background, to check by
// eye what the terminal will show.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let input = root.appendingPathComponent("assets/faces")
let output = root.appendingPathComponent("plugin/hooks/faces.ts")
let pictures = root.appendingPathComponent("plugin/assets/faces")
let pictureSide = 256
let sizes = [8, 12, 16, 20] // rows; columns are twice that
// The crop keeps this much of the content's square, centered a little low:
// the expression (eyes, mouth) over the hair and the stickers' decorations.
let cropKeep = 0.84
let cropDrop = 0.04
// After downscaling: unsharp amount and saturation gain, for a crisper face.
let sharpen = 0.7
let saturation = 1.2
let defaultColor: UInt32 = 0x0100_0000

var previewDir: URL?
var args = CommandLine.arguments.dropFirst()
while let a = args.popFirst() {
    if a == "--preview", let dir = args.popFirst() { previewDir = URL(fileURLWithPath: dir) }
}

struct Bitmap {
    let width: Int
    let height: Int
    var rgba: [UInt8]

    init(png url: URL) {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { fatalError("cannot read \(url.path)") }
        width = image.width
        height = image.height
        rgba = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(
            data: &rgba, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }

    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let i = (y * width + x) * 4
        return (Int(rgba[i]), Int(rgba[i + 1]), Int(rgba[i + 2]))
    }
}

// The background: near-white pixels reachable from the image's edges.
func backgroundMask(_ bitmap: Bitmap) -> [Bool] {
    let w = bitmap.width, h = bitmap.height
    var mask = [Bool](repeating: false, count: w * h)
    func isNearWhite(_ x: Int, _ y: Int) -> Bool {
        let (r, g, b) = bitmap.rgb(x, y)
        return min(r, g, b) >= 232
    }
    var stack: [Int] = []
    for x in 0..<w { stack.append(x); stack.append((h - 1) * w + x) }
    for y in 0..<h { stack.append(y * w); stack.append(y * w + w - 1) }
    while let i = stack.popLast() {
        if mask[i] { continue }
        let x = i % w, y = i / w
        guard isNearWhite(x, y) else { continue }
        mask[i] = true
        if x > 0 { stack.append(i - 1) }
        if x < w - 1 { stack.append(i + 1) }
        if y > 0 { stack.append(i - w) }
        if y < h - 1 { stack.append(i + w) }
    }
    return mask
}

// The smallest square around everything that is not background.
func squareCrop(_ mask: [Bool], width w: Int, height h: Int) -> (x: Int, y: Int, side: Int) {
    var minX = w, minY = h, maxX = 0, maxY = 0
    for y in 0..<h {
        for x in 0..<w where !mask[y * w + x] {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
    }
    let full = max(maxX - minX, maxY - minY) + 1
    let side = min(Int(Double(full) * cropKeep), min(w, h))
    let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2 + Int(Double(full) * cropDrop)
    let x = min(max(cx - side / 2, 0), w - side)
    let y = min(max(cy - side / 2, 0), h - side)
    return (x, y, side)
}

// One pixel per target cell half: the average of the face pixels it covers,
// or nil when mostly background.
func downsample(_ bitmap: Bitmap, _ mask: [Bool], crop: (x: Int, y: Int, side: Int), size: Int) -> [UInt32?] {
    var pixels: [UInt32?] = []
    for ty in 0..<size {
        for tx in 0..<size {
            let x0 = crop.x + tx * crop.side / size, x1 = crop.x + (tx + 1) * crop.side / size
            let y0 = crop.y + ty * crop.side / size, y1 = crop.y + (ty + 1) * crop.side / size
            var r = 0, g = 0, b = 0, face = 0, all = 0
            for y in y0..<y1 {
                for x in x0..<x1 {
                    all += 1
                    if mask[y * bitmap.width + x] { continue }
                    let (pr, pg, pb) = bitmap.rgb(x, y)
                    r += pr; g += pg; b += pb; face += 1
                }
            }
            if face * 2 < all {
                pixels.append(nil)
            } else {
                pixels.append(UInt32(r / face) << 16 | UInt32(g / face) << 8 | UInt32(b / face))
            }
        }
    }
    return pixels
}

// Unsharp mask against each pixel's face neighbours, then a saturation gain.
func enhance(_ pixels: [UInt32?], size: Int) -> [UInt32?] {
    func channels(_ p: UInt32) -> [Double] { [Double(p >> 16 & 0xFF), Double(p >> 8 & 0xFF), Double(p & 0xFF)] }
    return pixels.indices.map { i in
        guard let p = pixels[i] else { return nil }
        let x = i % size, y = i / size
        var sum = [0.0, 0.0, 0.0], n = 0.0
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            let nx = x + dx, ny = y + dy
            guard nx >= 0, ny >= 0, nx < size, ny < size, let q = pixels[ny * size + nx] else { continue }
            let c = channels(q)
            sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]]
            n += 1
        }
        var c = channels(p)
        if n > 0 { c = (0..<3).map { c[$0] + sharpen * (c[$0] - sum[$0] / n) } }
        let lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        let out = c.map { UInt32(min(max(lum + ($0 - lum) * saturation, 0), 255)) }
        return out[0] << 16 | out[1] << 8 | out[2]
    }
}

// Raster cells: [codePoint, foreground, background] per cell, row-major.
func cells(_ pixels: [UInt32?], size: Int) -> [UInt32] {
    var words: [UInt32] = []
    for row in 0..<(size / 2) {
        for col in 0..<size {
            let top = pixels[(row * 2) * size + col], bottom = pixels[(row * 2 + 1) * size + col]
            switch (top, bottom) {
            case let (t?, b?): words += [0x2580, t, b] // ▀ top over bottom
            case let (t?, nil): words += [0x2580, t, defaultColor]
            case let (nil, b?): words += [0x2584, b, defaultColor] // ▄
            case (nil, nil): words += [0x20, defaultColor, defaultColor]
            }
        }
    }
    return words
}

func base64(_ words: [UInt32]) -> String {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(words.count * 4)
    for w in words { bytes += [UInt8(w & 0xFF), UInt8(w >> 8 & 0xFF), UInt8(w >> 16 & 0xFF), UInt8(w >> 24)] }
    return Data(bytes).base64EncodedString()
}

// The face scaled to fill side x side, cut to the middle if it is not square,
// as the plugin's picture of it.
func writePicture(from source: URL, to url: URL, side: Int) {
    guard let input = CGImageSourceCreateWithURL(source as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(input, 0, nil)
    else { fatalError("cannot read \(source.path)") }
    let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .high
    let scale = Double(side) / Double(min(image.width, image.height))
    let width = Double(image.width) * scale, height = Double(image.height) * scale
    context.draw(image, in: CGRect(x: (Double(side) - width) / 2, y: (Double(side) - height) / 2, width: width, height: height))
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
}

func writePreview(_ pixels: [UInt32?], size: Int, to url: URL) {
    let scale = 8
    let side = size * scale
    var rgba = [UInt8](repeating: 0, count: side * side * 4)
    for y in 0..<side {
        for x in 0..<side {
            let p = pixels[(y / scale) * size + x / scale] ?? 0x1E1E1E
            let i = (y * side + x) * 4
            rgba[i] = UInt8(p >> 16 & 0xFF); rgba[i + 1] = UInt8(p >> 8 & 0xFF); rgba[i + 2] = UInt8(p & 0xFF); rgba[i + 3] = 255
        }
    }
    let context = CGContext(
        data: &rgba, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
}

// One folder per series, named for it; each holds level_1.png to level_5.png.
let fm = FileManager.default
let series = try fm.contentsOfDirectory(
    at: input, includingPropertiesForKeys: [.isDirectoryKey], options: .skipsHiddenFiles)
    .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true }
    .map { $0.lastPathComponent }
    .sorted()
guard !series.isEmpty else { fatalError("no face series in \(input.path)") }
for name in series where name.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) == nil {
    fatalError("series folder \(name): use lowercase letters, digits and _")
}

// The face_series setting in the manifest must offer every series.
let manifest = root.appendingPathComponent("plugin/.claude-plugin/plugin.json")
let options = (try? JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any])
    .flatMap { $0["userConfig"] as? [String: Any] }
    .flatMap { $0["face_series"] as? [String: Any] }
    .flatMap { $0["options"] as? [String] } ?? []
let unoffered = series.filter { !options.contains($0) }
guard unoffered.isEmpty else {
    fatalError("add \(unoffered.map { "\"\($0)\"" }.joined(separator: ", ")) to face_series options in \(manifest.path)")
}

var entries: [String] = []
for name in series {
    var levels: [String] = []
    for level in 1...5 {
        let source = input.appendingPathComponent("\(name)/level_\(level).png")
        guard fm.fileExists(atPath: source.path) else { fatalError("missing \(source.path)") }
        let bitmap = Bitmap(png: source)
        let mask = backgroundMask(bitmap)
        let crop = squareCrop(mask, width: bitmap.width, height: bitmap.height)
        var arts: [String] = []
        for rows in sizes {
            let pixels = enhance(downsample(bitmap, mask, crop: crop, size: rows * 2), size: rows * 2)
            arts.append("      { columns: \(rows * 2), rows: \(rows), cells: '\(base64(cells(pixels, size: rows * 2)))' },")
            if let dir = previewDir?.appendingPathComponent(name) {
                try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
                writePreview(pixels, size: rows * 2, to: dir.appendingPathComponent("level_\(level)_\(rows).png"))
            }
        }
        levels.append("    [\n" + arts.joined(separator: "\n") + "\n    ],")

        let picture = pictures.appendingPathComponent("\(name)/level_\(level).png")
        if fm.fileExists(atPath: picture.path) { continue }
        try fm.createDirectory(at: picture.deletingLastPathComponent(), withIntermediateDirectories: true)
        writePicture(from: source, to: picture, side: pictureSide)
        print("wrote \(picture.path)")
    }
    entries.append("  \(name): [\n" + levels.joined(separator: "\n") + "\n  ],")
}

let ts = """
// Generated by tools/faces.swift from assets/faces/<series>/level_<1-5>.png; do not edit.

export type FaceArt = { columns: number; rows: number; cells: string }

// The face series, one per folder in assets/faces.
export type SeriesId = \(series.map { "'\($0)'" }.joined(separator: " | "))

// Raster cells by series, then by slap level 1-5, then by size, smallest first.
export const FACES: Record<SeriesId, readonly (readonly FaceArt[])[]> = {
\(entries.joined(separator: "\n"))
}

"""
try ts.write(to: output, atomically: true, encoding: .utf8)
print("wrote \(output.path)")
