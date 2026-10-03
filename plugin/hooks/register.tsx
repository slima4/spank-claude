import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

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
// From this level up, a slap stops Claude's running turn.
const STOP_LEVEL = 4
// How long a slap's face stays above the prompt, and how tall it may get.
const FACE_MS = 3000
const FACE_MAX_ROWS = 16
// Room the face leaves beside it for its line.
const FACE_TEXT_COLUMNS = 24
// How long /slaps image shows its test picture.
const PROBE_MS = 10000

const OUCH = ['Ouch!', 'Hey!', 'Ow ow ow', 'Rude.', 'I felt that.', 'Easy there.', 'WHY?!']

// What the laptop says out loud, by level 1-5.
const VOICE = [
  ['hey', 'ow'],
  ['ouch', 'rude'],
  ['ow ow ow', 'I felt that'],
  ['what did I do?', 'okay, okay'],
  ['aaaah!', 'stop hitting me!'],
] as const

type Line = { type: 'start' } | ({ type: 'slap' } & Slap)

function parseLine(line: string): Line | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>
    if (v.type === 'start') return { type: 'start' }
    if (v.type === 'slap' && typeof v.ts === 'number' && typeof v.peak === 'number' && typeof v.level === 'number') {
      return { type: 'slap', ts: v.ts, peak: v.peak, level: v.level }
    }
  } catch {}
  return undefined
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

// Slaps not yet told to Claude, the timer that tells it, whether the laptop
// is mid-sentence, and the timer that hides the face. Reset by register, so
// each load starts clean.
let burst: Slap[] = []
let burstTimer: Timer | undefined
let isSpeaking = false
let faceTimer: Timer | undefined
// /slaps image's picture (PNG, base64), and the band's id for blitting it.
let probePng: string | undefined
let bandRequestId: string | undefined

// The largest face for this level that fits the band, if any does.
function faceArt(level: number, maxRows: number, columns: number) {
  const arts = FACES[Math.min(Math.max(level, 1), 5) - 1] ?? []
  return arts.findLast(art => art.rows <= Math.min(maxRows, FACE_MAX_ROWS) && art.columns + FACE_TEXT_COLUMNS <= columns)
}

async function showFace($: EngineInterface, shown: FaceShown) {
  faceTimer?.cancel()
  await update($, face, () => shown)
  faceTimer = $.clock.after(FACE_MS, () => void update($, face, () => null))
}

function say($: EngineInterface, text: string) {
  if (isSpeaking) return
  isSpeaking = true
  $.audio
    .speak(text)
    .catch(() => {})
    .finally(() => {
      isSpeaking = false
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

async function onSlap($: EngineInterface, slap: Slap) {
  const n = await update($, count, c => c + 1)
  await update($, last, () => slap)
  await $.store.set('total', Number((await $.store.get('total')) ?? 0) + 1)

  // Telling Claude and stopping its turn are off unless /slaps claude on.
  const isClaudeOn = (await $.store.get('claude')) === true
  const turnId = await read($, turn)
  const isStopping = isClaudeOn && turnId !== null && slap.level >= STOP_LEVEL

  $.ui.status(`spank: ${n} this session, last L${slap.level} (${slap.peak.toFixed(2)}g)`)
  $.ui.toast(isStopping ? `Stopped Claude. L${slap.level}` : `${OUCH[(n - 1) % OUCH.length]} L${slap.level}`)

  const lines = VOICE[Math.min(Math.max(slap.level, 1), 5) - 1] ?? VOICE[0]
  const line = isStopping ? 'okay, okay, stopping' : lines[n % lines.length] ?? lines[0]
  if ((await $.store.get('muted')) !== true) say($, line)
  await showFace($, { level: slap.level, peak: slap.peak, line })

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

// Runs slapd for the module's life: it prints one JSON line per hit, and
// leaving this loop (a reload, the session ending) kills it.
async function listen($: EngineInterface) {
  const slapd = $.process.spawn({ argv: [`${$.plugin.root}/bin/slapd`] })
  let pending = ''
  let lastError = ''

  try {
    for await (const { stream, text } of slapd) {
      if (stream === 'stderr') {
        lastError = text.trim().split('\n').pop() ?? lastError
        continue
      }
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const parsed = parseLine(line)
        if (parsed?.type === 'start') $.ui.status('spank: armed')
        if (parsed?.type === 'slap') await onSlap($, parsed)
      }
    }
  } catch (error) {
    lastError = String(error)
  }

  $.ui.status(`spank: sensor off (${lastError || 'slapd exited'})`)
}

export const register: Register = on => {
  burst = []
  cancelBurstTimer()
  isSpeaking = false
  faceTimer?.cancel()
  faceTimer = undefined
  probePng = undefined
  bandRequestId = undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload drops the timers that would hide a face or picture left showing.
    await update($, face, () => null)
    await update($, probe, () => false)
    await $.command.register({
      name: 'slaps',
      description: 'How many times you hit the laptop; mute its voice; let slaps reach Claude',
      argumentHint: '[mute|unmute|claude on|claude off|image]',
      immediate: true,
    })
    void listen($)
    return started
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
    const arg = e.args.trim()
    if (arg === 'mute' || arg === 'unmute') {
      await $.store.set('muted', arg === 'mute')
      return { text: arg === 'mute' ? 'Laptop voice off.' : 'Laptop voice on.' }
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
