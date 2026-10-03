import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Slap } from '../types'

const count = atom({ plugin: 'spank', key: 'count' } as const, 0)
const last = atom({ plugin: 'spank', key: 'last' } as const, null)

const OUCH = ['Ouch!', 'Hey!', 'Ow ow ow', 'Rude.', 'I felt that.', 'Easy there.', 'WHY?!']

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

async function onSlap($: EngineInterface, slap: Slap) {
  const n = await update($, count, c => c + 1)
  await update($, last, () => slap)
  await $.store.set('total', Number((await $.store.get('total')) ?? 0) + 1)

  $.ui.status(`spank: ${n} this session, last L${slap.level} (${slap.peak.toFixed(2)}g)`)
  $.ui.toast(`${OUCH[(n - 1) % OUCH.length]} L${slap.level}`)
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
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'slaps',
      description: 'How many times you hit the laptop or the table',
      immediate: true,
    })
    void listen($)
    return started
  })

  on('command.run', { command: 'slaps' }, async $ => {
    const n = await read($, count)
    const slap = await read($, last)
    const total = Number((await $.store.get('total')) ?? 0)
    const lastText = slap ? `last one level ${slap.level}, ${slap.peak.toFixed(2)}g` : 'none yet'

    return { text: `${n} slaps this session, ${total} all time; ${lastText}.` }
  })
}
