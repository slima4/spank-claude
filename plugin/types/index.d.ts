export type Slap = { ts: number; peak: number; level: number }

// The face drawn above the prompt for a moment after a slap.
export type FaceShown = { level: number; peak: number; line: string }

declare module 'claude-code' {
  interface PluginState {
    spank: { count: number; last: Slap | null; turn: string | null; face: FaceShown | null; probe: boolean }
  }
}
