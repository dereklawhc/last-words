export type RereadItem = {
  /** Absolute path of a file to re-read after compaction. */
  path: string
  /** "full", or the headings / line ranges to read. */
  scope: string
  why?: string
}

export type AfterMode = 'continue' | 'discuss' | 'wait'

export type CompactionRequest = {
  /** Absolute path of the handoff file. */
  handoff: string
  reread: RereadItem[]
  after: AfterMode
  next: string
  focus?: string
  /** `$.clock.now()` when the request was made. */
  at: number
}

export type HcState = {
  enabled: boolean
  /** Queued by the tool, waiting for the turn to end. */
  pending?: CompactionRequest
  /** Handed to /compact at turn end; consumed by the session.compact hook. */
  inflight?: CompactionRequest
  /** The last request that compacted, reused for compactions the mod did not start. */
  lastRequest?: CompactionRequest
  compactions: number
  /** Context tokens at the first turn end after the last compaction; -1 until that turn ends. */
  lastPostTokens: number
  /** Highest nudge level (0-3) sent since the last compaction. */
  nudgeLevel: number
  snapshots: string[]
  transcriptPath?: string
}

/** The last inbound prompt, notification or message; kept apart from HcState so its writes never race the request's. */
export type HcInbound = {
  /** `$.clock.now()` when it arrived; 0 for none. */
  at: number
  what?: string
}

declare module 'claude-code' {
  interface PluginState {
    'last-words': { s: Shaped<HcState>; inbound: Shaped<HcInbound> }
  }
}
