import type { On, PromptEditInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FACES } from '../hooks/faces'
import { SERIES, VOICES } from '../hooks/series'

// The band above the prompt, roomy enough for the largest face.
const BAND = {
  plugin: 'spank',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

const CLIP_1 = 'assets/voices/sakura/level_1.mp3'
const CLIP_2 = 'assets/voices/sakura/level_2.mp3'
const CLIP_3 = 'assets/voices/sakura/level_3.mp3'
const CLIP_4 = 'assets/voices/sakura/level_4.mp3'
const CLIP_5 = 'assets/voices/sakura/level_5.mp3'

function queue() {
  return { lines: [] as string[], wake: () => {} }
}

function raw(peak: number) {
  return JSON.stringify({ type: 'raw', peak, noise: 0.001 })
}

// When slapd heard a slap: `ts` is the sensor's clock, which times combos.
// Left out, each slap comes 2s after the one before, too late for a combo.
const T0 = 1791041867213
let lastTs = T0

// A slap slapd heard. At the default sensitivity (0.05g) the plugin makes
// 0.07g level 1, 0.2g level 2, 0.3g level 3, 0.6g level 4, 1g and up level 5.
function slapLine(peak: number, ts = lastTs + 2000) {
  lastTs = ts
  return JSON.stringify({ type: 'slap', ts, peak })
}

// The engine beneath the plugin: slapd's stdout fed line by line, and a
// record of what the plugin showed, said, stopped and told Claude. The test
// kit does not route a plugin's $.session.append to the test's hooks, so
// each append fails here and the plugin's debug line for it carries the note.
// `stored` is the plugin's store at the start; by default slaps reach Claude.
// `world` is the disk: by default slapd is built and newer than its source;
// with `rawExits`, calibration's slapd writes that to stderr and exits.
// This session is 'session-a'; the active-session file lives under TMPDIR.
type World = {
  hasBinary?: boolean
  swiftc?: { exitCode: number; stderr: string }
  hasThresholdRow?: boolean
  hasSeriesRow?: boolean
  rawExits?: string
}

async function harness($: Engine, on: On, stored: Record<string, unknown> = { claude: true }, world: World = {}) {
  lastTs = T0
  mock.store(on, { total: 41, ...stored })
  const clock = mock.clock(on)
  const seen = {
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    played: [] as string[],
    clipsCut: 0,
    aborted: [] as string[],
    notes: [] as string[],
    ran: [] as string[][],
    spawned: [] as string[][],
    gains: [] as number[],
    configured: [] as { key: string; value: unknown }[],
    logs: [] as string[],
    readersClosed: 0,
  }

  mock.env(on, { TMPDIR: '/tmp/test/' })
  on('session.id', () => ({ value: 'session-a' }))
  const files = new Map<string, string>()
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })

  let hasBinary = world.hasBinary ?? true
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/bin/slapd') ? hasBinary : true }))
  on('fs.stat', ($, e) => ({
    value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: e.path.endsWith('/bin/slapd') ? 2 : 1 },
  }))
  on('process.run', ($, e) => {
    seen.ran.push([...e.argv])
    const isSwiftc = e.argv[0] === '/usr/bin/swiftc'
    const result = isSwiftc ? (world.swiftc ?? { exitCode: 0, stderr: '' }) : { exitCode: 0, stderr: '' }
    if (e.argv[0] === '/bin/mv') hasBinary = true
    return { value: { ...result, stdout: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  // Held clips play until the test releases them.
  let holdClips = false
  const held: (() => void)[] = []

  // Two slapd streams: the session's own, and /slaps calibrate's (--raw).
  const streams = { main: queue(), raw: queue() }
  on('process.spawn', async function* ($, e) {
    seen.spawned.push([...e.argv])
    const source = e.argv.includes('--raw') ? streams.raw : streams.main
    if (source === streams.raw && world.rawExits !== undefined) {
      yield { stream: 'stderr' as const, text: world.rawExits }
      return { value: { code: 1, signal: null } }
    }
    try {
      for (;;) {
        const line = source.lines.shift()
        if (line !== undefined) yield { stream: 'stdout' as const, text: line + '\n' }
        else await new Promise<void>(resolve => (source.wake = resolve))
      }
    } finally {
      if (source === streams.raw) seen.readersClosed += 1
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
  on('audio.play', ($, e, next) => {
    if (e.clip.asset !== undefined) seen.played.push(e.clip.asset)
    seen.gains.push(e.gain ?? 1)
    if (!holdClips) return { value: undefined }
    return new Promise(resolve => {
      const done = () => resolve({ value: undefined })
      held.push(done)
      next.signal.addEventListener('abort', () => {
        seen.clipsCut += 1
        done()
      })
    })
  })
  // The engine's own band: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.log', ($, e) => {
    seen.logs.push(e.to === 'debug' ? `debug: ${e.text}` : e.text)
    const note = /could not tell Claude "(.*)":/s.exec(e.text)?.[1]
    if (note !== undefined) seen.notes.push(note)
    return { value: undefined }
  })
  // The /config rows: the engine's own, then this plugin's sensitivity and
  // face series.
  on('config.list', () => ({
    value: [
      { key: 'theme', label: 'Theme', kind: 'choice' as const, value: 'dark', provider: { plugin: 'core', tier: 'core' as const }, isLocked: false },
      ...(world.hasThresholdRow === false
        ? []
        : [{ key: 'spank.threshold', label: 'Slap sensitivity (g)', kind: 'number' as const, value: 0.05, provider: { plugin: 'spank', tier: 'user' as const }, isLocked: false }]),
      ...(world.hasSeriesRow === false
        ? []
        : [{ key: 'spank.face_series', label: 'Face series', kind: 'choice' as const, value: 'sakura', provider: { plugin: 'spank', tier: 'user' as const }, isLocked: false }]),
    ],
  }))
  on('config.set', ($, e) => {
    seen.configured.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('prompt.edit', ($, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Let the start-up work (build check, slapd) run.
  await clock.settle()

  return {
    clock,
    seen,
    async feed(...more: string[]) {
      streams.main.lines.push(...more)
      streams.main.wake()
      await clock.settle()
    },
    // What /slaps calibrate's own slapd reads.
    async feedRaw(...peaks: number[]) {
      streams.raw.lines.push(...peaks.map(raw))
      streams.raw.wake()
      await clock.settle()
    },
    // What the active-session file says, as another session would write it.
    setActive(text: string) {
      files.set('/tmp/test/spank-claude-active.json', text)
    },
    active: () => files.get('/tmp/test/spank-claude-active.json'),
    holdClips() {
      holdClips = true
    },
    releaseClips() {
      for (const release of held.splice(0)) release()
    },
    // A key typed in the prompt box. The kit raises prompt.edit, though its
    // typings leave it off the engine's $.
    typeKey: () =>
      ($.prompt as unknown as { edit: (e: PromptEditInput) => Promise<unknown> }).edit({
        origin: { kind: 'composer' },
        text: '',
        cursor: 0,
        start: 0,
        end: 0,
        inputText: 'a',
      }),
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
    await feed(slapLine(0.4231))

    expect(seen.statuses).toContain('spank: armed (0.05g)')
    expect(seen.statuses).toContain('spank: 1 this session, last L3 (0.42g)')
    expect(seen.toasts).toEqual(['いたっ！ L3'])
    expect((await slaps()).text).toBe('1 slaps this session, 42 all time; last one level 3, 0.42g.')
  })

  test('each slap plays its level\'s clip, and the sensor keeps listening', SLOW, async ($, on) => {
    const { clock, seen, feed } = await harness($, on)

    await feed(slapLine(0.2))
    await clock.advance(1600)
    await feed(slapLine(0.31))
    await clock.advance(1600)

    expect(seen.played).toEqual(['assets/voices/sakura/level_2.mp3', 'assets/voices/sakura/level_3.mp3'])
    expect(seen.aborted).toEqual([])
    expect(seen.statuses.at(-1)).toBe('spank: 2 this session, last L3 (0.31g)')
  })

  test('a hard slap during a turn stops it and tells Claude why', SLOW, async ($, on) => {
    const { seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(1.7))

    expect(seen.aborted).toEqual(['turn-1'])
    expect(seen.played).toEqual(['assets/voices/sakura/level_5.mp3'])
    expect(seen.toasts).toEqual(['Stopped Claude. L5'])
    expect(seen.notes).toHaveLength(1)
    expect(seen.notes[0]).toContain('The user just physically slapped their laptop (')
    expect(seen.notes[0]).toContain('hard enough to stop your turn')
  })

  test('a hard slap with no turn running stops nothing', SLOW, async ($, on) => {
    const { clock, seen, feed } = await harness($, on)

    await feed(slapLine(1.7))
    await clock.advance(1500)

    expect(seen.aborted).toEqual([])
    expect(seen.played).toEqual(['assets/voices/sakura/level_5.mp3'])
  })

  test('slaps during a turn reach Claude as one note once they stop', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(0.2))
    await clock.advance(1000)
    await feed(slapLine(0.31))
    await clock.advance(1000)
    expect(seen.notes).toEqual([])

    await clock.advance(600)
    expect(seen.notes).toHaveLength(1)
    expect(seen.notes[0]).toContain('The user just physically slapped their laptop 2 times')
    expect(seen.notes[0]).toContain('strongest hit level 3 of 5, 0.31g')
  })

  test('slaps between turns reach Claude as one note when the next turn starts', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart } = await harness($, on)

    await feed(slapLine(0.07), slapLine(0.34), slapLine(0.09))
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
    await feed(slapLine(0.2))
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
    await feed(slapLine(1.7))
    await turnStart('turn-2')

    expect(seen.aborted).toEqual([])
    expect(seen.notes).toEqual([])
    expect(seen.toasts).toEqual(['あぁっ…！ L5'])
    expect(seen.played).toEqual(['assets/voices/sakura/level_5.mp3'])
  })

  test('/slaps claude on and off switch the Claude actions', SLOW, async ($, on) => {
    const { seen, feed, turnStart, slaps } = await harness($, on, {})

    expect((await slaps('claude on')).text).toBe('Slaps now reach Claude, and a hard one stops its turn.')
    await turnStart('turn-1')
    await feed(slapLine(1.7))
    expect(seen.aborted).toEqual(['turn-1'])

    expect((await slaps('claude off')).text).toBe('Slaps no longer reach Claude or stop its turn.')
    await turnStart('turn-2')
    await feed(slapLine(1.7))
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

    await feed(slapLine(1.63))
    const drawn = await ui.find({ key: 'face' })
    expect(drawn?.type).toBe('Raster')
    expect(drawn?.props.rows).toBe(24)
    expect(await ui.find({ text: 'あぁっ…！' })).toBeDefined()
    expect(await ui.find({ text: /level 5 of 5, 1\.63g/ })).toBeDefined()

    await clock.advance(3000)
    expect(await ui.find({ key: 'face' })).toBeUndefined()
    await ui.unmount()

    const narrow = await $.ui.mount({ ...band, props: { ...band.props, maxRows: 9 } })
    await feed(slapLine(0.2))
    expect((await narrow.find({ key: 'face' }))?.props.rows).toBe(8)
    await narrow.unmount()
  })

  test('each slap cuts off the clip still playing with its own', SLOW, async ($, on) => {
    const { clock, seen, feed, holdClips, releaseClips } = await harness($, on)

    holdClips()
    await feed(slapLine(0.6, T0))
    await clock.advance(1100)
    await feed(slapLine(0.07, T0 + 1100))
    await clock.advance(1100)
    await feed(slapLine(0.08, T0 + 2200))
    expect(seen.clipsCut).toBe(2)
    releaseClips()

    expect(seen.played).toEqual([CLIP_4, CLIP_1, CLIP_1])
  })

  test('drumming at one level lets each clip play 0.4s; a harder slap cuts in at once', SLOW, async ($, on) => {
    const { clock, seen, feed, holdClips } = await harness($, on, {})

    holdClips()
    await feed(slapLine(0.07, T0))
    await clock.advance(150)
    await feed(slapLine(0.07, T0 + 150))
    expect(seen.played).toEqual([CLIP_1, CLIP_2])

    // Level 5 from here on: a clip as hard as the one playing waits its turn.
    await feed(slapLine(1.2, T0 + 300))
    await clock.advance(150)
    await feed(slapLine(1.2, T0 + 450))
    await clock.advance(150)
    await feed(slapLine(1.2, T0 + 600))
    expect(seen.played).toEqual([CLIP_1, CLIP_2, CLIP_5])
    await clock.advance(100)
    await feed(slapLine(1.2, T0 + 700))
    expect(seen.played).toEqual([CLIP_1, CLIP_2, CLIP_5, CLIP_5])
    expect(seen.clipsCut).toBe(3)
  })

  test('each slap in a row counts one level above the one before', SLOW, async ($, on) => {
    const { clock, seen, feed } = await harness($, on)
    const ui = await $.ui.mount(BAND)

    for (let i = 0; i < 7; i++) {
      await feed(slapLine(0.07, T0 + i * 600))
      await clock.advance(600)
    }
    expect(seen.played).toEqual([CLIP_1, CLIP_2, CLIP_3, CLIP_4, CLIP_5, CLIP_5, CLIP_5])
    expect(await ui.find({ text: 'あぁっ…！' })).toBeDefined()
    expect(await ui.find({ text: /level 5 of 5, 0\.07g, 7 in a row/ })).toBeDefined()
    // The score keeps what the sensor read.
    expect(seen.statuses.at(-1)).toBe('spank: 7 this session, last L1 (0.07g)')

    // More than a second's pause ends it.
    await feed(slapLine(0.07, T0 + 6 * 600 + 1100))
    expect(seen.played.at(-1)).toBe(CLIP_1)
    expect(await ui.find({ text: /level 1 of 5, 0\.07g$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a harder slap lifts a combo to its own level, and a softer one never drops it', SLOW, async ($, on) => {
    const { seen, feed } = await harness($, on, {})

    await feed(slapLine(0.07, T0), slapLine(0.6, T0 + 500), slapLine(0.07, T0 + 1000))
    expect(seen.played).toEqual([CLIP_1, CLIP_4, CLIP_5])
  })

  test('a combo is timed by the sensor, not by when its lines arrive', SLOW, async ($, on) => {
    const { seen, feed } = await harness($, on, {})

    // Read together, heard 1.2s apart: no combo.
    await feed(slapLine(0.2, T0), slapLine(0.2, T0 + 1200), slapLine(0.2, T0 + 2400))
    expect(seen.played).toEqual([CLIP_2, CLIP_2, CLIP_2])
  })

  test('a combo never goes past level 5', SLOW, async ($, on) => {
    const { seen, feed } = await harness($, on, {})

    await feed(slapLine(1.4, T0), slapLine(1.4, T0 + 500), slapLine(1.4, T0 + 1000))
    expect(seen.played).toEqual([CLIP_5, CLIP_5, CLIP_5])
  })

  test('a combo reaching the stop level stops Claude', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(0.2, T0))
    await clock.advance(500)
    await feed(slapLine(0.2, T0 + 500))
    await clock.advance(500)
    expect(seen.aborted).toEqual([])

    await feed(slapLine(0.2, T0 + 1000))
    expect(seen.aborted).toEqual(['turn-1'])
    expect(seen.toasts.at(-1)).toBe('Stopped Claude. L4')
    expect(seen.notes).toHaveLength(1)
    expect(seen.notes[0]).toContain('slapped their laptop 3 times (accelerometer; strongest hit level 2 of 5, 0.20g)')
    expect(seen.notes[0]).toContain('They came fast enough to stop your turn')
  })

  test('a combo stops Claude only once it has lasted half a second', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart } = await harness($, on)

    // One slap bouncing: level 4 within 0.3s, but no stop.
    await turnStart('turn-1')
    for (const ms of [0, 150, 300]) {
      await clock.advance(ms === 0 ? 0 : 150)
      await feed(slapLine(0.2, T0 + ms))
    }
    expect(seen.played.at(-1)).toBe(CLIP_4)
    expect(seen.aborted).toEqual([])

    await clock.advance(200)
    await feed(slapLine(0.2, T0 + 500))
    expect(seen.aborted).toEqual(['turn-1'])
  })

  test('a combo\'s end toast comes at once when the next combo starts, and never mid-calibration', SLOW, async ($, on) => {
    const { clock, seen, feed, slaps } = await harness($, on, {})

    await feed(slapLine(0.2, T0), slapLine(0.2, T0 + 500))
    // Read late: 2s by the sensor, but a moment by the clock.
    await clock.advance(300)
    await feed(slapLine(0.6, T0 + 2500))
    expect(seen.toasts).toContain('いたっ！ L3, 2 in a row')

    await feed(slapLine(0.6, T0 + 3000))
    await slaps('calibrate')
    await clock.advance(1000)
    expect(seen.toasts.filter(t => t.endsWith('in a row'))).toEqual(['いたっ！ L3, 2 in a row'])
  })

  test('a combo with a level 1 graze in it never stops Claude', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    // Steady shaking: level 1 after level 1, up to a level 4 combo.
    for (let i = 0; i < 9; i++) {
      await feed(slapLine(0.07, T0 + i * 450))
      await clock.advance(450)
    }
    await feed(slapLine(0.2, T0 + 9 * 450))
    expect(seen.played.at(-1)).toBe('assets/voices/sakura/level_5.mp3')
    expect(seen.aborted).toEqual([])

    // A hard slap still does.
    await feed(slapLine(0.6, T0 + 10 * 450))
    expect(seen.aborted).toEqual(['turn-1'])
    expect(seen.notes.at(-1)).toContain('It was hard enough to stop your turn')
  })

  test('a combo begun before a turn does not carry into it', SLOW, async ($, on) => {
    const { seen, feed, turnStart } = await harness($, on)

    await feed(...[0, 1, 2, 3, 4].map(i => slapLine(0.2, T0 + i * 500)))
    await turnStart('turn-1')
    await feed(slapLine(0.2, T0 + 5 * 500))

    expect(seen.played.at(-1)).toBe(CLIP_2)
    expect(seen.aborted).toEqual([])
  })

  test('a combo puts up a toast as it starts and one as it ends, not one per slap', SLOW, async ($, on) => {
    const { clock, seen, feed } = await harness($, on, {})

    await feed(slapLine(0.3, T0))
    await clock.advance(500)
    await feed(slapLine(0.07, T0 + 500))
    await clock.advance(500)
    await feed(slapLine(0.07, T0 + 1000))
    expect(seen.played).toEqual([CLIP_3, CLIP_4, CLIP_5])
    expect(seen.toasts).toEqual(['いたっ！ L3'])

    await clock.advance(999)
    expect(seen.toasts).toHaveLength(1)
    await clock.advance(1)
    expect(seen.toasts).toEqual(['いたっ！ L3', 'あぁっ…！ L5, 3 in a row'])

    // A lone slap adds none while a harder one shows, and one once it's gone.
    await clock.advance(1000)
    await feed(slapLine(0.2, T0 + 3000))
    expect(seen.toasts).toHaveLength(2)
    await clock.advance(4000)
    await feed(slapLine(0.2, T0 + 7000))
    expect(seen.toasts).toEqual(['いたっ！ L3', 'あぁっ…！ L5, 3 in a row', 'あっ！ L2'])
  })

  test('slaps that keep coming reach Claude 4s after the first', SLOW, async ($, on) => {
    const { clock, seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(0.07, T0))
    for (let i = 1; i < 4; i++) {
      await clock.advance(1200)
      await feed(slapLine(0.07, T0 + i * 1200))
    }
    // The last slap came at 3.6s: its quiet 1.5s would end at 5.1s.
    await clock.advance(300)
    expect(seen.notes).toEqual([])
    await clock.advance(100)
    expect(seen.notes).toHaveLength(1)
    expect(seen.notes[0]).toContain('The user just physically slapped their laptop 4 times')

    // The next slap starts a burst of its own.
    await feed(slapLine(0.2, T0 + 4800))
    await clock.advance(1500)
    expect(seen.notes).toHaveLength(2)
    expect(seen.notes[1]).toContain('The user just physically slapped their laptop (')
  })

  test('the first run builds slapd from source, then starts it', SLOW, async ($, on) => {
    const { seen } = await harness($, on, {}, { hasBinary: false })

    expect(seen.ran.map(argv => argv[0])).toEqual(['/bin/mkdir', '/usr/bin/swiftc', '/bin/mv'])
    expect(seen.ran[1]).toContain('-O')
    expect(seen.ran[1]?.at(-1)).toMatch(/\/slapd\/main\.swift$/)
    expect(seen.statuses[0]).toMatch(/building the sensor reader/)
    expect(seen.spawned).toHaveLength(1)
  })

  test('a built slapd starts with no build', SLOW, async ($, on) => {
    const { seen } = await harness($, on)

    expect(seen.ran).toEqual([])
    expect(seen.spawned).toHaveLength(1)
  })

  test('with no Xcode tools the sensor stays off and says how to fix it', SLOW, async ($, on) => {
    const stderr = 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun'
    const { seen } = await harness($, on, {}, { hasBinary: false, swiftc: { exitCode: 1, stderr } })

    expect(seen.statuses.at(-1)).toBe('spank: sensor off (needs Xcode command line tools: run xcode-select --install)')
    expect(seen.spawned).toEqual([])
  })

  test('settings: sensitivity reaches slapd', { ...SLOW, options: { threshold: 0.12 } }, async ($, on) => {
    const { seen } = await harness($, on)
    expect(seen.spawned[0]?.slice(1)).toEqual(['--threshold', '0.12'])
  })

  test('settings: levels start at the sensitivity and reach 5 at 1g', { ...SLOW, options: { threshold: 0.152 } }, async ($, on) => {
    const { seen, feed } = await harness($, on, {})

    // Levels from 0.152g, 0.243g, 0.390g, 0.624g and 1g; 2s apart, no combo.
    const peaks = [0.16, 0.25, 0.4, 0.63, 1, 0.24]
    for (const [i, peak] of peaks.entries()) await feed(slapLine(peak, T0 + i * 2000))

    expect(seen.played).toEqual([CLIP_1, CLIP_2, CLIP_3, CLIP_4, CLIP_5, CLIP_1])
    expect(seen.statuses.at(-1)).toBe('spank: 6 this session, last L1 (0.24g)')
  })

  test('settings: at the default sensitivity levels 2 to 5 start at 0.106, 0.224, 0.473 and 1g', SLOW, async ($, on) => {
    const { seen, feed } = await harness($, on, {})

    const peaks = [0.05, 0.105, 0.107, 0.223, 0.225, 0.472, 0.474, 0.99, 1]
    for (const [i, peak] of peaks.entries()) await feed(slapLine(peak, T0 + i * 2000))

    expect(seen.played).toEqual([CLIP_1, CLIP_1, CLIP_2, CLIP_2, CLIP_3, CLIP_3, CLIP_4, CLIP_4, CLIP_5])
  })

  test('settings: below 0.05g the levels stay as at 0.05g', { ...SLOW, options: { threshold: 0.01 } }, async ($, on) => {
    const { seen, feed } = await harness($, on, {})

    const peaks = [0.02, 0.2, 0.3, 0.6]
    for (const [i, peak] of peaks.entries()) await feed(slapLine(peak, T0 + i * 2000))

    expect(seen.played).toEqual([CLIP_1, CLIP_2, CLIP_3, CLIP_4])
  })

  test('settings: at 1g level 5 starts at 4g, so there are still five levels', { ...SLOW, options: { threshold: 1 } }, async ($, on) => {
    const { seen, feed } = await harness($, on, {})

    // Levels from 1g, 1.414g, 2g, 2.828g and 4g.
    const peaks = [1, 1.5, 2.1, 3, 4]
    for (const [i, peak] of peaks.entries()) await feed(slapLine(peak, T0 + i * 2000))

    expect(seen.played).toEqual([CLIP_1, CLIP_2, CLIP_3, CLIP_4, CLIP_5])
  })

  test('settings: by default slapd gets the manifest default', SLOW, async ($, on) => {
    const { seen } = await harness($, on)
    expect(seen.spawned[0]?.slice(1)).toEqual(['--threshold', '0.05'])
  })

  test('settings: a higher stop level lets a level 4 slap through', { ...SLOW, options: { stop_level: 5 } }, async ($, on) => {
    const { seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(0.6))
    expect(seen.aborted).toEqual([])
    await feed(slapLine(1.2))
    expect(seen.aborted).toEqual(['turn-1'])
  })

  test('settings: volume scales the clip', { ...SLOW, options: { volume: 2.5 } }, async ($, on) => {
    const { seen, feed } = await harness($, on)
    await feed(slapLine(0.3))
    expect(seen.gains).toEqual([2.5])
  })

  test('settings: volume 0 plays nothing', { ...SLOW, options: { volume: 0 } }, async ($, on) => {
    const { seen, feed } = await harness($, on)
    await feed(slapLine(0.3))
    expect(seen.played).toEqual([])
  })

  test('settings: faces are large by default', SLOW, async ($, on) => {
    const { feed } = await harness($, on)
    const ui = await $.ui.mount(BAND)
    await feed(slapLine(0.3))
    expect((await ui.find({ key: 'face' }))?.props.rows).toBe(24)
    await ui.unmount()
  })

  for (const [size, rows] of [['small', 12], ['medium', 16], ['off', undefined]] as const) {
    test(`settings: face size ${size}`, { ...SLOW, options: { face_size: size } }, async ($, on) => {
      const { feed } = await harness($, on)
      const ui = await $.ui.mount(BAND)
      await feed(slapLine(0.3))
      expect((await ui.find({ key: 'face' }))?.props.rows).toBe(rows)
      await ui.unmount()
    })
  }

  // `make faces` refuses a series the face_series setting does not offer.
  test('every face series has five levels of faces and a voice', () => {
    expect(Object.keys(SERIES).sort()).toEqual(Object.keys(FACES).sort())
    for (const [id, levels] of Object.entries(FACES)) {
      expect(levels).toHaveLength(5)
      expect(VOICES[SERIES[id as keyof typeof SERIES].voice]?.captions).toHaveLength(5)
    }
  })

  test('settings: face series natsu shows her faces and plays her voice', { ...SLOW, options: { face_series: 'natsu' } }, async ($, on) => {
    const { seen, feed } = await harness($, on)
    const ui = await $.ui.mount(BAND)
    await feed(slapLine(0.3))
    expect(seen.played).toEqual(['assets/voices/natsu/level_3.mp3'])
    expect(seen.toasts).toEqual(['いてっ！ L3'])
    expect((await ui.find({ key: 'face' }))?.props.cells).toBe(FACES.natsu[2]?.at(-1)?.cells)
    expect(await ui.find({ text: 'いてっ！' })).toBeDefined()
    await ui.unmount()
  })

  test('settings: face series aki shows her faces and plays her voice', { ...SLOW, options: { face_series: 'aki' } }, async ($, on) => {
    const { seen, feed } = await harness($, on)
    const ui = await $.ui.mount(BAND)
    await feed(slapLine(0.3))
    expect(seen.played).toEqual(['assets/voices/aki/level_3.mp3'])
    expect(seen.toasts).toEqual(['いたぁ！ L3'])
    expect((await ui.find({ key: 'face' }))?.props.cells).toBe(FACES.aki[2]?.at(-1)?.cells)
    expect(await ui.find({ text: 'いたぁ！' })).toBeDefined()
    await ui.unmount()
  })

  test('settings: an unknown face series falls back to the default', { ...SLOW, options: { face_series: 'nobody' } }, async ($, on) => {
    const { seen, feed } = await harness($, on)
    const ui = await $.ui.mount(BAND)
    await feed(slapLine(0.3))
    expect(seen.played).toEqual(['assets/voices/sakura/level_3.mp3'])
    expect(seen.toasts).toEqual(['いたっ！ L3'])
    expect((await ui.find({ key: 'face' }))?.type).toBe('Raster')
    await ui.unmount()
  })

  test('/slaps image with no picture for the series says so', SLOW, async ($, on) => {
    const { slaps } = await harness($, on)
    expect((await slaps('image')).text).toMatch(/^Image probe: no picture to try \(.*\/assets\/faces\/sakura\/level_1\.png is missing\)\.$/)
  })

  test('/slaps who lists the face series and marks the current one', SLOW, async ($, on) => {
    const { slaps } = await harness($, on)
    expect((await slaps('who')).text).toBe('sakura (current), natsu, aki')
  })

  test('/slaps who natsu switches the face series', SLOW, async ($, on) => {
    const { clock, seen, feed, slaps } = await harness($, on)
    expect((await slaps('who \t Natsu')).text).toBe('Natsu now. Slap away.')
    await clock.settle()
    expect(seen.configured).toEqual([{ key: 'spank.face_series', value: 'natsu' }])

    // Switched already, before the reload that saving brings.
    expect((await slaps('who')).text).toBe('sakura, natsu (current), aki')
    expect((await slaps('who natsu')).text).toBe('Natsu already. Slap away.')
    await feed(slapLine(0.3))
    expect(seen.played).toEqual(['assets/voices/natsu/level_3.mp3'])
    expect(seen.configured).toHaveLength(1)
  })

  test('/slaps who waits for a calibration to finish', SLOW, async ($, on) => {
    const { clock, seen, slaps } = await harness($, on)
    await slaps('calibrate')
    expect((await slaps('who natsu')).text).toBe('Calibrating; switch after it finishes.')
    await clock.settle()
    expect(seen.configured).toEqual([])
  })

  test('/slaps who turns away an unknown name and the current one', SLOW, async ($, on) => {
    const { clock, seen, slaps } = await harness($, on)
    expect((await slaps('who hana')).text).toBe('No face series "hana". Try: sakura, natsu, aki.')
    expect((await slaps('who sakura')).text).toBe('Sakura already. Slap away.')
    await clock.settle()
    expect(seen.configured).toEqual([])
  })

  test('/slaps who says so when it cannot save the face series', SLOW, async ($, on) => {
    const { clock, seen, slaps } = await harness($, on, { claude: true }, { hasSeriesRow: false })
    await slaps('who natsu')
    await clock.settle()
    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Could not switch to Natsu: no face series row in /config. Set "Face series" in /config.')
    expect((await slaps('who')).text).toBe('sakura (current), natsu, aki')
  })

  test('only the session used last reacts to a slap', SLOW, async ($, on) => {
    const { seen, feed, slaps, setActive, active } = await harness($, on)
    expect(JSON.parse(active() ?? '{}').session).toBe('session-a')

    setActive(JSON.stringify({ session: 'session-b', at: 1 }))
    await feed(slapLine(0.3))
    expect(seen.toasts).toEqual([])
    expect(seen.played).toEqual([])

    await slaps()
    expect(JSON.parse(active() ?? '{}').session).toBe('session-a')
    await feed(slapLine(0.3))
    expect(seen.toasts).toEqual(['いたっ！ L3'])
  })

  test('with the active-session file unreadable, every session reacts', SLOW, async ($, on) => {
    const { seen, feed, setActive } = await harness($, on)

    setActive('{"session": "sess')
    await feed(slapLine(0.3))
    expect(seen.toasts).toEqual(['いたっ！ L3'])
  })

  test('/slaps calibrate sets the sensitivity between typing and knocks', SLOW, async ($, on) => {
    const { clock, seen, feed, feedRaw, slaps, typeKey } = await harness($, on)
    await feed('{"type":"start","ts":1}')

    expect((await slaps('calibrate')).text).toMatch(
      /^Calibrating\. Start typing in the prompt box, without pressing Enter: 6 seconds from your first key\./,
    )
    await typeKey()
    await feedRaw(0.01, 0.03, 0.02, 0.025)
    expect(seen.spawned.at(-1)?.slice(1)).toEqual(['--raw', '--threshold', '100'])
    await clock.advance(6000)

    // Three knocks, the second split across two moments; a slap on the
    // session's own stream meanwhile is ignored.
    await feedRaw(0.003, 0.3, 0.004, 0.12, 0.2, 0.003)
    expect(seen.statuses).toContain('spank: calibrating 2/2: knock on the desk 3 times (8s from the first knock)')
    expect(seen.statuses.at(-1)).toBe('spank: calibrating 2/2: keep knocking (8s)')
    await feed(slapLine(0.3))
    await feedRaw(0.25, 0.002)
    await clock.advance(8000)
    await feedRaw(0.002) // the first reading after the end finishes it

    // sqrt(0.03 * 0.2) = 0.077
    expect(seen.configured).toEqual([{ key: 'spank.threshold', value: 0.077 }])
    expect(seen.toasts.at(-1)).toMatch(/^Sensitivity set to 0\.077g \(typing 0\.030g, knocks 0\.200g\)/)
    expect(seen.played).toEqual([])
    expect(seen.readersClosed).toBe(1)
    expect(seen.statuses.at(-1)).toBe('spank: armed (0.05g)')
  })

  test('/slaps calibrate says so when it cannot save the sensitivity', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps, typeKey } = await harness($, on, { claude: true }, { hasThresholdRow: false })

    await slaps('calibrate')
    await typeKey()
    await feedRaw(0.03)
    await clock.advance(6000)
    await feedRaw(0.3, 0.002, 0.2, 0.002, 0.25, 0.002)
    await clock.advance(8000)
    await feedRaw(0.002)

    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toMatch(/^Could not save the sensitivity: no sensitivity row in \/config/)
  })

  test('/slaps calibrate gives up on fewer than 3 clear knocks', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps, typeKey } = await harness($, on)

    await slaps('calibrate')
    await typeKey()
    await feedRaw(0.03)
    await clock.advance(6000)
    await feedRaw(0.3, 0.002, 0.2, 0.002)
    await clock.advance(8000)
    await feedRaw(0.002)

    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toBe(
      'Calibration failed: heard 2 of 3 knocks reaching 0.045g; knock 3 separate times, a second apart.',
    )
  })

  test('/slaps calibrate gives up when no knock is louder than typing by half', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps, typeKey } = await harness($, on)

    await slaps('calibrate')
    await typeKey()
    await feedRaw(0.03, 0.04)
    await clock.advance(6000)
    await feedRaw(0.05, 0.002, 0.045, 0.002, 0.048)
    await clock.advance(29000)
    await feedRaw(0.002)
    expect(seen.toasts.at(-1)).toBe('Now knock on the desk 3 times')

    await clock.advance(1000)
    await feedRaw(0.002)
    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Calibration failed: heard no knock reaching 0.060g within 30s; knock harder.')
  })

  test('/slaps calibrate with two clear knocks and a soft one says to knock harder', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps, typeKey } = await harness($, on)

    await slaps('calibrate')
    await typeKey()
    await feedRaw(0.03, 0.04)
    await clock.advance(6000)
    await feedRaw(0.3, 0.002, 0.2, 0.002, 0.045, 0.002)
    await clock.advance(8000)
    await feedRaw(0.002)

    const failed = 'Calibration failed: heard 2 of 3 knocks reaching 0.060g; knock harder.'
    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toBe(failed)
    // The whole text in the transcript, and what it decided on in the debug log.
    expect(seen.logs).toContain(`spank: ${failed}`)
    expect(seen.logs).toContain('debug: spank: calibration: typing 0.040g, bar 0.060g, knock peaks [0.300g, 0.200g, 0.045g]')
  })

  test('/slaps calibrate with no typing cannot set a sensitivity near the sensor\'s rest', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps, typeKey } = await harness($, on)

    await slaps('calibrate')
    await typeKey()
    await feedRaw(0.01, 0.012)
    await clock.advance(6000)
    // Soft taps around 0.02g: louder than the rest, but under the typing floor.
    await feedRaw(0.02, 0.003, 0.021, 0.003, 0.02, 0.003)
    await clock.advance(30000)
    await feedRaw(0.002)

    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toMatch(/^Calibration failed: heard no knock reaching 0\.03\dg within 30s/)
  })

  test('/slaps calibrate times the typing from the first key and the knocking from the first knock', { timeoutMs: 30000 }, async ($, on) => {
    const { clock, seen, feedRaw, slaps, typeKey } = await harness($, on)

    await slaps('calibrate')
    await clock.settle()
    expect(seen.statuses.at(-1)).toBe('spank: calibrating 1/2: start typing, without pressing Enter (6s from the first key)')
    // Reading the instructions: a bump, a long pause, and no step moves on.
    await feedRaw(0.5)
    await clock.advance(20000)
    await feedRaw(0.01)
    expect(seen.statuses.at(-1)).toMatch(/start typing/)

    // The key still lands in the box.
    expect(await typeKey()).toEqual({ text: 'a', cursor: 1 })
    await feedRaw(0.03)
    expect(seen.statuses.at(-1)).toBe('spank: calibrating 1/2: keep typing (6s)')
    await clock.advance(5000)
    await feedRaw(0.04)
    expect(seen.statuses.at(-1)).toBe('spank: calibrating 1/2: keep typing (6s)')
    await clock.advance(1000)
    await feedRaw(0.01)
    expect(seen.toasts.at(-1)).toBe('Now knock on the desk 3 times')

    // Typing on past the toast, under the bar (0.060g), then a long pause.
    await feedRaw(0.05, 0.002)
    await clock.advance(20000)
    await feedRaw(0.002)
    expect(seen.statuses.at(-1)).toBe('spank: calibrating 2/2: knock on the desk 3 times (8s from the first knock)')

    await feedRaw(0.3, 0.002, 0.2, 0.002)
    expect(seen.statuses.at(-1)).toBe('spank: calibrating 2/2: keep knocking (8s)')
    await clock.advance(7000)
    await feedRaw(0.25, 0.002)
    await clock.advance(1000)
    await feedRaw(0.002)

    // The bump before typing is not typing: sqrt(0.04 * 0.2) = 0.089
    expect(seen.configured).toEqual([{ key: 'spank.threshold', value: 0.089 }])
  })

  test('/slaps calibrate gives up when nothing is typed', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps } = await harness($, on)

    await slaps('calibrate')
    await feedRaw(0.03)
    await clock.advance(30000)
    await feedRaw(0.03)

    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Calibration failed: nothing was typed in the prompt box within 30s.')
    expect(seen.readersClosed).toBe(1)
  })

  test('a calibration that hears nothing gives up and stops swallowing slaps', SLOW, async ($, on) => {
    const { clock, seen, feed, feedRaw, slaps } = await harness($, on)

    await slaps('calibrate')
    await feed(slapLine(0.3))
    expect(seen.toasts.filter(t => t.endsWith('L3'))).toEqual([])

    // Waiting for the first key: 30s, and 5s of slack.
    await clock.advance(34000)
    expect(seen.toasts.at(-1)).not.toBe('Calibration failed: the sensor went quiet.')
    await clock.advance(1000)
    expect(seen.toasts.at(-1)).toBe('Calibration failed: the sensor went quiet.')
    await feed(slapLine(0.3))
    expect(seen.toasts.filter(t => t.endsWith('L3'))).toEqual(['いたっ！ L3'])

    // The reader stops once its waiting pull lets go.
    await feedRaw(0.01)
    expect(seen.readersClosed).toBe(1)
  })

  test('a calibration whose slapd exits says why', SLOW, async ($, on) => {
    const stderr = 'slapd: cannot open accelerometer (IOReturn 0xe00002c5); run with sudo\n'
    const { clock, seen, slaps } = await harness($, on, { claude: true }, { rawExits: stderr })

    await slaps('calibrate')
    await clock.settle()

    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toBe(
      'Calibration failed: the sensor reader stopped (slapd: cannot open accelerometer (IOReturn 0xe00002c5); run with sudo).',
    )
  })

  test('a second /slaps calibrate while one runs is turned away', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps, typeKey } = await harness($, on)

    await slaps('calibrate')
    expect((await slaps('calibrate')).text).toBe('Already calibrating; wait for its result.')
    expect(seen.spawned.filter(argv => argv.includes('--raw'))).toHaveLength(1)

    await typeKey()
    await feedRaw(0.03)
    await clock.advance(6000)
    await feedRaw(0.3, 0.002, 0.2, 0.002, 0.25, 0.002)
    await clock.advance(8000)
    await feedRaw(0.002)
    expect(seen.configured).toHaveLength(1)

    // Once it is over, another may start.
    expect((await slaps('calibrate')).text).toMatch(/^Calibrating\./)
    await clock.settle()
    expect(seen.spawned.filter(argv => argv.includes('--raw'))).toHaveLength(2)
  })

  test('/slaps mute keeps the laptop quiet', SLOW, async ($, on) => {
    const { seen, feed, slaps } = await harness($, on)

    expect((await slaps('mute')).text).toBe('Laptop voice off.')
    await feed(slapLine(0.4))
    expect(seen.played).toEqual([])

    expect((await slaps('unmute')).text).toBe('Laptop voice on.')
    await feed(slapLine(0.4))
    expect(seen.played).toEqual(['assets/voices/sakura/level_3.mp3'])
  })
})
