import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Slap } from '../types'

const count = atom({ plugin: 'spank', key: 'count' } as const, 0)
const last = atom({ plugin: 'spank', key: 'last' } as const, null)
// The main thread's running turn, which a hard slap stops.
const turn = atom({ plugin: 'spank', key: 'turn' } as const, null)

// Slaps this close together during a turn reach Claude as one note.
const BURST_MS = 1500
// From this level up, a slap stops Claude's running turn.
const STOP_LEVEL = 4

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

// Slaps not yet told to Claude, the timer that tells it, and whether the
// laptop is mid-sentence. Reset by register, so each load starts clean.
let burst: Slap[] = []
let burstTimer: Timer | undefined
let isSpeaking = false

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

  const turnId = await read($, turn)
  const isStopping = turnId !== null && slap.level >= STOP_LEVEL

  $.ui.status(`spank: ${n} this session, last L${slap.level} (${slap.peak.toFixed(2)}g)`)
  $.ui.toast(isStopping ? `Stopped Claude. L${slap.level}` : `${OUCH[(n - 1) % OUCH.length]} L${slap.level}`)

  if ((await $.store.get('muted')) !== true) {
    const lines = VOICE[Math.min(Math.max(slap.level, 1), 5) - 1] ?? VOICE[0]
    say($, isStopping ? 'okay, okay, stopping' : lines[n % lines.length] ?? lines[0])
  }

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

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'slaps',
      description: 'How many times you hit the laptop; mute or unmute its voice',
      argumentHint: '[mute|unmute]',
      immediate: true,
    })
    void listen($)
    return started
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

    const n = await read($, count)
    const slap = await read($, last)
    const total = Number((await $.store.get('total')) ?? 0)
    const lastText = slap ? `last one level ${slap.level}, ${slap.peak.toFixed(2)}g` : 'none yet'

    return { text: `${n} slaps this session, ${total} all time; ${lastText}.` }
  })
}
