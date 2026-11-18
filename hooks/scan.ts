// The setup scan: streams Claude Code transcripts and computes work-rhythm features per session and per project.
//
// It reads tool names, sizes, timestamps and slash commands. Message text never enters the features file; only
// `sample` reads it, and only for typed user prompts of projects the user put in scope.
//
// The streaming method is the one the probe measured (last-words-probes.md, probe 1): `$.process.spawn` of
// `/bin/cat`, pieces split on newlines, `JSON.parse` per line in the mod's own worker. No Node or Python is needed.
import type { EngineInterface } from 'claude-code'

export type Api = Pick<EngineInterface, 'fs' | 'process'>

// ---------------------------------------------------------------------------------------------------------------
// Constants. Every threshold of `classify` is in CLASSIFY; the rest of the provisional numbers are here.
// ---------------------------------------------------------------------------------------------------------------

const WINDOW_LARGE = 1_000_000
const WINDOW_SMALL = 200_000
/** Models known to have a 200k window. A session that is seen above 200k is 1M whatever its model says. */
const SMALL_WINDOW_MODELS: RegExp[] = [/^claude-3/, /^claude-haiku-4/, /^claude-sonnet-4-/, /^claude-opus-4/]
/** A gap between consecutive rows over this counts as idle (idleGaps10m); over the second one, a long idle gap. */
const IDLE_MS = 10 * 60_000
const LONG_IDLE_MS = 30 * 60_000
/** A Bash, Monitor or TaskOutput call that takes at least this long counts as waiting. */
const WAIT_MIN_MS = 30_000
/** Image tokens are estimated from base64 length: one token per this many characters, within the bounds. */
const IMAGE_CHARS_PER_TOKEN = 100
const IMAGE_MIN_TOKENS = 85
const IMAGE_MAX_TOKENS = 1_600
const SAMPLE_TEXT_CHARS = 600
/** Share of a sample budget spent on the moments before the rest of the prompts get any. */
const SAMPLE_MOMENT_SHARE = 0.75
const CONCURRENCY = 4
const MAX_LINE_CHARS = 64 * 1024 * 1024

const CODE_EXT = new Set([
  'py', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php',
  'sh', 'zsh', 'bash', 'lua', 'scala', 'sol', 'css', 'scss', 'html', 'vue', 'svelte', 'json', 'yaml', 'yml', 'toml', 'xml', 'cu', 'm', 'mm',
])
const DOC_EXT = new Set(['md', 'mdx', 'docx', 'tex', 'txt', 'rst', 'rtf', 'org'])
const DATA_EXT = new Set(['csv', 'tsv', 'ipynb', 'sql', 'parquet', 'jsonl', 'ndjson', 'xlsx', 'feather', 'arrow'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'])
const DATA_FOLDER = /\/(data|datasets?|csv|tables?)\//i
const PLAN_NAME = /(^|[-_. ])(plans?|notes?|handoffs?|todo|roadmap)([-_. ]|$)/i

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

export type Dist = { p50: number; p90: number; max: number }
export type ToolClass = 'edit' | 'bash' | 'read' | 'web' | 'browser' | 'mcp' | 'agent' | 'other'
export type ToolShare = Record<ToolClass, number>

/**
 * Per-project features. A `Dist` is a distribution over the project's sessions unless noted.
 * Counts are totals over the project's sessions.
 */
export type ProjectFeatures = {
  /** Peak context over the session's window (1M, or 200k for a known 200k model). Includes the `preTokens` of compactions. */
  peakShare: Dist
  /** Assistant requests (distinct `message.id`) in the main transcript. */
  turns: Dist
  /** First row to last row, in hours. */
  wallHours: Dist
  /** Typed human prompts. */
  humanPrompts: Dist
  /** `/clear` commands. */
  clears: number
  /** Manual compactions: `compact_boundary` rows with trigger `manual`. */
  manualCompacts: number
  /** Auto-compactions: `compact_boundary` rows with trigger `auto`. */
  autoCompacts: number
  /** Context size before each auto-compaction (`preTokens`), over those compactions. */
  autoPreTokens: Dist
  /** Share of main-transcript tool steps by class. */
  toolShare: ToolShare
  /** Main-transcript tool steps. */
  toolSteps: number
  /** Estimated share of context growth that image blocks account for (0..1). */
  imageShare: Dist
  /** Reads of an image file beyond the first read of each path. */
  imageRereads: number
  /** Wall time inside long Bash, Monitor and TaskOutput calls, over the session's wall time (0..1). */
  waitShare: Dist
  /** Bash calls started with `run_in_background`. */
  backgroundRuns: number
  /** Gaps over 10 minutes between consecutive rows, per session. */
  idleGaps10m: Dist
  /** Gaps over 30 minutes between consecutive rows, per session. */
  idleGaps30m: Dist
  subagents: {
    /** Subagent transcripts, total. */
    count: number
    /** Subagent transcripts per session. */
    perSession: Dist
    /** Peak context in tokens, over the subagents. */
    peak: Dist
    /** SendMessage calls: subagents reused instead of replaced. */
    resumed: number
  }
  /** First row to last row, in days, per session. */
  spanDays: Dist
  /** Sessions holding at least one row marked as a scheduled trigger. */
  scheduled: number
  /** Sessions holding rows of another session id (history carried over by a resume). */
  resumes: number
  /** Files named by Write, Edit and NotebookEdit calls (main and subagents), by kind. */
  filesWritten: { code: number; doc: number; data: number; other: number }
  repo: {
    git: boolean
    planDocs: boolean
    /** A path named on a "handoff" line of the project's CLAUDE.md, or null. */
    handoffPath: string | null
    /** Whether the project's folder still exists. */
    cwdExists: boolean
  }
  /** Context added per hour of active time (gaps over 10 minutes left out), in tokens. */
  growthPerHour: Dist
  /** Sessions per model. */
  models: Record<string, number>
}

export type Project = {
  /** The project folder name under the root. */
  key: string
  /** The most common `cwd` in the project's main transcripts. */
  cwd: string
  sessions: number
  /** Bytes of main and subagent transcripts read. */
  bytes: number
  firstActive: string
  lastActive: string
  features: ProjectFeatures
}

export type ScanStats = {
  files: number
  lines: number
  /** Lines parsed as JSON. */
  parsed: number
  /** Lines that looked like a row we use but did not parse. */
  badLines: number
  /** Files that could not be read. */
  unreadable: number
  bytes: number
  ms: number
}

export type Features = {
  version: 1
  scannedAt: string
  root: string
  projects: Project[]
  stats: ScanStats
}

export type Digest = {
  key: string
  cwd: string
  sessions: number
  /** Bytes of transcripts. */
  size: number
  firstActive: string
  lastActive: string
  type: string
  evidence: string[]
  /** 90th percentile of peakShare, 0..1. */
  peakShareP90: number
  autoCompacts: number
  cwdExists: boolean
}

export type ScanOptions = {
  root: string
  /** Project keys to scan; absent, all. */
  projects?: string[]
  /** ISO date or timestamp: sessions whose transcript was last written before it are skipped. */
  since?: string
  /** Path of the features file to write. */
  out: string
  onProgress?: (msg: string) => void
}

export type SampleOptions = {
  root: string
  projects: string[]
  /** Token budget per project, estimated as characters / 4. */
  budgetTokens: number
  /** Folder to write `<key>.md` files into. */
  dir: string
}

export type SampleFile = { key: string; path: string; tokens: number }

// ---------------------------------------------------------------------------------------------------------------
// Project key
// ---------------------------------------------------------------------------------------------------------------

/** Claude Code's own hash for long folder names (a 32-bit string hash, base 36). */
function javaHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (((h << 5) - h) + s.charCodeAt(i)) | 0
  return h
}

/**
 * Claude Code's project folder name for a working folder: every character outside `[A-Za-z0-9]` becomes `-`
 * (one per UTF-16 code unit, so an astral character gives two), and a name over 200 characters is cut to 200 and
 * suffixed with `-<hash>`. Read from the engine's own function (build 2.1.325) and confirmed against 491 folders under
 * `~/.claude/projects`; the long-name branch is from the binary only, as no folder here is that long.
 */
export function projectKey(cwd: string): string {
  const k = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (k.length <= 200) return k
  return `${k.slice(0, 200)}-${Math.abs(javaHash(cwd)).toString(36)}`
}

// ---------------------------------------------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------------------------------------------

type Counters = { lines: number; parsed: number; bad: number }

/** Streams a file's lines through `/bin/cat`. A line over MAX_LINE_CHARS is dropped. */
async function streamLines($: Api, path: string, onLine: (line: string) => void): Promise<void> {
  const s = $.process.spawn({ argv: ['/bin/cat', path] })
  let parts: string[] = []
  let partLen = 0
  for await (const piece of s) {
    if (piece.stream !== 'stdout') continue
    const text = piece.text
    let start = 0
    let i = text.indexOf('\n', start)
    while (i >= 0) {
      if (parts.length) {
        parts.push(text.slice(start, i))
        if (partLen + (i - start) <= MAX_LINE_CHARS) onLine(parts.join(''))
        parts = []
        partLen = 0
      } else {
        onLine(text.slice(start, i))
      }
      start = i + 1
      i = text.indexOf('\n', start)
    }
    if (start < text.length) {
      parts.push(start === 0 ? text : text.slice(start))
      partLen += text.length - start
      if (partLen > MAX_LINE_CHARS) {
        parts = []
        partLen = 0
      }
    }
  }
  if (parts.length) onLine(parts.join(''))
}

// Row types the scan uses. A line holding none of these strings is skipped without parsing.
const WANTED = ['"type":"user"', '"type":"assistant"', '"type":"system"']
function wanted(line: string): boolean {
  return line.includes(WANTED[0]!) || line.includes(WANTED[1]!) || line.includes(WANTED[2]!)
}

function parseRow(line: string, c: Counters): any | undefined {
  c.lines++
  if (!wanted(line)) return undefined
  try {
    const o = JSON.parse(line)
    c.parsed++
    return o
  } catch {
    c.bad++
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Row reading helpers
// ---------------------------------------------------------------------------------------------------------------

type UserRow =
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; name: string }
  | { kind: 'result' }
  | { kind: 'other' }

function blocksOf(o: any): any[] | string | undefined {
  const c = o?.message?.content
  return typeof c === 'string' || Array.isArray(c) ? c : undefined
}

function textOf(c: any[] | string): string {
  if (typeof c === 'string') return c
  let out = ''
  for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
  return out
}

const NOT_A_PROMPT = ['<local-command', '<task-notification', '<system-reminder', '<bash-', '[Request interrupted', '<scheduled-task']

/** Classifies a user row: a typed prompt, a slash command, a tool result, or something the engine wrote. */
function userRow(o: any): UserRow {
  if (o.isMeta || o.isCompactSummary) return { kind: 'other' }
  const c = blocksOf(o)
  if (c === undefined) return { kind: 'other' }
  if (Array.isArray(c) && c.some(b => b && b.type === 'tool_result')) return { kind: 'result' }
  const kind = o.origin && typeof o.origin === 'object' ? o.origin.kind : undefined
  if (kind !== undefined && kind !== 'human') return { kind: 'other' }
  const text = textOf(c).trim()
  if (!text) return { kind: 'other' }
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
    const m = /<command-name>\s*\/?([^<\s]+)/.exec(text)
    return { kind: 'command', name: m ? m[1]! : '' }
  }
  for (const p of NOT_A_PROMPT) if (text.startsWith(p)) return { kind: 'other' }
  return { kind: 'prompt', text }
}

function isScheduled(o: any): boolean {
  const k = o.origin && typeof o.origin === 'object' ? String(o.origin.kind ?? '') : ''
  if (k && /schedul|cron|routine|trigger|loop/i.test(k)) return true
  const c = blocksOf(o)
  if (c === undefined) return false
  const head = (typeof c === 'string' ? c : textOf(c)).slice(0, 200)
  return head.includes('<scheduled-task')
}

function toolClass(name: string): ToolClass {
  if (/browser|playwright|chrome|screenshot/i.test(name)) return 'browser'
  if (name.startsWith('mcp__')) return 'mcp'
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
    case 'Monitor':
    case 'TaskOutput':
    case 'TaskStop':
      return 'bash'
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'NotebookRead':
      return 'read'
    case 'WebSearch':
    case 'WebFetch':
      return 'web'
    case 'Agent':
    case 'Task':
    case 'SendMessage':
      return 'agent'
    default:
      return 'other'
  }
}

const WAIT_TOOLS = new Set(['Bash', 'Monitor', 'TaskOutput', 'BashOutput'])

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase()
}

function fileKind(path: string): 'code' | 'doc' | 'data' | 'other' {
  const e = extOf(path)
  if (DATA_EXT.has(e)) return 'data'
  if (DOC_EXT.has(e)) return 'doc'
  if (e === 'json' && DATA_FOLDER.test(path)) return 'data'
  if (CODE_EXT.has(e)) return 'code'
  return 'other'
}

function imageTokens(base64Len: number): number {
  return Math.min(IMAGE_MAX_TOKENS, Math.max(IMAGE_MIN_TOKENS, Math.ceil(base64Len / IMAGE_CHARS_PER_TOKEN)))
}

function contextOf(usage: any): number {
  return (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)
}

// ---------------------------------------------------------------------------------------------------------------
// Per-session accumulation
// ---------------------------------------------------------------------------------------------------------------

type SessionStats = {
  id: string
  firstTs: number
  lastTs: number
  peak: number
  models: Set<string>
  turns: number
  humanPrompts: number
  clears: number
  compactCommands: number
  manualCompacts: number
  autoPre: number[]
  steps: ToolShare
  imageTokens: number
  growth: number
  waitMs: number
  backgroundRuns: number
  idle10: number
  idle30: number
  idleMs: number
  scheduled: boolean
  foreignId: boolean
  sendMessages: number
  imageReads: number
  imagePaths: Set<string>
  cwds: Map<string, number>
  subPeaks: number[]
  files: { code: number; doc: number; data: number; other: number }
  bytes: number
}

function newSession(id: string, bytes: number): SessionStats {
  return {
    id, firstTs: Infinity, lastTs: -Infinity, peak: 0, models: new Set(), turns: 0, humanPrompts: 0, clears: 0, compactCommands: 0,
    manualCompacts: 0, autoPre: [], steps: { edit: 0, bash: 0, read: 0, web: 0, browser: 0, mcp: 0, agent: 0, other: 0 },
    imageTokens: 0, growth: 0, waitMs: 0, backgroundRuns: 0, idle10: 0, idle30: 0, idleMs: 0, scheduled: false, foreignId: false,
    sendMessages: 0, imageReads: 0, imagePaths: new Set(), cwds: new Map(), subPeaks: [], files: { code: 0, doc: 0, data: 0, other: 0 }, bytes,
  }
}

type ToolUse = { name: string; ts: number; bg: boolean }

/** Counts the images in a user row's content, including those nested in tool results, as estimated tokens. */
function imageTokensIn(c: any[] | string): number {
  if (typeof c === 'string') return 0
  let t = 0
  for (const b of c) {
    if (!b) continue
    if (b.type === 'image') t += imageTokens(String(b.source?.data ?? '').length)
    else if (b.type === 'tool_result' && Array.isArray(b.content)) {
      for (const x of b.content) if (x && x.type === 'image') t += imageTokens(String(x.source?.data ?? '').length)
    }
  }
  return t
}

function noteFile(s: SessionStats, input: any): void {
  const p = input?.file_path ?? input?.notebook_path
  if (typeof p !== 'string' || !p) return
  s.files[fileKind(p)]++
}

/** Reads one main transcript. */
async function readMain($: Api, path: string, id: string, bytes: number, c: Counters): Promise<SessionStats> {
  const s = newSession(id, bytes)
  const ctxById = new Map<string, number>()
  const order: { id: string; ts: number }[] = []
  const tools = new Map<string, ToolUse>()
  let prevTs = -Infinity
  let lastCtx = -1
  await streamLines($, path, line => {
    const o = parseRow(line, c)
    if (!o) return
    const type = o.type
    if (type !== 'user' && type !== 'assistant' && type !== 'system') return
    if (typeof o.sessionId === 'string' && o.sessionId !== id) s.foreignId = true
    if (typeof o.cwd === 'string') s.cwds.set(o.cwd, (s.cwds.get(o.cwd) ?? 0) + 1)
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    if (!Number.isNaN(ts)) {
      if (ts < s.firstTs) s.firstTs = ts
      if (ts > s.lastTs) s.lastTs = ts
      if (prevTs > -Infinity && ts > prevTs) {
        const gap = ts - prevTs
        if (gap > IDLE_MS) {
          s.idle10++
          s.idleMs += gap
          if (gap > LONG_IDLE_MS) s.idle30++
        }
      }
      if (ts > prevTs) prevTs = ts
    }

    if (type === 'assistant') {
      const m = o.message
      if (!m) return
      const model = typeof m.model === 'string' ? m.model : ''
      const synthetic = !model || model.startsWith('<')
      if (!synthetic) s.models.add(model)
      if (typeof m.id === 'string' && !synthetic) {
        const ctx = contextOf(m.usage)
        const prev = ctxById.get(m.id)
        if (prev === undefined) {
          ctxById.set(m.id, ctx)
          order.push({ id: m.id, ts })
          s.turns++
        } else if (ctx > prev) ctxById.set(m.id, ctx)
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || b.type !== 'tool_use') continue
          const name = String(b.name ?? '')
          s.steps[toolClass(name)]++
          const input = b.input
          if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') noteFile(s, input)
          if (name === 'SendMessage') s.sendMessages++
          if (name === 'Read' && typeof input?.file_path === 'string' && IMAGE_EXT.has(extOf(input.file_path))) {
            s.imageReads++
            s.imagePaths.add(input.file_path)
          }
          const bg = name === 'Bash' && input?.run_in_background === true
          if (bg) s.backgroundRuns++
          if (typeof b.id === 'string' && WAIT_TOOLS.has(name) && !bg) tools.set(b.id, { name, ts, bg })
        }
      }
      return
    }

    if (type === 'system') {
      if (o.subtype === 'compact_boundary') {
        const md = o.compactMetadata
        const pre = typeof md?.preTokens === 'number' ? md.preTokens : 0
        if (pre > s.peak) s.peak = pre
        if (md?.trigger === 'auto') s.autoPre.push(pre)
        else s.manualCompacts++
      }
      return
    }

    // user
    if (isScheduled(o)) s.scheduled = true
    const c2 = blocksOf(o)
    if (c2 !== undefined) {
      s.imageTokens += imageTokensIn(c2)
      if (Array.isArray(c2)) {
        for (const b of c2) {
          if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            const t = tools.get(b.tool_use_id)
            if (t) {
              tools.delete(b.tool_use_id)
              const d = ts - t.ts
              if (!Number.isNaN(d) && d >= WAIT_MIN_MS) s.waitMs += d
            }
          }
        }
      }
    }
    const u = userRow(o)
    if (u.kind === 'prompt') s.humanPrompts++
    else if (u.kind === 'command') {
      if (u.name === 'clear') s.clears++
      else if (u.name === 'compact') s.compactCommands++
    }
  })
  // Context per request, one count per message id, in order; growth is the sum of the increases.
  for (const { id: mid } of order) {
    const ctx = ctxById.get(mid) ?? 0
    if (ctx > s.peak) s.peak = ctx
    if (lastCtx >= 0 && ctx > lastCtx) s.growth += ctx - lastCtx
    lastCtx = ctx
  }
  return s
}

/** Reads one subagent transcript: its peak context, and the files it wrote. */
async function readSub($: Api, path: string, s: SessionStats, c: Counters): Promise<void> {
  const ctxById = new Map<string, number>()
  let peak = 0
  await streamLines($, path, line => {
    const o = parseRow(line, c)
    if (!o || o.type !== 'assistant') return
    const m = o.message
    if (!m) return
    if (typeof m.id === 'string' && typeof m.model === 'string' && !m.model.startsWith('<')) {
      const ctx = contextOf(m.usage)
      if (ctx > (ctxById.get(m.id) ?? -1)) ctxById.set(m.id, ctx)
      if (ctx > peak) peak = ctx
    }
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'tool_use') {
          const name = String(b.name ?? '')
          if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') noteFile(s, b.input)
          if (name === 'SendMessage') s.sendMessages++
        }
      }
    }
  })
  s.subPeaks.push(peak)
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------------------------

function dist(values: number[]): Dist {
  if (!values.length) return { p50: 0, p90: 0, max: 0 }
  const v = [...values].sort((a, b) => a - b)
  const at = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!
  return { p50: at(0.5), p90: at(0.9), max: v[v.length - 1]! }
}

function round(x: number, d = 3): number {
  const m = 10 ** d
  return Math.round(x * m) / m
}

function roundDist(d: Dist, digits = 3): Dist {
  return { p50: round(d.p50, digits), p90: round(d.p90, digits), max: round(d.max, digits) }
}

function windowOf(s: SessionStats): number {
  if (s.peak > WINDOW_SMALL) return WINDOW_LARGE
  for (const m of s.models) if (SMALL_WINDOW_MODELS.some(r => r.test(m))) return WINDOW_SMALL
  return WINDOW_LARGE
}

type RepoFacts = ProjectFeatures['repo']

async function repoFacts($: Api, cwd: string): Promise<RepoFacts> {
  const out: RepoFacts = { git: false, planDocs: false, handoffPath: null, cwdExists: false }
  if (!cwd) return out
  try {
    out.cwdExists = await $.fs.exists(cwd)
    if (!out.cwdExists) return out
    out.git = await $.fs.exists(`${cwd}/.git`)
    const entries = await $.fs.list(cwd)
    out.planDocs = entries.some(e => PLAN_NAME.test(e.name.replace(/\.[^.]*$/, '')) || (e.kind === 'dir' && /^(plans?|notes|handoffs?)$/i.test(e.name)))
    try {
      const md = await $.fs.read(`${cwd}/CLAUDE.md`)
      for (const line of md.split('\n')) {
        if (!/handoff/i.test(line)) continue
        const m = /(~?\/?[\w.@-]+(?:\/[\w.@-]+)*\.md|~?\/[\w.@-]+(?:\/[\w.@-]+)*\/)/.exec(line)
        if (m) {
          out.handoffPath = m[1]!.slice(0, 200)
          break
        }
      }
    } catch {
      // no CLAUDE.md, or too large
    }
  } catch {
    // leave what was found
  }
  return out
}

async function buildProject($: Api, key: string, sessions: SessionStats[]): Promise<Project> {
  const cwds = new Map<string, number>()
  for (const s of sessions) for (const [k, n] of s.cwds) cwds.set(k, (cwds.get(k) ?? 0) + n)
  let cwd = ''
  let best = -1
  for (const [k, n] of cwds) if (n > best) ((cwd = k), (best = n))

  const share: ToolShare = { edit: 0, bash: 0, read: 0, web: 0, browser: 0, mcp: 0, agent: 0, other: 0 }
  let steps = 0
  const files = { code: 0, doc: 0, data: 0, other: 0 }
  const models: Record<string, number> = {}
  const autoPre: number[] = []
  const subPeaks: number[] = []
  let first = Infinity
  let last = -Infinity
  let bytes = 0
  let clears = 0, manual = 0, auto = 0, bg = 0, rereads = 0, resumed = 0, subCount = 0, scheduled = 0, resumes = 0
  const peakShare: number[] = [], turns: number[] = [], wallHours: number[] = [], prompts: number[] = [], imageShare: number[] = []
  const waitShare: number[] = [], idle10: number[] = [], idle30: number[] = [], subPer: number[] = [], span: number[] = [], growth: number[] = []

  for (const s of sessions) {
    bytes += s.bytes
    if (s.firstTs < first) first = s.firstTs
    if (s.lastTs > last) last = s.lastTs
    const spanMs = Number.isFinite(s.firstTs) && Number.isFinite(s.lastTs) ? Math.max(0, s.lastTs - s.firstTs) : 0
    peakShare.push(s.peak / windowOf(s))
    turns.push(s.turns)
    wallHours.push(spanMs / 3_600_000)
    prompts.push(s.humanPrompts)
    imageShare.push(s.growth > 0 ? Math.min(1, s.imageTokens / s.growth) : s.imageTokens > 0 ? 1 : 0)
    waitShare.push(spanMs > 0 ? Math.min(1, s.waitMs / spanMs) : 0)
    idle10.push(s.idle10)
    idle30.push(s.idle30)
    span.push(spanMs / 86_400_000)
    const activeH = Math.max(0, spanMs - s.idleMs) / 3_600_000
    growth.push(activeH >= 0.05 ? s.growth / activeH : 0)
    subPer.push(s.subPeaks.length)
    subCount += s.subPeaks.length
    for (const p of s.subPeaks) subPeaks.push(p)
    for (const k of Object.keys(share) as ToolClass[]) {
      share[k] += s.steps[k]
      steps += s.steps[k]
    }
    for (const k of Object.keys(files) as (keyof typeof files)[]) files[k] += s.files[k]
    for (const m of s.models) models[m] = (models[m] ?? 0) + 1
    clears += s.clears
    manual += s.manualCompacts
    auto += s.autoPre.length
    for (const p of s.autoPre) autoPre.push(p)
    bg += s.backgroundRuns
    rereads += Math.max(0, s.imageReads - s.imagePaths.size)
    resumed += s.sendMessages
    if (s.scheduled) scheduled++
    if (s.foreignId) resumes++
  }
  for (const k of Object.keys(share) as ToolClass[]) share[k] = steps ? round(share[k] / steps) : 0

  return {
    key,
    cwd,
    sessions: sessions.length,
    bytes,
    firstActive: Number.isFinite(first) ? new Date(first).toISOString() : '',
    lastActive: Number.isFinite(last) ? new Date(last).toISOString() : '',
    features: {
      peakShare: roundDist(dist(peakShare)),
      turns: dist(turns),
      wallHours: roundDist(dist(wallHours), 2),
      humanPrompts: dist(prompts),
      clears,
      manualCompacts: manual,
      autoCompacts: auto,
      autoPreTokens: dist(autoPre),
      toolShare: share,
      toolSteps: steps,
      imageShare: roundDist(dist(imageShare)),
      imageRereads: rereads,
      waitShare: roundDist(dist(waitShare)),
      backgroundRuns: bg,
      idleGaps10m: dist(idle10),
      idleGaps30m: dist(idle30),
      subagents: { count: subCount, perSession: dist(subPer), peak: dist(subPeaks), resumed },
      spanDays: roundDist(dist(span), 2),
      scheduled,
      resumes,
      filesWritten: files,
      repo: await repoFacts($, cwd),
      growthPerHour: roundDist(dist(growth), 0),
      models,
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------------------------------

type SessionFile = { id: string; path: string; bytes: number; mtimeMs: number; subs: { path: string; bytes: number }[] }

async function listSessions($: Api, dir: string, sinceMs: number): Promise<SessionFile[]> {
  const entries = await $.fs.list(dir)
  const dirs = new Set(entries.filter(e => e.kind === 'dir').map(e => e.name))
  const out: SessionFile[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
    if (e.mtimeMs < sinceMs) continue
    const id = e.name.slice(0, -'.jsonl'.length)
    const subs: { path: string; bytes: number }[] = []
    if (dirs.has(id)) {
      try {
        for (const f of await $.fs.list(`${dir}/${id}/subagents`)) {
          if (f.kind === 'file' && f.name.startsWith('agent-') && f.name.endsWith('.jsonl')) subs.push({ path: `${dir}/${id}/subagents/${f.name}`, bytes: f.size })
        }
      } catch {
        // no subagents folder
      }
    }
    out.push({ id, path: `${dir}/${e.name}`, bytes: e.size, mtimeMs: e.mtimeMs, subs })
  }
  return out
}

/** Runs `work` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners: Promise<void>[] = []
  for (let r = 0; r < Math.min(n, items.length); r++) {
    runners.push(
      (async () => {
        while (next < items.length) await work(items[next++]!)
      })(),
    )
  }
  await Promise.all(runners)
}

/**
 * Streams every transcript under `opts.root` (`<key>/<session>.jsonl`, `<key>/<session>/subagents/agent-*.jsonl`),
 * computes the features, writes them to `opts.out` and returns them.
 */
export async function scan($: Api, opts: ScanOptions): Promise<Features> {
  const t0 = Date.now()
  const root = opts.root.replace(/\/+$/, '')
  const sinceMs = opts.since ? Date.parse(opts.since) : -Infinity
  const wantedKeys = opts.projects ? new Set(opts.projects) : undefined
  const progress = opts.onProgress ?? (() => {})
  const counters: Counters = { lines: 0, parsed: 0, bad: 0 }
  const stats: ScanStats = { files: 0, lines: 0, parsed: 0, badLines: 0, unreadable: 0, bytes: 0, ms: 0 }

  const keys = (await $.fs.list(root)).filter(e => e.kind === 'dir' && (!wantedKeys || wantedKeys.has(e.name))).map(e => e.name).sort()
  const projects: Project[] = []
  let done = 0
  for (const key of keys) {
    const files = await listSessions($, `${root}/${key}`, sinceMs)
    const sessions: SessionStats[] = []
    await pool(files, CONCURRENCY, async f => {
      try {
        const s = await readMain($, f.path, f.id, f.bytes + f.subs.reduce((a, b) => a + b.bytes, 0), counters)
        stats.files++
        stats.bytes += f.bytes
        for (const sub of f.subs) {
          try {
            await readSub($, sub.path, s, counters)
            stats.files++
            stats.bytes += sub.bytes
          } catch {
            stats.unreadable++
          }
        }
        // A transcript with no conversation rows (only metadata) is not a session.
        if (s.turns > 0 || s.humanPrompts > 0 || Number.isFinite(s.firstTs)) sessions.push(s)
      } catch {
        stats.unreadable++
      }
    })
    done++
    if (sessions.length) projects.push(await buildProject($, key, sessions))
    progress(`scanned ${done}/${keys.length} projects, ${stats.files} files`)
  }
  projects.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1))
  stats.lines = counters.lines
  stats.parsed = counters.parsed
  stats.badLines = counters.bad
  stats.ms = Date.now() - t0
  const features: Features = { version: 1, scannedAt: new Date().toISOString(), root, projects, stats }
  await $.fs.write(opts.out, JSON.stringify(features, null, 1))
  return features
}

// ---------------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------------

/** Provisional thresholds, in one place. They are inferred, not calibrated; the proposal shows the evidence for each call. */
export const CLASSIFY = {
  /** short-tasks: median human prompts at most, and 90th percentile of peak share under. */
  shortPromptsP50: 2,
  shortPeakP90: 0.3,
  /** persistent-assistant: 90th percentile of span in days at least, with either MCP share at least or any scheduled session. */
  persistentSpanDaysP90: 2,
  persistentMcpShare: 0.2,
  /** multi-wave-subagents: subagents per session (mean) at least, or agent-tool share at least with SendMessage reuse. */
  waveSubagentsPerSession: 3,
  waveAgentShare: 0.08,
  /** visual-iteration: image share (p90) at least, or browser-tool share at least. */
  visualImageShareP90: 0.25,
  visualBrowserShare: 0.2,
  /** experiment-ops: bash share at least, edit share under, and waits (p90 of wait share) or long idle gaps (p90 of 30-min gaps) at least. */
  opsBashShare: 0.45,
  opsEditShareMax: 0.2,
  opsWaitShareP90: 0.15,
  opsIdleGaps30mP90: 1,
  /** data-wrangling and document-work: share of written files, with this many written files at least. */
  dataFileShare: 0.4,
  docFileShare: 0.5,
  filesMin: 3,
  /** phased-research: web + read share at least, web share at least, edit share under, median prompts at least. */
  researchReadWebShare: 0.45,
  researchWebShare: 0.08,
  researchEditShareMax: 0.25,
  researchPromptsP50: 4,
  /** single-thread-build: edit share at least. */
  buildEditShare: 0.15,
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

/** Maps a project's features to one of the nine template names, with the features that decided it. First matching rule wins. */
export function classify(p: Project): { type: string; evidence: string[] } {
  const f = p.features
  const T = CLASSIFY
  const sh = f.toolShare
  const written = f.filesWritten.code + f.filesWritten.doc + f.filesWritten.data
  const subPerSession = p.sessions ? f.subagents.count / p.sessions : 0

  if (f.spanDays.p90 >= T.persistentSpanDaysP90 && (sh.mcp >= T.persistentMcpShare || f.scheduled > 0)) {
    return {
      type: 'persistent-assistant',
      evidence: [`sessions stay open ${f.spanDays.p90} days (p90)`, f.scheduled > 0 ? `${f.scheduled} sessions with scheduled triggers` : `MCP tools are ${pct(sh.mcp)} of steps`, repoNote(f)],
    }
  }
  if (f.humanPrompts.p50 <= T.shortPromptsP50 && f.peakShare.p90 < T.shortPeakP90) {
    return { type: 'short-tasks', evidence: [`median ${f.humanPrompts.p50} typed prompts per session`, `peak context ${pct(f.peakShare.p90)} of the window (p90)`, `${f.clears} /clear`] }
  }
  if (subPerSession >= T.waveSubagentsPerSession || (sh.agent >= T.waveAgentShare && f.subagents.resumed > 0)) {
    return {
      type: 'multi-wave-subagents',
      evidence: [`${f.subagents.count} subagents over ${p.sessions} sessions`, `agent tools ${pct(sh.agent)} of steps`, `${f.subagents.resumed} SendMessage reuses`],
    }
  }
  if (f.imageShare.p90 >= T.visualImageShareP90 || sh.browser >= T.visualBrowserShare) {
    return { type: 'visual-iteration', evidence: [`images ${pct(f.imageShare.p90)} of context growth (p90)`, `browser and screenshot tools ${pct(sh.browser)} of steps`, `${f.imageRereads} repeated image reads`] }
  }
  if (sh.bash >= T.opsBashShare && sh.edit < T.opsEditShareMax && (f.waitShare.p90 >= T.opsWaitShareP90 || f.idleGaps30m.p90 >= T.opsIdleGaps30mP90)) {
    return { type: 'experiment-ops', evidence: [`Bash ${pct(sh.bash)} of steps, edits ${pct(sh.edit)}`, `waiting ${pct(f.waitShare.p90)} of wall time (p90)`, `${f.idleGaps30m.p90} gaps over 30 min per session (p90)`, `${f.backgroundRuns} background runs`] }
  }
  if (written >= T.filesMin && f.filesWritten.data / written >= T.dataFileShare) {
    return { type: 'data-wrangling', evidence: [`${f.filesWritten.data} of ${written} written files are data`, `Bash ${pct(sh.bash)} of steps`] }
  }
  if (written >= T.filesMin && f.filesWritten.doc / written >= T.docFileShare) {
    return { type: 'document-work', evidence: [`${f.filesWritten.doc} of ${written} written files are documents`, `median ${f.humanPrompts.p50} typed prompts per session`] }
  }
  if (sh.read + sh.web >= T.researchReadWebShare && sh.web >= T.researchWebShare && sh.edit < T.researchEditShareMax && f.humanPrompts.p50 >= T.researchPromptsP50) {
    return { type: 'phased-research', evidence: [`web ${pct(sh.web)} and reads ${pct(sh.read)} of steps`, `edits ${pct(sh.edit)}`, `median ${f.humanPrompts.p50} typed prompts per session`] }
  }
  if (sh.edit >= T.buildEditShare) {
    return { type: 'single-thread-build', evidence: [`edits ${pct(sh.edit)} and Bash ${pct(sh.bash)} of steps`, `${f.subagents.count} subagents`, `median ${f.humanPrompts.p50} typed prompts per session`] }
  }
  return {
    type: 'single-thread-build',
    evidence: ['no rule matched; default', `edits ${pct(sh.edit)}, Bash ${pct(sh.bash)}, reads ${pct(sh.read)}, web ${pct(sh.web)} of steps`, `median ${f.humanPrompts.p50} typed prompts per session`],
  }
}

function repoNote(f: ProjectFeatures): string {
  return f.repo.git ? 'a git repo' : 'no git repo'
}

/** One entry per project: identity, size, recency and the tentative type with its evidence. */
export function digest(f: Features): Digest[] {
  return f.projects.map(p => {
    const c = classify(p)
    return {
      key: p.key,
      cwd: p.cwd,
      sessions: p.sessions,
      size: p.bytes,
      firstActive: p.firstActive,
      lastActive: p.lastActive,
      type: c.type,
      evidence: c.evidence,
      peakShareP90: p.features.peakShare.p90,
      autoCompacts: p.features.autoCompacts,
      cwdExists: p.features.repo.cwdExists,
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------------------------------------------

type Moment = 'auto' | 'clear' | 'compact' | 'gap' | 'start' | 'other'
type Side = 'before' | 'after' | ''
type Cand = { sid: string; ts: number; text: string; moment: Moment; side: Side }

const MOMENT_ORDER: Moment[] = ['auto', 'clear', 'compact', 'gap', 'start']
const MOMENT_HEADING: Record<Moment, string> = {
  auto: 'Around an auto-compaction',
  clear: 'Around /clear',
  compact: 'Around /compact',
  gap: 'After a gap over 30 minutes',
  start: 'Session start',
  other: 'Other prompts',
}

function squash(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > SAMPLE_TEXT_CHARS ? `${t.slice(0, SAMPLE_TEXT_CHARS)}...` : t
}

/** Reads a main transcript for typed prompts and the moments around them. */
async function readPrompts($: Api, path: string, id: string, c: Counters): Promise<Cand[]> {
  const prompts: Cand[] = []
  let prevTs = -Infinity
  let pendingAfter: { moment: Moment } | undefined
  let afterGap = false
  await streamLines($, path, line => {
    const o = parseRow(line, c)
    if (!o) return
    const type = o.type
    if (type !== 'user' && type !== 'assistant' && type !== 'system') return
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    if (!Number.isNaN(ts)) {
      if (prevTs > -Infinity && ts - prevTs > LONG_IDLE_MS) afterGap = true
      if (ts > prevTs) prevTs = ts
    }
    const mark = (moment: Moment) => {
      const last = prompts[prompts.length - 1]
      if (last && last.side === '') ((last.moment = moment), (last.side = 'before'))
      pendingAfter = { moment }
    }
    if (type === 'system') {
      if (o.subtype === 'compact_boundary') mark(o.compactMetadata?.trigger === 'auto' ? 'auto' : 'compact')
      return
    }
    if (type !== 'user') return
    const u = userRow(o)
    if (u.kind === 'command') {
      if (u.name === 'clear') mark('clear')
      else if (u.name === 'compact') mark('compact')
      return
    }
    if (u.kind !== 'prompt') return
    const cand: Cand = { sid: id, ts: Number.isNaN(ts) ? prevTs : ts, text: squash(u.text), moment: 'other', side: '' }
    if (pendingAfter) ((cand.moment = pendingAfter.moment), (cand.side = 'after'))
    else if (afterGap) cand.moment = 'gap'
    else if (prompts.length === 0) cand.moment = 'start'
    pendingAfter = undefined
    afterGap = false
    prompts.push(cand)
  })
  return prompts
}

/** Indices 0..n-1 in an order whose every prefix is spread evenly (van der Corput). */
function spread(n: number): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  let bits = 1
  while (1 << bits < n) bits++
  for (let i = 0; out.length < n && i < 1 << bits; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b)
    if (r < n && !seen.has(r)) {
      seen.add(r)
      out.push(r)
    }
  }
  return out
}

function stamp(ts: number): string {
  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time'
}

function line(c: Cand): string {
  return `- [${c.sid} ${stamp(c.ts)}${c.side ? ` ${c.side}` : ''}] ${c.text}`
}

/**
 * Writes `<dir>/<key>.md` for each project: typed user messages only, each cut to 600 characters, grouped under the
 * moment they sit at, with session id and time. `budgetTokens` (characters / 4) is per project; the moments get
 * the first 75% round-robin, evenly spread over time, then the other prompts fill the rest.
 */
export async function sample($: Api, opts: SampleOptions): Promise<SampleFile[]> {
  const root = opts.root.replace(/\/+$/, '')
  const dir = opts.dir.replace(/\/+$/, '')
  const counters: Counters = { lines: 0, parsed: 0, bad: 0 }
  const out: SampleFile[] = []
  for (const key of opts.projects) {
    let files: SessionFile[] = []
    try {
      files = await listSessions($, `${root}/${key}`, -Infinity)
    } catch {
      // unknown project: an empty sample file below
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const all: Cand[] = []
    for (const f of files) {
      try {
        for (const c of await readPrompts($, f.path, f.id, counters)) all.push(c)
      } catch {
        // skip an unreadable transcript
      }
    }
    const head = `# Samples: ${key}\n\nTyped user messages only, each cut to ${SAMPLE_TEXT_CHARS} characters; session id and time per message; ${all.length} typed prompts in the project, about ${opts.budgetTokens} tokens of them below.\n`
    let used = Math.ceil(head.length / 4)
    const chosen = new Set<Cand>()
    const headed = new Set<Moment>()
    const cost = (c: Cand) => Math.ceil((line(c).length + 1) / 4) + (headed.has(c.moment) ? 0 : Math.ceil(MOMENT_HEADING[c.moment].length / 4) + 2)
    const take = (c: Cand, limit: number): boolean => {
      const t = cost(c)
      if (used + t > limit) return false
      used += t
      headed.add(c.moment)
      chosen.add(c)
      return true
    }
    const lists = new Map<Moment, Cand[]>()
    for (const m of [...MOMENT_ORDER, 'other' as Moment]) lists.set(m, [])
    for (const c of all) lists.get(c.moment)!.push(c)
    // Moments first, round-robin across the kinds, spread over time within each.
    const order = new Map<Moment, number[]>()
    for (const m of MOMENT_ORDER) order.set(m, spread(lists.get(m)!.length))
    const momentLimit = Math.floor(opts.budgetTokens * SAMPLE_MOMENT_SHARE)
    const cursor = new Map<Moment, number>()
    let progressed = true
    while (progressed) {
      progressed = false
      for (const m of MOMENT_ORDER) {
        const ix = order.get(m)!
        const at = cursor.get(m) ?? 0
        if (at >= ix.length) continue
        cursor.set(m, at + 1)
        progressed = true
        take(lists.get(m)![ix[at]!]!, momentLimit)
      }
    }
    const rest = lists.get('other')!
    for (const i of spread(rest.length)) take(rest[i]!, opts.budgetTokens)
    // Leftover budget goes to moment prompts the first pass skipped.
    for (const m of MOMENT_ORDER) for (const i of order.get(m)!) if (!chosen.has(lists.get(m)![i]!)) take(lists.get(m)![i]!, opts.budgetTokens)

    let body = head
    for (const m of [...MOMENT_ORDER, 'other' as Moment]) {
      const picked = lists.get(m)!.filter(c => chosen.has(c)).sort((a, b) => a.ts - b.ts)
      if (!picked.length) continue
      body += `\n## ${MOMENT_HEADING[m]}\n\n${picked.map(line).join('\n')}\n`
    }
    const path = `${dir}/${key}.md`
    await $.fs.write(path, body)
    out.push({ key, path, tokens: Math.ceil(body.length / 4) })
  }
  return out
}

/** Deletes the `.md` files in the samples folder, then the folder if it is empty. */
export async function deleteSamples($: Api, dir: string): Promise<void> {
  const d = dir.replace(/\/+$/, '')
  if (!d || d === '/' || d.includes('\0')) return
  let entries: Awaited<ReturnType<Api['fs']['list']>> = []
  try {
    entries = await $.fs.list(d)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.kind === 'file' && e.name.endsWith('.md') && !e.name.includes('/')) await $.process.run(['/bin/rm', '-f', `${d}/${e.name}`])
  }
  try {
    await $.process.run(['/bin/rmdir', d])
  } catch {
    // not empty, or already gone
  }
}
