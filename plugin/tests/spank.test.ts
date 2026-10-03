import { expect, mock, test } from 'claude-code/testing'

const SLAP = JSON.stringify({ type: 'slap', ts: 1791041867213, peak: 0.4231, level: 3 })

test('a hit slapd reports is counted, shown and listed by /slaps', async ($, on) => {
  mock.store(on, { total: 41 })

  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  let markCounted = () => {}
  const counted = new Promise<void>(resolve => (markCounted = resolve))

  on('ui.status', ($, e) => {
    statuses.push(e.text)
    if (e.text?.startsWith('spank: 1 this session')) markCounted()
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  // slapd's stdout, a line split across two reads, then it exits.
  on('process.spawn', async function* ($, e) {
    expect(e.argv[0]).toMatch(/\/bin\/slapd$/)
    yield { stream: 'stdout' as const, text: '{"type":"start","ts":1}\n' + SLAP.slice(0, 20) }
    yield { stream: 'stderr' as const, text: 'slapd: listening\n' }
    yield { stream: 'stdout' as const, text: SLAP.slice(20) + '\nnot json\n' }
    await counted
    return { value: { code: 0, signal: null } }
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await counted

  expect(statuses).toContain('spank: armed')
  expect(statuses).toContain('spank: 1 this session, last L3 (0.42g)')
  expect(toasts).toEqual(['Ouch! L3'])

  const out = await $.command.run({
    command: 'slaps',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(out.text).toBe('1 slaps this session, 42 all time; last one level 3, 0.42g.')
})
