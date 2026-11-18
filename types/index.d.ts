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
  /** `$.clock.now()` when the mod last asked for a handoff in place of an idle compaction; 0 for never. */
  idleAskAt: number
}

/** The last inbound prompt, notification or message; kept apart from HcState so its writes never race the request's. */
export type HcInbound = {
  /** `$.clock.now()` when it arrived; 0 for none. */
  at: number
  what?: string
}

/** The main loop's turns, written only by the turn hooks. */
export type HcTurns = {
  running: boolean
  /** `$.clock.now()` when the last main-loop turn ended; 0 for none yet. */
  endedAt: number
}

/** A file the re-entry note told Claude to read, and whether Claude has opened it since. */
export type HcReadItem = RereadItem & { read: boolean }

/** The reading check after a compaction; written by the tool.call and turn hooks only. */
export type HcReads = {
  /** True from the compaction until the check has run once. */
  armed: boolean
  /** True once a main-loop turn has started since arming. */
  started: boolean
  files: HcReadItem[]
}

/** One subagent's context size as the mod last read it, and the highest nudge level sent to it. */
export type HcAgent = {
  tokens: number
  level: number
  /** `$.clock.now()` of the reading. */
  at: number
  /** Where the mod saved the agent's original brief, verbatim; set once it passes the first level or compacts. */
  brief?: string
}

/** Subagents by agent id; written by the tool.call and session.compact hooks only. */
export type HcAgents = { byId: Record<string, HcAgent> }

/** The engine's auto-compact threshold as the mod last read it; levels and the cooldown are shares of it. Written by the session.start and turn.complete hooks only. */
export type HcWindow = {
  /** Tokens at which Claude Code auto-compacts (`autoCompactThreshold`), or the 967k fallback. */
  threshold: number
  /** The compaction window the breakdown measures against (`rawMaxTokens`); threshold + 33k on the fallback. */
  window: number
  /** Where `threshold` came from: the breakdown, or the fallback when it could not be read. */
  source: 'breakdown' | 'fallback'
  /** How the engine settled the window (`autocompactSource`: model-default, auto, env, ...), when read. */
  windowSource?: string
  /** The model id the reading was taken for (`$.session.model()`); a different id at turn end re-reads it. */
  model?: string
  /** Why the breakdown could not be read, on the fallback. */
  error?: string
  /** `$.clock.now()` of the reading; 0 before the first. */
  at: number
}

/** A `key: value` scalar from a strategy profile's front matter, parsed. A share is a fraction of the auto-compact threshold (or of the window, for reread_budget). */
export type StrategyProfile = {
  template?: string
  /** Shares of the auto-compact threshold; null for `off`. */
  nudge_1?: number | null
  nudge_2?: number | null
  nudge_3?: number | null
  cooldown?: number
  subagents?: boolean
  sub_nudge_1?: number
  sub_nudge_2?: number
  sub_nudge_3?: number
  resume_hold?: boolean
  reread_budget?: number
  /** `repo:<path>`, `mod`, or an absolute folder. */
  handoff?: string
  after?: AfterMode
  idle_handoff?: boolean
  snapshot?: boolean
  snapshot_keep?: number
  /** The date the user approved the profile (YYYY-MM-DD). */
  approved?: string
}

/** One profile file as loaded: its path, scope, numbers and body; or why it was ignored. */
export type LoadedProfile = {
  scope: 'user' | 'project'
  path: string
  values: StrategyProfile
  /** The Markdown body after the front matter. */
  body: string
}

/** The mod's setup record in `$.store` under `setup`, kept across sessions: the offer, a decline, or a saved profile. */
export type SetupRecord = {
  /** ISO time of the latest change. */
  at: string
  /** What wrote it: the first-session offer, `setup_save`, or a decline (the `/last-words setup decline` command or `setup_save` with `declined`). */
  via: 'offer' | 'save' | 'decline'
  declined?: boolean
  done?: boolean
  /** The profile file `setup_save` wrote last. */
  path?: string
}

declare module 'claude-code' {
  interface PluginState {
    'last-words': { s: Shaped<HcState>; inbound: Shaped<HcInbound>; turns: Shaped<HcTurns>; reads: Shaped<HcReads>; agents: Shaped<HcAgents>; win: Shaped<HcWindow> }
  }
}
