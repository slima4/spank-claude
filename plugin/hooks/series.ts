import type { SeriesId } from './faces'

// A voice: a clip per slap level, assets/voices/<voice>/level_<1-5>.mp3, and
// what each one says, shown beside the face and in the toast.
export type Voice = { captions: readonly [string, string, string, string, string] }

export const VOICES = {
  sakura: { captions: ['んっ！', 'あっ！', 'いたっ！', 'きゃっ！', 'あぁっ…！'] },
  // Natsu's faces are still to come; until then no series uses this voice.
  natsu: { captions: ['えっ！', 'うっ！', 'いてっ！', 'やっ！', 'うわぁっ！'] },
} as const satisfies Record<string, Voice>

export type VoiceId = keyof typeof VOICES

// A face series: its faces are assets/faces/<series>/level_<1-5>.png (drawn
// into faces.ts by `make faces`), and it speaks with one of the voices; a
// series with no voice of its own can borrow another's. The face_series
// setting picks one, so its options in plugin.json list every series.
export type Series = { voice: VoiceId }

export const SERIES: Record<SeriesId, Series> = {
  sakura: { voice: 'sakura' },
}

export const DEFAULT_SERIES: SeriesId = 'sakura'

export function isSeries(value: unknown): value is SeriesId {
  return typeof value === 'string' && Object.hasOwn(SERIES, value)
}
