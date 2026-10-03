import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

function slapLine(level: number, peak: number) {
  return JSON.stringify({ type: 'slap', ts: 1791041867213, peak, level })
}

// The engine beneath the plugin: slapd's stdout fed line by line, and a
// record of what the plugin showed, said, stopped and told Claude. The test
// kit does not route a plugin's $.session.append to the test's hooks, so
// each append fails here and the plugin's debug line for it carries the note.
// `stored` is the plugin's store at the start; by default slaps reach Claude.
async function harness($: Engine, on: On, stored: Record<string, unknown> = { claude: true }) {
  mock.store(on, { total: 41, ...stored })
  const clock = mock.clock(on)
  const seen = {
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    spoken: [] as string[],
    aborted: [] as string[],
    notes: [] as string[],
  }

  const lines: string[] = []
  let wake = () => {}
  on('process.spawn', async function* () {
    for (;;) {
      const line = lines.shift()
      if (line !== undefined) yield { stream: 'stdout' as const, text: line + '\n' }
      else await new Promise<void>(resolve => (wake = resolve))
    }
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.speak', ($, e) => {
    seen.spoken.push(e.text)
    return { value: { via: 'system' as const } }
  })
  // The engine's own band: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.log', ($, e) => {
    const note = /could not tell Claude "(.*)":/s.exec(e.text)?.[1]
    if (note !== undefined) seen.notes.push(note)
    return { value: undefined }
  })
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return {
    clock,
    seen,
    async feed(...more: string[]) {
      lines.push(...more)
      wake()
      await clock.settle()
    },
    turnStart: (turnId: string) => $.turn.start({ text: 'refactor everything', turnId }),
    turnComplete: (turnId: string) =>
      $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' }),
    slaps: (args = '') =>
      $.command.run({
        command: 'slaps',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      }),
  }
}

// Each feed settles in about a second of real time: room for a few.
const SLOW = { timeoutMs: 15000 }

describe('spank', () => {
  test('a hit slapd reports is counted, shown and listed by /slaps', SLOW, async ($, on) => {
    const { seen, feed, slaps } = await harness($, on)

    await feed('{"type":"start","ts":1}')
    await feed('not json')
    await feed(slapLine(3, 0.4231))

    expect(seen.statuses).toContain('spank: armed')
    expect(seen.statuses).toContain('spank: 1 this session, last L3 (0.42g)')
    expect(seen.toasts).toEqual(['Ouch! L3'])
    expect((await slaps()).text).toBe('1 slaps this session, 42 all time; last one level 3, 0.42g.')
  })

  test('each slap gets a line for its level, and the sensor keeps listening', SLOW, async ($, on) => {
    const { clock, seen, feed } = await harness($, on)

    await feed(slapLine(2, 0.2))
    await clock.advance(1600)
    await feed(slapLine(3, 0.31))
    await clock.advance(1600)

    expect(seen.spoken).toEqual(['rude', 'ow ow ow'])
    expect(seen.aborted).toEqual([])
    expect(seen.statuses.at(-1)).toBe('spank: 2 this session, last L3 (0.31g)')
  })

  test('a hard slap during a turn stops it and tells Claude why', SLOW, async ($, on) => {
    const { seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(5, 1.7))

    expect(seen.aborted).toEqual(['turn-1'])
    expect(seen.spoken).toEqual(['okay, okay, stopping'])
    expect(seen.toasts).toEqual(['Stopped Claude. L5'])
    expect(seen.notes).toHaveLength(1)
    expect(seen.notes[0]).toContain('The user just physically slapped their laptop (')
    expect(seen.notes[0]).toContain('hard enough to stop your turn')
  })

  test('a hard slap with no turn running stops nothing', SLOW, async ($, on) => {
    const { clock, seen, feed } = await harness($, on)

    await feed(slapLine(5, 1.7))
    await clock.advance(1500)

    expect(seen.aborted).toEqual([])
    expect(seen.spoken).toEqual(['stop hitting me!'])
  })

  test('slaps during a turn reach Claude as one note once they stop', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(2, 0.2))
    await clock.advance(1000)
    await feed(slapLine(3, 0.31))
    await clock.advance(1000)
    expect(seen.notes).toEqual([])

    await clock.advance(600)
    expect(seen.notes).toHaveLength(1)
    expect(seen.notes[0]).toContain('The user just physically slapped their laptop 2 times')
    expect(seen.notes[0]).toContain('strongest hit level 3 of 5, 0.31g')
  })

  test('slaps between turns reach Claude as one note when the next turn starts', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart } = await harness($, on)

    await feed(slapLine(1, 0.07), slapLine(3, 0.34), slapLine(1, 0.12))
    await clock.advance(5000)
    expect(seen.notes).toEqual([])

    await turnStart('turn-1')
    expect(seen.notes).toHaveLength(1)
    expect(seen.notes[0]).toContain('Since your last reply the user physically slapped their laptop 3 times')
    expect(seen.notes[0]).toContain('strongest hit level 3 of 5, 0.34g')

    await turnStart('turn-2')
    expect(seen.notes).toHaveLength(1)
  })

  test('a burst still waiting when its turn ends goes with the next turn', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart, turnComplete } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(2, 0.2))
    await turnComplete('turn-1')
    await clock.advance(5000)
    expect(seen.notes).toEqual([])

    await turnStart('turn-2')
    expect(seen.notes).toHaveLength(1)
    expect(seen.notes[0]).toContain('Since your last reply the user physically slapped their laptop (')
  })

  test('by default slaps neither reach Claude nor stop its turn', SLOW, async ($, on) => {
    const { seen, feed, turnStart } = await harness($, on, {})

    await turnStart('turn-1')
    await feed(slapLine(5, 1.7))
    await turnStart('turn-2')

    expect(seen.aborted).toEqual([])
    expect(seen.notes).toEqual([])
    expect(seen.toasts).toEqual(['Ouch! L5'])
    expect(seen.spoken).toEqual(['stop hitting me!'])
  })

  test('/slaps claude on and off switch the Claude actions', SLOW, async ($, on) => {
    const { seen, feed, turnStart, slaps } = await harness($, on, {})

    expect((await slaps('claude on')).text).toBe('Slaps now reach Claude, and a hard one stops its turn.')
    await turnStart('turn-1')
    await feed(slapLine(5, 1.7))
    expect(seen.aborted).toEqual(['turn-1'])

    expect((await slaps('claude off')).text).toBe('Slaps no longer reach Claude or stop its turn.')
    await turnStart('turn-2')
    await feed(slapLine(5, 1.7))
    expect(seen.aborted).toEqual(['turn-1'])
    expect(seen.notes).toHaveLength(1)
  })

  test('a slap shows its level\'s face above the prompt for a moment', SLOW, async ($, on) => {
    const { clock, feed } = await harness($, on)
    const band = {
      plugin: 'spank',
      surface: 'terminal' as const,
      component: 'AbovePrompt' as const,
      props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} },
    }

    const ui = await $.ui.mount(band)
    expect(await ui.find({ key: 'face' })).toBeUndefined()

    await feed(slapLine(5, 1.63))
    const drawn = await ui.find({ key: 'face' })
    expect(drawn?.type).toBe('Raster')
    expect(drawn?.props.rows).toBe(16)
    expect(await ui.find({ text: 'stop hitting me!' })).toBeDefined()
    expect(await ui.find({ text: /level 5 of 5, 1\.63g/ })).toBeDefined()

    await clock.advance(3000)
    expect(await ui.find({ key: 'face' })).toBeUndefined()
    await ui.unmount()

    const narrow = await $.ui.mount({ ...band, props: { ...band.props, maxRows: 9 } })
    await feed(slapLine(2, 0.2))
    expect((await narrow.find({ key: 'face' }))?.props.rows).toBe(8)
    await narrow.unmount()
  })

  test('/slaps mute keeps the laptop quiet', SLOW, async ($, on) => {
    const { seen, feed, slaps } = await harness($, on)

    expect((await slaps('mute')).text).toBe('Laptop voice off.')
    await feed(slapLine(3, 0.4))
    expect(seen.spoken).toEqual([])

    expect((await slaps('unmute')).text).toBe('Laptop voice on.')
    await feed(slapLine(3, 0.4))
    expect(seen.spoken).toHaveLength(1)
  })
})
