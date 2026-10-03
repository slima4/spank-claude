import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The band above the prompt, roomy enough for the largest face.
const BAND = {
  plugin: 'spank',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

const CLIP_2 = 'assets/voices/level_2.mp3'
const CLIP_4 = 'assets/voices/level_4.mp3'

function queue() {
  return { lines: [] as string[], wake: () => {} }
}

function raw(peak: number) {
  return JSON.stringify({ type: 'raw', peak, noise: 0.001 })
}

function slapLine(level: number, peak: number) {
  return JSON.stringify({ type: 'slap', ts: 1791041867213, peak, level })
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
  rawExits?: string
}

async function harness($: Engine, on: On, stored: Record<string, unknown> = { claude: true }, world: World = {}) {
  mock.store(on, { total: 41, ...stored })
  const clock = mock.clock(on)
  const seen = {
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    played: [] as string[],
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
  on('audio.play', ($, e) => {
    if (e.clip.asset !== undefined) seen.played.push(e.clip.asset)
    seen.gains.push(e.gain ?? 1)
    if (holdClips) return new Promise(resolve => held.push(() => resolve({ value: undefined })))
    return { value: undefined }
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
  // The /config rows: the engine's own, then this plugin's sensitivity.
  on('config.list', () => ({
    value: [
      { key: 'theme', label: 'Theme', kind: 'choice' as const, value: 'dark', provider: { plugin: 'core', tier: 'core' as const }, isLocked: false },
      { key: 'spank.threshold', label: 'Slap sensitivity (g)', kind: 'number' as const, value: 0.05, provider: { plugin: 'spank', tier: 'user' as const }, isLocked: false },
    ].slice(0, world.hasThresholdRow === false ? 1 : 2),
  }))
  on('config.set', ($, e) => {
    seen.configured.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })

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

    expect(seen.statuses).toContain('spank: armed (0.05g)')
    expect(seen.statuses).toContain('spank: 1 this session, last L3 (0.42g)')
    expect(seen.toasts).toEqual(['いたっ！ L3'])
    expect((await slaps()).text).toBe('1 slaps this session, 42 all time; last one level 3, 0.42g.')
  })

  test('each slap plays its level\'s clip, and the sensor keeps listening', SLOW, async ($, on) => {
    const { clock, seen, feed } = await harness($, on)

    await feed(slapLine(2, 0.2))
    await clock.advance(1600)
    await feed(slapLine(3, 0.31))
    await clock.advance(1600)

    expect(seen.played).toEqual(['assets/voices/level_2.mp3', 'assets/voices/level_3.mp3'])
    expect(seen.aborted).toEqual([])
    expect(seen.statuses.at(-1)).toBe('spank: 2 this session, last L3 (0.31g)')
  })

  test('a hard slap during a turn stops it and tells Claude why', SLOW, async ($, on) => {
    const { seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(5, 1.7))

    expect(seen.aborted).toEqual(['turn-1'])
    expect(seen.played).toEqual(['assets/voices/level_5.mp3'])
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
    expect(seen.played).toEqual(['assets/voices/level_5.mp3'])
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
    expect(seen.toasts).toEqual(['あぁっ…！ L5'])
    expect(seen.played).toEqual(['assets/voices/level_5.mp3'])
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
    expect(await ui.find({ text: 'あぁっ…！' })).toBeDefined()
    expect(await ui.find({ text: /level 5 of 5, 1\.63g/ })).toBeDefined()

    await clock.advance(3000)
    expect(await ui.find({ key: 'face' })).toBeUndefined()
    await ui.unmount()

    const narrow = await $.ui.mount({ ...band, props: { ...band.props, maxRows: 9 } })
    await feed(slapLine(2, 0.2))
    expect((await narrow.find({ key: 'face' }))?.props.rows).toBe(8)
    await narrow.unmount()
  })

  test('a harder slap cuts in on a clip; a softer one waits it out', SLOW, async ($, on) => {
    const { seen, feed, holdClips, releaseClips } = await harness($, on)

    holdClips()
    await feed(slapLine(2, 0.2))
    await feed(slapLine(1, 0.07))
    await feed(slapLine(4, 0.6))
    await feed(slapLine(3, 0.3))
    releaseClips()

    expect(seen.played).toEqual([CLIP_2, CLIP_4])
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

  test('settings: by default slapd gets the manifest default', SLOW, async ($, on) => {
    const { seen } = await harness($, on)
    expect(seen.spawned[0]?.slice(1)).toEqual(['--threshold', '0.05'])
  })

  test('settings: a higher stop level lets a level 4 slap through', { ...SLOW, options: { stop_level: 5 } }, async ($, on) => {
    const { seen, feed, turnStart } = await harness($, on)

    await turnStart('turn-1')
    await feed(slapLine(4, 0.6))
    expect(seen.aborted).toEqual([])
    await feed(slapLine(5, 1.2))
    expect(seen.aborted).toEqual(['turn-1'])
  })

  test('settings: volume scales the clip', { ...SLOW, options: { volume: 2.5 } }, async ($, on) => {
    const { seen, feed } = await harness($, on)
    await feed(slapLine(3, 0.3))
    expect(seen.gains).toEqual([2.5])
  })

  test('settings: volume 0 plays nothing', { ...SLOW, options: { volume: 0 } }, async ($, on) => {
    const { seen, feed } = await harness($, on)
    await feed(slapLine(3, 0.3))
    expect(seen.played).toEqual([])
  })

  test('settings: faces are large by default', SLOW, async ($, on) => {
    const { feed } = await harness($, on)
    const ui = await $.ui.mount(BAND)
    await feed(slapLine(3, 0.3))
    expect((await ui.find({ key: 'face' }))?.props.rows).toBe(16)
    await ui.unmount()
  })

  for (const [size, rows] of [['small', 8], ['medium', 12], ['off', undefined]] as const) {
    test(`settings: face size ${size}`, { ...SLOW, options: { face_size: size } }, async ($, on) => {
      const { feed } = await harness($, on)
      const ui = await $.ui.mount(BAND)
      await feed(slapLine(3, 0.3))
      expect((await ui.find({ key: 'face' }))?.props.rows).toBe(rows)
      await ui.unmount()
    })
  }

  test('only the session used last reacts to a slap', SLOW, async ($, on) => {
    const { seen, feed, slaps, setActive, active } = await harness($, on)
    expect(JSON.parse(active() ?? '{}').session).toBe('session-a')

    setActive(JSON.stringify({ session: 'session-b', at: 1 }))
    await feed(slapLine(3, 0.3))
    expect(seen.toasts).toEqual([])
    expect(seen.played).toEqual([])

    await slaps()
    expect(JSON.parse(active() ?? '{}').session).toBe('session-a')
    await feed(slapLine(3, 0.3))
    expect(seen.toasts).toEqual(['いたっ！ L3'])
  })

  test('with the active-session file unreadable, every session reacts', SLOW, async ($, on) => {
    const { seen, feed, setActive } = await harness($, on)

    setActive('{"session": "sess')
    await feed(slapLine(3, 0.3))
    expect(seen.toasts).toEqual(['いたっ！ L3'])
  })

  test('/slaps calibrate sets the sensitivity between typing and knocks', SLOW, async ($, on) => {
    const { clock, seen, feed, feedRaw, slaps } = await harness($, on)
    await feed('{"type":"start","ts":1}')

    expect((await slaps('calibrate')).text).toMatch(/^Calibrating\. Type anything for 6 seconds without pressing Enter/)
    await feedRaw(0.01, 0.03, 0.02, 0.025)
    expect(seen.spawned.at(-1)?.slice(1)).toEqual(['--raw', '--threshold', '100'])
    await clock.advance(6000)

    // Three knocks, the second split across two moments; a slap on the
    // session's own stream meanwhile is ignored.
    await feedRaw(0.003, 0.3, 0.004, 0.12, 0.2, 0.003)
    expect(seen.statuses.at(-1)).toBe('spank: calibrating 2/2: knock on the desk 3 times (8s)')
    await feed(slapLine(3, 0.3))
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
    const { clock, seen, feedRaw, slaps } = await harness($, on, { claude: true }, { hasThresholdRow: false })

    await slaps('calibrate')
    await feedRaw(0.03)
    await clock.advance(6000)
    await feedRaw(0.3, 0.002, 0.2, 0.002, 0.25, 0.002)
    await clock.advance(8000)
    await feedRaw(0.002)

    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toMatch(/^Could not save the sensitivity: no sensitivity row in \/config/)
  })

  test('/slaps calibrate gives up on fewer than 3 clear knocks', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps } = await harness($, on)

    await slaps('calibrate')
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

  test('/slaps calibrate gives up when the knocks are barely louder than typing', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps } = await harness($, on)

    await slaps('calibrate')
    await feedRaw(0.03, 0.04)
    await clock.advance(6000)
    await feedRaw(0.05, 0.002, 0.045, 0.002, 0.048)
    await clock.advance(8000)
    await feedRaw(0.002)

    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Calibration failed: heard 0 of 3 knocks reaching 0.060g; knock harder.')
  })

  test('/slaps calibrate with two clear knocks and a soft one says to knock harder', SLOW, async ($, on) => {
    const { clock, seen, feedRaw, slaps } = await harness($, on)

    await slaps('calibrate')
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
    const { clock, seen, feedRaw, slaps } = await harness($, on)

    await slaps('calibrate')
    await feedRaw(0.01, 0.012)
    await clock.advance(6000)
    // Soft taps around 0.02g: louder than the rest, but under the typing floor.
    await feedRaw(0.02, 0.003, 0.021, 0.003, 0.02, 0.003)
    await clock.advance(8000)
    await feedRaw(0.002)

    expect(seen.configured).toEqual([])
    expect(seen.toasts.at(-1)).toMatch(/^Calibration failed: heard 0 of 3 knocks/)
  })

  test('a calibration that hears nothing gives up and stops swallowing slaps', SLOW, async ($, on) => {
    const { clock, seen, feed, feedRaw, slaps } = await harness($, on)

    await slaps('calibrate')
    await feed(slapLine(3, 0.3))
    expect(seen.toasts.filter(t => t.endsWith('L3'))).toEqual([])

    await clock.advance(19000)
    expect(seen.toasts.at(-1)).toBe('Calibration failed: the sensor went quiet.')
    await feed(slapLine(3, 0.3))
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
    const { clock, seen, feedRaw, slaps } = await harness($, on)

    await slaps('calibrate')
    expect((await slaps('calibrate')).text).toBe('Already calibrating; wait for its result.')
    expect(seen.spawned.filter(argv => argv.includes('--raw'))).toHaveLength(1)

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
    await feed(slapLine(3, 0.4))
    expect(seen.played).toEqual([])

    expect((await slaps('unmute')).text).toBe('Laptop voice on.')
    await feed(slapLine(3, 0.4))
    expect(seen.played).toEqual(['assets/voices/level_3.mp3'])
  })
})
