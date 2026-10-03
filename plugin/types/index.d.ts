export type Slap = { ts: number; peak: number; level: number }

declare module 'claude-code' {
  interface PluginState {
    spank: { count: number; last: Slap | null; turn: string | null }
  }
}
