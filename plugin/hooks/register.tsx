import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { FaceShown, Slap } from '../types'
import { FACES } from './faces'

const count = atom({ plugin: 'spank', key: 'count' } as const, 0)
const last = atom({ plugin: 'spank', key: 'last' } as const, null)
// The main thread's running turn, which a hard slap stops.
const turn = atom({ plugin: 'spank', key: 'turn' } as const, null)
const face = atom({ plugin: 'spank', key: 'face' } as const, null)
// Whether /slaps image is drawing its test picture.
const probe = atom({ plugin: 'spank', key: 'probe' } as const, false)

// Slaps this close together during a turn reach Claude as one note.
const BURST_MS = 1500
// How long a slap's face stays above the prompt.
const FACE_MS = 3000
// The tallest face per face_size setting, in rows; 0 draws none.
const FACE_ROWS: Record<string, number> = { large: 16, medium: 12, small: 8, off: 0 }
// Room the face leaves beside it for its line.
const FACE_TEXT_COLUMNS = 24
// /slaps calibrate: how long each step listens, and the least typing it
// assumes. The sensor rests around 0.01g, so a calibration with no typing
// still lands well above that.
const CALIBRATE_TYPING_MS = 6000
const CALIBRATE_KNOCKING_MS = 8000
const CALIBRATE_FLOOR = 0.025
// How long a calibration waits on its reader in all: past this, a reader gone
// quiet is given up on, so it cannot keep swallowing slaps.
const CALIBRATE_STALE_MS = CALIBRATE_TYPING_MS + CALIBRATE_KNOCKING_MS + 5000
// How long /slaps image shows its test picture.
const PROBE_MS = 10000

// What each level's clip (assets/voices/level_<n>.mp3) says, shown beside
// her face and in the toast.
const CAPTIONS = ['んっ！', 'あっ！', 'いたっ！', 'きゃっ！', 'あぁっ…！'] as const

// slapd's lines: it opened the sensor, heard a slap, or (with --raw, every
// 0.1s) the loudest shake of that moment.
type Line = { type: 'start' } | ({ type: 'slap' } & Slap) | { type: 'raw'; peak: number }

function parseLine(line: string): Line | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>
    if (v.type === 'start') return { type: 'start' }
    if (v.type === 'raw' && typeof v.peak === 'number') return { type: 'raw', peak: v.peak }
    if (v.type === 'slap' && typeof v.ts === 'number' && typeof v.peak === 'number' && typeof v.level === 'number') {
      return { type: 'slap', ts: v.ts, peak: v.peak, level: v.level }
    }
  } catch {}
  return undefined
}

// Splits a stream's text into whole lines, keeping a partial last line for the
// next piece.
function lineSplitter() {
  let pending = ''
  return (text: string) => {
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    return lines
  }
}

// When the slaps happened: during a turn, during a turn they stopped, or
// between turns (told once, as the next turn starts).
type Moment = 'turn' | 'stopped' | 'idle'

function note(slaps: readonly Slap[], moment: Moment) {
  const strongest = slaps.reduce((a, b) => (b.peak > a.peak ? b : a))
  const what = slaps.length === 1 ? 'slapped their laptop' : `slapped their laptop ${slaps.length} times`
  const reading = `strongest hit level ${strongest.level} of 5, ${strongest.peak.toFixed(2)}g`
  const when = moment === 'idle' ? 'Since your last reply the user physically' : 'The user just physically'
  const ask =
    moment === 'stopped'
      ? 'It was hard enough to stop your turn. Acknowledge the slap briefly and check with the user before redoing that work.'
      : 'Take it as nonverbal frustration with what you are doing: acknowledge it briefly, reconsider your current approach, and ask what is wrong if it is not clear.'

  return `[spank] ${when} ${what} (accelerometer; ${reading}). ${ask}`
}

// Slaps not yet told to Claude, the timer that tells it, the voice clip
// playing (its level, and how to stop it), the timer that hides the face, a
// calibration under way, and the status line the sensor last set (which a
// calibration puts back). Reset by register, so each load starts clean.
let burst: Slap[] = []
let burstTimer: Timer | undefined
let playing: { level: number; stop: AbortController } | undefined
let faceTimer: Timer | undefined
let calibration: { step: 'typing' | 'knocking' } | undefined
let sensorStatus: string | undefined
// /slaps image's picture (PNG, base64), and the band's id for blitting it.
let probePng: string | undefined
let bandRequestId: string | undefined

// The config menu's values (the manifest's userConfig). A change there reloads
// the module, so register reads them afresh.
type Settings = { threshold: number; stopLevel: number; faceRows: number; volume: number }
let settings: Settings = { threshold: 0.05, stopLevel: 4, faceRows: 16, volume: 1 }

function readSettings(options: PluginOptions): Settings {
  const number = (key: string, fallback: number) => {
    const value = options[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  const faceSize = options.face_size
  return {
    threshold: number('threshold', 0.05),
    stopLevel: number('stop_level', 4),
    faceRows: typeof faceSize === 'string' ? (FACE_ROWS[faceSize] ?? 16) : 16,
    volume: number('volume', 1),
  }
}

function setSensorStatus($: EngineInterface, text: string) {
  sensorStatus = text
  $.ui.status(text)
}

// Which session reacts when several are open: the one used last. Each session
// writes itself into this file (in the per-user temp folder) when it starts,
// on every prompt and on /slaps; a slap belongs to the session it names.
async function activePath($: EngineInterface) {
  const temp = (await $.env.get('TMPDIR')) ?? `${$.plugin.root}/`
  return `${temp.endsWith('/') ? temp : `${temp}/`}spank-claude-active.json`
}

async function markActive($: EngineInterface) {
  const session = await $.session.id()
  await $.fs.write(await activePath($), JSON.stringify({ session, at: await $.clock.now() }))
}

// Unreadable or torn, the file names nobody, and every session reacts.
async function isActive($: EngineInterface) {
  try {
    const { session } = JSON.parse(await $.fs.read(await activePath($))) as { session?: unknown }
    return typeof session !== 'string' || session === (await $.session.id())
  } catch {
    return true
  }
}

// The largest face for this level that fits the band, if any does.
function faceArt(level: number, maxRows: number, columns: number) {
  const arts = FACES[Math.min(Math.max(level, 1), 5) - 1] ?? []
  return arts.findLast(art => art.rows <= Math.min(maxRows, settings.faceRows) && art.columns + FACE_TEXT_COLUMNS <= columns)
}

async function showFace($: EngineInterface, shown: FaceShown) {
  faceTimer?.cancel()
  await update($, face, () => shown)
  faceTimer = $.clock.after(FACE_MS, () => void update($, face, () => null))
}

// Plays the level's clip. A harder slap cuts off a softer clip still
// playing; one no harder than it is skipped, so a burst stays one voice.
function voice($: EngineInterface, level: number) {
  if (settings.volume <= 0) return
  if (playing !== undefined && playing.level >= level) return
  playing?.stop.abort()
  const clip = { level, stop: new AbortController() }
  playing = clip
  $.audio
    .play({ asset: `assets/voices/level_${level}.mp3` }, { signal: clip.stop.signal, gain: settings.volume })
    .catch(() => {})
    .finally(() => {
      if (playing === clip) playing = undefined
    })
}

function cancelBurstTimer() {
  burstTimer?.cancel()
  burstTimer = undefined
}

async function tellClaude($: EngineInterface, moment: Moment) {
  cancelBurstTimer()
  const slaps = burst
  burst = []
  if (slaps.length === 0) return

  const text = note(slaps, moment)
  // A refused or failed note must not end the listen loop that called it.
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (error) {
    $.ui.log(`spank: could not tell Claude "${text}": ${String(error)}`, { to: 'debug' })
  }
}

// The sensitivity between typing and knocking: the geometric mean of the
// loudest typing (at least CALIBRATE_FLOOR) and the softest of the three
// strongest knocks, each of which must reach the bar, half again that typing.
// A knock is a moment louder than the ones beside it, so a knock split across
// two moments counts once. Also returns what it decided on, to log.
function pickThreshold(typing: readonly number[], knocking: readonly number[]) {
  const typingMax = Math.max(0, ...typing)
  const floored = Math.max(CALIBRATE_FLOOR, typingMax)
  const bar = floored * 1.5
  const peaks = knocking
    .filter((peak, i) => peak > (knocking[i - 1] ?? 0) && peak >= (knocking[i + 1] ?? 0))
    .sort((a, b) => b - a)
  const clear = peaks.filter(peak => peak >= bar)
  const softest = clear[2]
  if (softest === undefined) {
    // A knock louder than typing but short of the bar, or none reaching it,
    // was too soft; otherwise the missing ones ran together or never came.
    const isSoft = clear.length === 0 || peaks.some(peak => peak > floored && peak < bar)
    const advice = isSoft ? 'knock harder' : 'knock 3 separate times, a second apart'
    return { reason: `heard ${clear.length} of 3 knocks reaching ${inG(bar)}; ${advice}`, typingMax, bar, peaks } as const
  }
  const threshold = Math.round(Math.min(1, Math.sqrt(floored * softest)) * 1000) / 1000
  return { threshold, typingMax, softest, bar, peaks }
}

function inG(value: number) {
  return `${value.toFixed(3)}g`
}

// A calibration's outcome: a toast, and a line in the transcript, which keeps
// the whole text when the toast gets only one line.
function report($: EngineInterface, text: string) {
  $.ui.toast(text, { timeoutMs: 10000 })
  $.ui.log(`spank: ${text}`)
}

// /slaps calibrate: a slapd of its own (--raw: the loudest shake every 0.1s)
// listens to typing, then to knocks, and the sensitivity setting goes between
// them. Slaps are ignored meanwhile, and one runs at a time. Steps follow the
// clock as readings arrive, and leaving the loop stops that slapd.
async function calibrate($: EngineInterface) {
  // Set before any await, so a /slaps calibrate right behind this one sees it.
  const run = { step: 'typing' as 'typing' | 'knocking' }
  calibration = run
  // reader.return() waits behind a pull still waiting for a line, so each
  // pull races the backstop instead.
  let giveUp = () => {}
  const quiet = new Promise<'quiet'>(resolve => (giveUp = () => resolve('quiet')))
  const backstop = $.clock.after(CALIBRATE_STALE_MS, () => giveUp())
  const heard = { typing: [] as number[], knocking: [] as number[] }
  let failure: string | undefined
  try {
    const startedAt = await $.clock.now()
    $.ui.status(`spank: calibrating 1/2: type anything for ${CALIBRATE_TYPING_MS / 1000}s, without pressing Enter`)
    const reader = $.process.spawn({ argv: [`${$.plugin.root}/bin/slapd`, '--raw', '--threshold', '100'] })
    const lines = lineSplitter()
    let lastError = ''
    try {
      reading: for (;;) {
        const pulled = await Promise.race([reader.next(), quiet])
        if (pulled === 'quiet') {
          failure = 'the sensor went quiet'
          break
        }
        if (pulled.done === true) {
          failure = `the sensor reader stopped (${lastError || 'slapd exited'})`
          break
        }
        const { stream, text } = pulled.value
        if (stream === 'stderr') {
          lastError = text.trim().split('\n').pop() ?? lastError
          continue
        }
        for (const line of lines(text)) {
          const parsed = parseLine(line)
          if (parsed?.type !== 'raw') continue
          const elapsed = (await $.clock.now()) - startedAt
          if (elapsed >= CALIBRATE_TYPING_MS + CALIBRATE_KNOCKING_MS) break reading
          if (elapsed >= CALIBRATE_TYPING_MS && run.step === 'typing') {
            run.step = 'knocking'
            $.ui.status(`spank: calibrating 2/2: knock on the desk 3 times (${CALIBRATE_KNOCKING_MS / 1000}s)`)
            $.ui.toast('Now knock on the desk 3 times', { timeoutMs: CALIBRATE_KNOCKING_MS })
          }
          heard[run.step].push(parsed.peak)
        }
      }
    } finally {
      // Stops slapd; a pull still waiting holds this until slapd writes.
      reader.return({ code: null, signal: null }).catch(() => {})
    }
  } catch (error) {
    failure = `the sensor could not be read (${String(error)})`
  } finally {
    backstop.cancel()
    if (calibration === run) calibration = undefined
  }

  $.ui.status(sensorStatus)
  if (failure !== undefined) {
    report($, `Calibration failed: ${failure}.`)
    return
  }
  const picked = pickThreshold(heard.typing, heard.knocking)
  const peaks = picked.peaks.slice(0, 5).map(inG).join(', ')
  $.ui.log(`spank: calibration: typing ${inG(picked.typingMax)}, bar ${inG(picked.bar)}, knock peaks [${peaks}]`, {
    to: 'debug',
  })
  if (picked.threshold === undefined) {
    report($, `Calibration failed: ${picked.reason}.`)
    return
  }
  // Told before saving: saving reloads the plugin, which may drop anything
  // this module says afterwards.
  report($, `Sensitivity set to ${picked.threshold}g (typing ${inG(picked.typingMax)}, knocks ${inG(picked.softest)}).`)
  const unsaved = await saveThreshold($, picked.threshold).catch(error => String(error))
  if (unsaved !== undefined) {
    report($, `Could not save the sensitivity: ${unsaved}. Set "Slap sensitivity" in /config.`)
  }
}

// Writes the sensitivity as the person would in /config; the module then
// reloads with it. The row is looked up, not spelled, since its key depends
// on how the plugin was loaded. Resolves undefined once saved, or why not.
async function saveThreshold($: EngineInterface, threshold: number): Promise<string | undefined> {
  const rows = await $.config.list()
  const row = rows.find(
    r => r.key === `${$.plugin.name}.threshold` || (r.provider.plugin === $.plugin.name && r.key.endsWith('.threshold')),
  )
  if (row === undefined) return 'no sensitivity row in /config'
  const set = await $.config.set({ key: row.key, value: threshold })
  return set.deny
}

async function onSlap($: EngineInterface, slap: Slap) {
  if (calibration !== undefined) return
  if (!(await isActive($))) return

  const n = await update($, count, c => c + 1)
  await update($, last, () => slap)
  await $.store.set('total', Number((await $.store.get('total')) ?? 0) + 1)

  // Telling Claude and stopping its turn are off unless /slaps claude on.
  const isClaudeOn = (await $.store.get('claude')) === true
  const turnId = await read($, turn)
  const isStopping = isClaudeOn && turnId !== null && slap.level >= settings.stopLevel

  setSensorStatus($, `spank: ${n} this session, last L${slap.level} (${slap.peak.toFixed(2)}g)`)

  const level = Math.min(Math.max(slap.level, 1), 5)
  const line = CAPTIONS[level - 1] ?? CAPTIONS[0]
  $.ui.toast(isStopping ? `Stopped Claude. L${level}` : `${line} L${level}`)
  if ((await $.store.get('muted')) !== true) voice($, level)
  await showFace($, { level, peak: slap.peak, line })

  if (!isClaudeOn) return
  burst.push(slap)
  if (turnId === null) return // told as the next turn starts
  if (isStopping) {
    await update($, turn, () => null)
    await $.turn.abort({ turnId }).catch(() => {})
    await tellClaude($, 'stopped')
    return
  }
  cancelBurstTimer()
  burstTimer = $.clock.after(BURST_MS, () => void tellClaude($, 'turn'))
}

// slapd ships as Swift source and is built on first run (and again when its
// source is newer than the build), so installing needs only Xcode's command
// line tools. Builds to a temporary name and renames, so two sessions starting
// together never run a half-written binary. Resolves an error, or undefined.
async function buildSlapd($: EngineInterface): Promise<string | undefined> {
  const source = `${$.plugin.root}/slapd/main.swift`
  const binary = `${$.plugin.root}/bin/slapd`
  if ((await $.fs.exists(binary)) && (await $.fs.stat(binary)).mtimeMs >= (await $.fs.stat(source)).mtimeMs) {
    return undefined
  }

  setSensorStatus($, 'spank: building the sensor reader (first run, about 20s)')
  const temporary = `${binary}.${await $.clock.now()}.tmp`
  await $.process.run(['/bin/mkdir', '-p', `${$.plugin.root}/bin`])
  const built = await $.process.run(['/usr/bin/swiftc', '-O', '-swift-version', '5', '-o', temporary, source], {
    timeoutMs: 300_000,
  })
  if (built.exitCode !== 0) {
    if (/xcode-select|developer path|CommandLineTools/i.test(built.stderr)) {
      return 'needs Xcode command line tools: run xcode-select --install'
    }
    return `build failed: ${built.stderr.trim().split('\n').pop() ?? `swiftc exited ${built.exitCode}`}`
  }
  const moved = await $.process.run(['/bin/mv', '-f', temporary, binary])
  return moved.exitCode === 0 ? undefined : `build failed: ${moved.stderr.trim()}`
}

// Runs slapd for the module's life: it prints one JSON line per hit, and
// leaving this loop (a reload, the session ending) kills it.
async function listen($: EngineInterface) {
  const buildError = await buildSlapd($).catch(error => `build failed: ${String(error)}`)
  if (buildError !== undefined) {
    setSensorStatus($, `spank: sensor off (${buildError})`)
    return
  }

  const slapd = $.process.spawn({ argv: [`${$.plugin.root}/bin/slapd`, '--threshold', String(settings.threshold)] })
  const lines = lineSplitter()
  let lastError = ''

  try {
    for await (const { stream, text } of slapd) {
      if (stream === 'stderr') {
        lastError = text.trim().split('\n').pop() ?? lastError
        continue
      }
      for (const line of lines(text)) {
        const parsed = parseLine(line)
        if (parsed?.type === 'start') setSensorStatus($, `spank: armed (${settings.threshold}g)`)
        if (parsed?.type === 'slap') await onSlap($, parsed)
      }
    }
  } catch (error) {
    lastError = String(error)
  }

  setSensorStatus($, `spank: sensor off (${lastError || 'slapd exited'})`)
}

export const register: Register = (on, options) => {
  settings = readSettings(options)
  burst = []
  cancelBurstTimer()
  playing?.stop.abort()
  playing = undefined
  faceTimer?.cancel()
  faceTimer = undefined
  calibration = undefined
  sensorStatus = undefined
  probePng = undefined
  bandRequestId = undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload drops the timers that would hide a face or picture left showing.
    await update($, face, () => null)
    await update($, probe, () => false)
    await markActive($).catch(() => {})
    await $.command.register({
      name: 'slaps',
      description: 'How many times you hit the laptop; calibrate, mute, or let slaps reach Claude',
      argumentHint: '[calibrate|mute|unmute|claude on|claude off|image]',
      immediate: true,
    })
    void listen($)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    await markActive($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Read before any early return, so a later change redraws the band.
    const shown = await read($, face)
    const png = (await read($, probe)) ? probePng : undefined
    if (e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const art = shown === null ? undefined : faceArt(shown.level, e.props.maxRows, e.props.bodyColumns)
    if (art === undefined && png === undefined) return next(e)

    bandRequestId = e.requestId
    const { Box, Image, Raster, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="center" gap={2}>
        {png !== undefined ? (
          <Image key="probe" source={{ png }} columns={24} rows={12} alt="[spank: this terminal drew no picture]" />
        ) : null}
        {art !== undefined && shown !== null ? (
          <Box flexDirection="row" alignItems="center" gap={2}>
            <Raster key="face" columns={art.columns} rows={art.rows} cells={art.cells} />
            <Box flexDirection="column">
              <Text bold>{shown.line}</Text>
              <Text dimColor>
                level {shown.level} of 5, {shown.peak.toFixed(2)}g
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, () => e.turnId)
    await tellClaude($, 'idle')
    return next(e)
  })

  // A burst still waiting when the turn ends is told with the next turn.
  on('turn.complete', async ($, e, next) => {
    if ((await read($, turn)) === e.turnId) {
      await update($, turn, () => null)
      cancelBurstTimer()
    }
    return next(e)
  })

  on('command.run', { command: 'slaps' }, async ($, e) => {
    await markActive($).catch(() => {})
    const arg = e.args.trim()
    if (arg === 'mute' || arg === 'unmute') {
      await $.store.set('muted', arg === 'mute')
      return { text: arg === 'mute' ? 'Laptop voice off.' : 'Laptop voice on.' }
    }
    if (arg === 'calibrate') {
      if (calibration !== undefined) return { text: 'Already calibrating; wait for its result.' }
      void calibrate($)
      return {
        text:
          `Calibrating. Type anything for ${CALIBRATE_TYPING_MS / 1000} seconds without pressing Enter; ` +
          `when the toast says so, knock on the desk 3 times (${CALIBRATE_KNOCKING_MS / 1000} seconds).`,
      }
    }
    if (arg === 'image') {
      // Draws a real picture above the prompt, then asks the terminal to take
      // it again: a refusal says the terminal drew the alt text instead.
      const { base64 } = await $.fs.read(`${$.plugin.root}/assets/faces/level_1.png`, { as: 'bytes' })
      probePng = base64
      await update($, probe, () => true)
      await $.clock.sleep(1000)
      const blitted =
        bandRequestId === undefined
          ? { deny: 'the band above the prompt was not drawn' }
          : await $.ui.blit({ requestId: bandRequestId, key: 'probe', source: { png: base64 } })
      $.clock.after(PROBE_MS, () => void update($, probe, () => false))

      return {
        text:
          blitted.deny === undefined
            ? 'Image probe: the terminal took the picture. You should see a face above the prompt for 10s.'
            : `Image probe: no picture here (${blitted.deny}).`,
      }
    }
    if (arg === 'claude on' || arg === 'claude off') {
      const isOn = arg === 'claude on'
      await $.store.set('claude', isOn)
      if (!isOn) {
        burst = []
        cancelBurstTimer()
      }
      return {
        text: isOn
          ? 'Slaps now reach Claude, and a hard one stops its turn.'
          : 'Slaps no longer reach Claude or stop its turn.',
      }
    }

    const n = await read($, count)
    const slap = await read($, last)
    const total = Number((await $.store.get('total')) ?? 0)
    const lastText = slap ? `last one level ${slap.level}, ${slap.peak.toFixed(2)}g` : 'none yet'

    return { text: `${n} slaps this session, ${total} all time; ${lastText}.` }
  })
}
