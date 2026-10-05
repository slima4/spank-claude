import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { FaceShown, Slap } from '../types'
import { FACES } from './faces'
import type { SeriesId } from './faces'
import { DEFAULT_SERIES, SERIES, VOICES, isSeries } from './series'

const count = atom({ plugin: 'spank', key: 'count' } as const, 0)
const last = atom({ plugin: 'spank', key: 'last' } as const, null)
// The main thread's running turn, which a hard slap stops.
const turn = atom({ plugin: 'spank', key: 'turn' } as const, null)
const face = atom({ plugin: 'spank', key: 'face' } as const, null)
// Whether /slaps image is drawing its test picture.
const probe = atom({ plugin: 'spank', key: 'probe' } as const, false)

// Slaps this close together during a turn reach Claude as one note, told at
// most this long after the first, so slapping on and on still gets through.
const BURST_MS = 1500
const BURST_MAX_MS = 4000
// Slaps at most this far apart, by the sensor's clock, are a combo: each
// counts one level above the one before, or its own if that is harder. A
// combo stops Claude only once it has lasted COMBO_STOP_MS, so one slap that
// bounces never does.
const COMBO_MS = 1000
const COMBO_STOP_MS = 500
// How long a slap's face stays above the prompt.
const FACE_MS = 3000
// How long a slap's toast stays.
const TOAST_MS = 4000
// How long a clip plays before a slap no harder than it may cut it off.
const VOICE_MS = 400
// The tallest face per face_size setting, in rows; 0 draws none.
const FACE_ROWS: Record<string, number> = { large: 16, medium: 12, small: 8, off: 0 }
// Room the face leaves beside it for its line.
const FACE_TEXT_COLUMNS = 24
// /slaps calibrate: how long each step listens (from the first key, and from
// the first knock), how long it waits for either, and the least typing it
// assumes. The sensor rests around 0.01g, so a calibration with no typing
// still lands well above that.
const CALIBRATE_TYPING_MS = 6000
const CALIBRATE_KNOCKING_MS = 8000
const CALIBRATE_WAIT_MS = 30000
const CALIBRATE_FLOOR = 0.025
// How long past its step's longest a calibration waits on its reader: past
// this, a reader gone quiet is given up on, so it cannot keep swallowing slaps.
const CALIBRATE_SLACK_MS = 5000
// How long /slaps image shows its test picture.
const PROBE_MS = 10000
// The levels' scale, in g: level 1 starts at the sensitivity, but never
// below LEVEL_1_G, so a lower one lets softer taps count (as level 1) without
// making a moderate slap level 4; level 5 starts at LEVEL_5_G, a firm palm,
// but at least LEVEL_SPAN times level 1, so a sensitivity near 1g still has
// five levels.
const LEVEL_1_G = 0.05
const LEVEL_5_G = 1
const LEVEL_SPAN = 4

// slapd's lines: it opened the sensor, heard a slap (when, and how hard), or
// (with --raw, every 0.1s) the loudest shake of that moment.
type Line = { type: 'start' } | { type: 'slap'; ts: number; peak: number } | { type: 'raw'; peak: number }

function parseLine(line: string): Line | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>
    if (v.type === 'start') return { type: 'start' }
    if (v.type === 'raw' && typeof v.peak === 'number') return { type: 'raw', peak: v.peak }
    if (v.type === 'slap' && typeof v.ts === 'number' && typeof v.peak === 'number') {
      return { type: 'slap', ts: v.ts, peak: v.peak }
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

// A calibration's steps: waiting for the first key, typing, waiting for the
// first knock, knocking. The prompt.edit hook notes when the first key came.
type Calibration = { step: 'waiting' | 'typing' | 'ready' | 'knocking'; typedAt?: number }

// When the slaps happened: during a turn, during a turn a hard one stopped,
// during a turn a combo stopped, or between turns (told once, as the next
// turn starts).
type Moment = 'turn' | 'stopped' | 'combo' | 'idle'

function note(slaps: readonly Slap[], moment: Moment) {
  const strongest = slaps.reduce((a, b) => (b.peak > a.peak ? b : a))
  const what = slaps.length === 1 ? 'slapped their laptop' : `slapped their laptop ${slaps.length} times`
  const reading = `strongest hit level ${strongest.level} of 5, ${strongest.peak.toFixed(2)}g`
  const when = moment === 'idle' ? 'Since your last reply the user physically' : 'The user just physically'
  const how = moment === 'stopped' ? 'It was hard enough' : 'They came fast enough'
  const ask =
    moment === 'stopped' || moment === 'combo'
      ? `${how} to stop your turn. Acknowledge the slap briefly and check with the user before redoing that work.`
      : 'Take it as nonverbal frustration with what you are doing: acknowledge it briefly, reconsider your current approach, and ask what is wrong if it is not clear.'

  return `[spank] ${when} ${what} (accelerometer; ${reading}). ${ask}`
}

// Slaps not yet told to Claude, when the first of them came, the timer that
// tells it, the combo under way (its slaps, when the first and the last hit,
// the softest level among them, and the level it is at), its end toast still
// to come (the timer, and how to show it at once), the last slap toast (when,
// and its level), the voice clip playing (its level, when it started, and how
// to stop it), the timer that hides the face, a calibration under way, and
// the status line the sensor last set (which a calibration puts back). Reset
// by register, so each load starts clean.
let burst: Slap[] = []
let burstSince = 0
let burstTimer: Timer | undefined
let combo: { count: number; since: number; at: number; weakest: number; level: number } | undefined
let comboEnd: { timer: Timer; show: () => Promise<void> } | undefined
let toast: { at: number; level: number } | undefined
let playing: { level: number; at: number; stop: AbortController } | undefined
let faceTimer: Timer | undefined
let calibration: Calibration | undefined
let sensorStatus: string | undefined
// /slaps image's picture (PNG, base64), and the band's id for blitting it.
let probePng: string | undefined
let bandRequestId: string | undefined

// The config menu's values (the manifest's userConfig). A change there reloads
// the module, so register reads them afresh.
// `levels` is where levels 2 to 5 start, in g, for the sensitivity.
type Settings = {
  threshold: number
  levels: number[]
  stopLevel: number
  faceRows: number
  volume: number
  series: SeriesId
}
let settings: Settings = {
  threshold: 0.05,
  levels: levelStarts(0.05),
  stopLevel: 4,
  faceRows: 16,
  volume: 1,
  series: DEFAULT_SERIES,
}

function readSettings(options: PluginOptions): Settings {
  const number = (key: string, fallback: number) => {
    const value = options[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  const faceSize = options.face_size
  // Within the manifest's 0.01-1g: the engine refuses options outside it.
  const threshold = number('threshold', 0.05)
  return {
    threshold,
    levels: levelStarts(threshold),
    stopLevel: number('stop_level', 4),
    faceRows: typeof faceSize === 'string' ? (FACE_ROWS[faceSize] ?? 16) : 16,
    volume: number('volume', 1),
    series: isSeries(options.face_series) ? options.face_series : DEFAULT_SERIES,
  }
}

// Where levels 2 to 5 start for a sensitivity: evenly spaced on a log scale
// between level 1 and level 5 (see LEVEL_1_G), each a fixed multiple above
// the last.
function levelStarts(threshold: number) {
  const first = Math.max(threshold, LEVEL_1_G)
  const fifth = Math.max(LEVEL_5_G, first * LEVEL_SPAN)
  return [1, 2, 3, 4].map(k => first * (fifth / first) ** (k / 4))
}

// A slap's level, 1 to 5; any slap that counts is at least level 1.
function levelOf(peak: number) {
  return 1 + settings.levels.filter(start => peak >= start).length
}

// The chosen series' voice: its clips' folder and what each level says.
function voiceOf() {
  const id = SERIES[settings.series].voice
  return { id, captions: VOICES[id].captions }
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

// The largest face of the chosen series for this level that fits the band,
// if any does.
function faceArt(level: number, maxRows: number, columns: number) {
  const arts = FACES[settings.series][Math.min(Math.max(level, 1), 5) - 1] ?? []
  return arts.findLast(art => art.rows <= Math.min(maxRows, settings.faceRows) && art.columns + FACE_TEXT_COLUMNS <= columns)
}

function showToast($: EngineInterface, at: number, level: number, text: string) {
  toast = { at, level }
  $.ui.toast(text, { timeoutMs: TOAST_MS })
}

// Takes back the combo's end toast still to come, showing it first if asked.
function settleComboEnd(isShown: boolean) {
  const end = comboEnd
  comboEnd = undefined
  end?.timer.cancel()
  if (isShown) void end?.show().catch(() => {})
}

async function showFace($: EngineInterface, shown: FaceShown) {
  faceTimer?.cancel()
  await update($, face, () => shown)
  faceTimer = $.clock.after(FACE_MS, () => void update($, face, () => null))
}

// Plays the level's clip, cutting off the one still playing: always if it is
// harder, else only once that one has played VOICE_MS, so drumming at one
// level does not stutter (a slap sooner than that stays quiet).
function voice($: EngineInterface, level: number, now: number) {
  if (settings.volume <= 0) return
  if (playing !== undefined && level <= playing.level && now - playing.at < VOICE_MS) return
  playing?.stop.abort()
  const clip = { level, at: now, stop: new AbortController() }
  playing = clip
  const asset = `assets/voices/${voiceOf().id}/level_${level}.mp3`
  $.audio
    .play({ asset }, { signal: clip.stop.signal, gain: settings.volume })
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

// The loudest typing, that at least CALIBRATE_FLOOR, and the bar a knock must
// reach: half again the floored typing.
function typingBar(typing: readonly number[]) {
  const typingMax = Math.max(0, ...typing)
  const floored = Math.max(CALIBRATE_FLOOR, typingMax)
  return { typingMax, floored, bar: floored * 1.5 }
}

// The sensitivity between typing and knocking: the geometric mean of the
// floored typing and the softest of the three strongest knocks, each of which
// must reach the bar. A knock is a moment louder than the ones beside it, so a
// knock split across two moments counts once. Also returns what it decided
// on, to log.
function pickThreshold(typing: readonly number[], knocking: readonly number[]) {
  const { typingMax, floored, bar } = typingBar(typing)
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

// An outcome told after the fact (a calibration's, a failed switch): a toast,
// and a line in the transcript, which keeps the whole text when the toast
// gets only one line.
function report($: EngineInterface, text: string) {
  $.ui.toast(text, { timeoutMs: 10000 })
  $.ui.log(`spank: ${text}`)
}

// /slaps calibrate: a slapd of its own (--raw: the loudest shake every 0.1s)
// listens to typing, then to knocks, and the sensitivity setting goes between
// them. Typing is timed from the first key in the prompt box, and knocking
// from the first moment loud enough to be a knock, so time spent reading the
// instructions counts for neither. Slaps are ignored meanwhile, and one runs
// at a time. Steps follow the clock as readings arrive, and leaving the loop
// stops that slapd.
async function calibrate($: EngineInterface) {
  // Set before any await, so a /slaps calibrate right behind this one sees it.
  const run: Calibration = { step: 'waiting' }
  calibration = run
  // reader.return() waits behind a pull still waiting for a line, so each
  // pull races the backstop instead. Each step sets it anew.
  let giveUp = () => {}
  const quiet = new Promise<'quiet'>(resolve => (giveUp = () => resolve('quiet')))
  let backstop = $.clock.after(CALIBRATE_WAIT_MS + CALIBRATE_SLACK_MS, () => giveUp())
  const rearm = (stepMs: number) => {
    backstop.cancel()
    backstop = $.clock.after(stepMs + CALIBRATE_SLACK_MS, () => giveUp())
  }
  const heard = { typing: [] as number[], knocking: [] as number[] }
  let failure: string | undefined
  try {
    // When the step began: the calibration, the first key, the end of the
    // typing, the first knock.
    let stepAt = await $.clock.now()
    let bar = 0
    $.ui.status(
      `spank: calibrating 1/2: start typing, without pressing Enter (${CALIBRATE_TYPING_MS / 1000}s from the first key)`,
    )
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
          const now = await $.clock.now()
          if (run.step === 'waiting') {
            if (run.typedAt === undefined) {
              if (now - stepAt < CALIBRATE_WAIT_MS) continue
              failure = `nothing was typed in the prompt box within ${CALIBRATE_WAIT_MS / 1000}s`
              break reading
            }
            run.step = 'typing'
            stepAt = run.typedAt
            rearm(CALIBRATE_TYPING_MS)
            $.ui.status(`spank: calibrating 1/2: keep typing (${CALIBRATE_TYPING_MS / 1000}s)`)
          }
          if (run.step === 'typing') {
            if (now - stepAt < CALIBRATE_TYPING_MS) {
              heard.typing.push(parsed.peak)
              continue
            }
            run.step = 'ready'
            stepAt = now
            bar = typingBar(heard.typing).bar
            rearm(CALIBRATE_WAIT_MS)
            $.ui.status(
              `spank: calibrating 2/2: knock on the desk 3 times (${CALIBRATE_KNOCKING_MS / 1000}s from the first knock)`,
            )
            $.ui.toast('Now knock on the desk 3 times', { timeoutMs: CALIBRATE_KNOCKING_MS })
          }
          if (run.step === 'ready') {
            // Typing on past the toast stays under the bar.
            if (parsed.peak < bar) {
              if (now - stepAt < CALIBRATE_WAIT_MS) continue
              failure = `heard no knock reaching ${inG(bar)} within ${CALIBRATE_WAIT_MS / 1000}s; knock harder`
              break reading
            }
            run.step = 'knocking'
            stepAt = now
            rearm(CALIBRATE_KNOCKING_MS)
            $.ui.status(`spank: calibrating 2/2: keep knocking (${CALIBRATE_KNOCKING_MS / 1000}s)`)
          }
          if (now - stepAt >= CALIBRATE_KNOCKING_MS) break reading
          heard.knocking.push(parsed.peak)
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
  const unsaved = await saveSetting($, 'threshold', picked.threshold, 'sensitivity').catch(error => String(error))
  if (unsaved !== undefined) {
    report($, `Could not save the sensitivity: ${unsaved}. Set "Slap sensitivity" in /config.`)
  }
}

// Writes a userConfig option as the person would in /config; the module then
// reloads with it. The row is looked up, not spelled, since its key depends
// on how the plugin was loaded. Resolves undefined once saved, or why not,
// calling the setting by its label.
async function saveSetting(
  $: EngineInterface,
  option: string,
  value: string | number,
  label: string,
): Promise<string | undefined> {
  const rows = await $.config.list()
  const row = rows.find(
    r => r.key === `${$.plugin.name}.${option}` || (r.provider.plugin === $.plugin.name && r.key.endsWith(`.${option}`)),
  )
  if (row === undefined) return `no ${label} row in /config`
  const set = await $.config.set({ key: row.key, value })
  return set.deny
}

function titled(id: string) {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

// /slaps who [series]: lists the face series, or switches to one by saving
// the face_series setting. Saving reloads the module, so the reply goes out
// first and only a failure is told afterwards; until the reload the series is
// switched here already, and switched back if saving fails. A calibration
// under way would not survive the reload, so it holds the switch off.
function who($: EngineInterface, wanted: string) {
  const ids = Object.keys(SERIES)
  if (wanted === '') return ids.map(id => (id === settings.series ? `${id} (current)` : id)).join(', ')
  if (!isSeries(wanted)) return `No face series "${wanted}". Try: ${ids.join(', ')}.`
  if (wanted === settings.series) return `${titled(wanted)} already. Slap away.`
  if (calibration !== undefined) return 'Calibrating; switch after it finishes.'

  const { series } = settings
  settings = { ...settings, series: wanted }
  void saveSetting($, 'face_series', wanted, 'face series')
    .catch(error => String(error))
    .then(unsaved => {
      if (unsaved === undefined) return
      settings = { ...settings, series }
      report($, `Could not switch to ${titled(wanted)}: ${unsaved}. Set "Face series" in /config.`)
    })
    .catch(() => {})
  return `${titled(wanted)} now. Slap away.`
}

async function onSlap($: EngineInterface, slap: Slap) {
  if (calibration !== undefined) return
  if (!(await isActive($))) return

  const now = await $.clock.now()
  const gap = combo === undefined ? undefined : slap.ts - combo.at
  const prior = gap !== undefined && gap >= 0 && gap <= COMBO_MS ? combo : undefined
  // The slap's level in its combo, which never drops until the combo ends:
  // what she shows and says, and what stops Claude. The score keeps what the
  // sensor read.
  const level = Math.min(Math.max(slap.level, (prior?.level ?? 0) + 1), 5)
  combo = {
    count: (prior?.count ?? 0) + 1,
    since: prior?.since ?? slap.ts,
    at: slap.ts,
    weakest: Math.min(prior?.weakest ?? slap.level, slap.level),
    level,
  }

  const n = await update($, count, c => c + 1)
  await update($, last, () => slap)
  await $.store.set('total', Number((await $.store.get('total')) ?? 0) + 1)

  // Telling Claude and stopping its turn are off unless /slaps claude on.
  const isClaudeOn = (await $.store.get('claude')) === true
  const turnId = await read($, turn)
  // A combo stops a turn only if none of its slaps barely registered (level
  // 1), so steady shaking, a train or heavy typing, never does, and only once
  // it has lasted COMBO_STOP_MS.
  const isHard = slap.level >= settings.stopLevel
  const isComboStop = combo.weakest >= 2 && slap.ts - combo.since >= COMBO_STOP_MS
  const isStopping = isClaudeOn && turnId !== null && level >= settings.stopLevel && (isHard || isComboStop)

  setSensorStatus($, `spank: ${n} this session, last L${slap.level} (${slap.peak.toFixed(2)}g)`)

  const { captions } = voiceOf()
  const line = captions[level - 1] ?? captions[0]
  // A combo puts up a toast as it starts (unless one as hard is showing) and
  // one when it ends, saying how far it got, not one per slap; a stop always
  // says so.
  // The end toast waits for a second with no slap; one still to come when a
  // new combo starts is the last one's, shown then.
  const inRow = combo.count
  settleComboEnd(inRow === 1)
  if (inRow > 1 && !isStopping) {
    const text = `${line} L${level}, ${inRow} in a row`
    const show = async () => {
      comboEnd = undefined
      if (calibration !== undefined || !(await isActive($))) return
      showToast($, await $.clock.now(), level, text)
    }
    comboEnd = { timer: $.clock.after(COMBO_MS, () => void show().catch(() => {})), show }
  }
  if (isStopping) {
    showToast($, now, level, `Stopped Claude. L${level}`)
  } else if (inRow === 1 && (toast === undefined || now - toast.at >= TOAST_MS || level > toast.level)) {
    showToast($, now, level, `${line} L${level}`)
  }
  if ((await $.store.get('muted')) !== true) voice($, level, now)
  await showFace($, { level, peak: slap.peak, line, combo: inRow })

  if (!isClaudeOn) return
  if (burst.length === 0) burstSince = now
  burst.push(slap)
  if (turnId === null) return // told as the next turn starts
  if (isStopping) {
    await update($, turn, () => null)
    await $.turn.abort({ turnId }).catch(() => {})
    await tellClaude($, isHard ? 'stopped' : 'combo')
    return
  }
  cancelBurstTimer()
  const wait = Math.max(0, Math.min(BURST_MS, burstSince + BURST_MAX_MS - now))
  burstTimer = $.clock.after(wait, () => void tellClaude($, 'turn'))
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
        if (parsed?.type === 'slap') await onSlap($, { ts: parsed.ts, peak: parsed.peak, level: levelOf(parsed.peak) })
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
  burstSince = 0
  cancelBurstTimer()
  combo = undefined
  settleComboEnd(false)
  toast = undefined
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
      description: 'How many times you hit the laptop; pick who gets hit, calibrate, mute, or let slaps reach Claude',
      argumentHint: '[who [series]|calibrate|mute|unmute|claude on|claude off|image]',
      immediate: true,
    })
    void listen($)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    await markActive($).catch(() => {})
    return next(e)
  })

  // A calibration times its typing from the first key in the prompt box.
  on('prompt.edit', async ($, e, next) => {
    const run = calibration
    if (run?.step === 'waiting' && run.typedAt === undefined) {
      const now = await $.clock.now()
      run.typedAt ??= now
    }
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
                level {shown.level} of 5, {shown.peak.toFixed(2)}g{shown.combo > 1 ? `, ${shown.combo} in a row` : ''}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, () => e.turnId)
    // A combo begun before the turn does not carry into it, so it cannot stop
    // the turn on its first slap.
    combo = undefined
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
    const [subcommand, ...rest] = arg.split(/\s+/)
    if (subcommand === 'who') return { text: who($, rest.join(' ').toLowerCase()) }
    if (arg === 'mute' || arg === 'unmute') {
      await $.store.set('muted', arg === 'mute')
      return { text: arg === 'mute' ? 'Laptop voice off.' : 'Laptop voice on.' }
    }
    if (arg === 'calibrate') {
      if (calibration !== undefined) return { text: 'Already calibrating; wait for its result.' }
      void calibrate($)
      return {
        text:
          `Calibrating. Start typing in the prompt box, without pressing Enter: ` +
          `${CALIBRATE_TYPING_MS / 1000} seconds from your first key. When the toast says so, knock on the desk ` +
          `3 times: ${CALIBRATE_KNOCKING_MS / 1000} seconds from your first knock.`,
      }
    }
    if (arg === 'image') {
      // Draws a real picture above the prompt, then asks the terminal to take
      // it again: a refusal says the terminal drew the alt text instead.
      const picture = `${$.plugin.root}/assets/faces/${settings.series}/level_1.png`
      const bytes = await $.fs.read(picture, { as: 'bytes' }).catch(() => undefined)
      if (bytes === undefined) return { text: `Image probe: no picture to try (${picture} is missing).` }
      const { base64 } = bytes
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
