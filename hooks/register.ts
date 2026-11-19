import { atom, read, update } from 'claude-code'
import type { PluginOptions, Register } from 'claude-code'

import type { AfterMode, CompactionRequest, HcAgents, HcInbound, HcReads, HcState, HcTurns, HcWindow, LoadedProfile, RereadItem, SetupRecord, StrategyProfile } from '../types'
import { deleteSamples, digest, projectKey, sample, scan } from './scan'

const PLUGIN = 'last-words'
const SKILL = `${PLUGIN}:compaction-handoff`
const SETUP_SKILL = `${PLUGIN}:setup`
// Levels and the cooldown are shares of the engine's auto-compact threshold. The defaults are the shares that give
// the original absolute numbers at 967k (a 1M window): 400k / 700k / 850k, cooldown 100k, subagents 350k / 500k / 700k.
const REFERENCE_THRESHOLD = 967_000
const DEFAULT_SHARES = [400, 700, 850].map(k => (k * 1000) / REFERENCE_THRESHOLD)
const DEFAULT_COOLDOWN_SHARE = 100_000 / REFERENCE_THRESHOLD
const DEFAULT_SUB_SHARES = [350, 500, 700].map(k => (k * 1000) / REFERENCE_THRESHOLD)
// The engine's auto-compact threshold is always its compaction window minus this buffer.
const AUTOCOMPACT_BUFFER = 33_000
const DEFAULT_SNAPSHOT_KEEP = 10
// The plugin's userConfig values, set at install or in the config menu; a change reloads the module.
let configured: PluginOptions = {}
const TEMP_DIRS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

const INITIAL: HcState = {
  enabled: true,
  compactions: 0,
  lastPostTokens: 0,
  nudgeLevel: 0,
  snapshots: [],
  idleAskAt: 0,
}

// Change the tag when HcState's fields change: a stored value under another tag reads as INITIAL.
const st = atom({ plugin: 'last-words', key: 's' } as const, INITIAL, { shape: 'hc-4' })
const NO_INBOUND: HcInbound = { at: 0 }
const ib = atom({ plugin: 'last-words', key: 'inbound' } as const, NO_INBOUND, { shape: 'ib-1' })
const NO_TURNS: HcTurns = { running: false, endedAt: 0 }
const tu = atom({ plugin: 'last-words', key: 'turns' } as const, NO_TURNS, { shape: 'tu-1' })
const NO_READS: HcReads = { armed: false, started: false, files: [] }
const rd = atom({ plugin: 'last-words', key: 'reads' } as const, NO_READS, { shape: 'rd-1' })
const NO_AGENTS: HcAgents = { byId: {} }
const ag = atom({ plugin: 'last-words', key: 'agents' } as const, NO_AGENTS, { shape: 'ag-1' })
const NO_WINDOW: HcWindow = { threshold: REFERENCE_THRESHOLD, window: REFERENCE_THRESHOLD + AUTOCOMPACT_BUFFER, source: 'fallback', at: 0 }
const wn = atom({ plugin: 'last-words', key: 'win' } as const, NO_WINDOW, { shape: 'wn-1' })
// Whether the threshold was re-read once after a failed first reading.
let windowRetried = false
// Subagent nudges waiting for the agent's next tool result, by agent id: the level to record once delivered.
const pendingSub = new Map<string, number>()
// Claude Code's idle compaction fires about 54 minutes after the last activity; anything idle this long counts.
const IDLE_MIN_MS = 40 * 60_000

const TOOL_DESCRIPTION_LINES = [
  'Request compaction of this conversation when the current turn ends. Main thread only.',
  'Call it at a prepared handoff point: when the user has said when to compact, follow that; otherwise by default when a build wave has started (previous wave reviewed and committed, every brief written to a file, builders running, future briefs that need the full history drafted), or when a phase has closed (the user approved its review gate, or a research question is answered) and the next phase opens with a new discussion.',
  'Do not call it while a result is unreviewed, a merge is in progress, you are mid-exchange with a subagent or session, or the user just gave an instruction not yet on disk.',
  'Never call it at a pause or blocking review gate the user has not approved; wait for their approval. If work remains before such a gate, compacting first is fine.',
  'Questions for the user do not block compaction: put them in the handoff with your recommendation and default.',
  'Before calling: rewrite the handoff file (in the repo, with Write or Edit) after the last thing that arrived. The mod refuses a stale handoff.',
  'After calling, end your turn. The mod compacts (archiving a snapshot of the transcript first, when snapshots are on) and resumes you with a note listing the files to re-read.',
  `For the full protocol (when to compact, what the handoff holds) load the skill ${SKILL}.`,
]

async function toolDescription($: any): Promise<string> {
  const lim = await limits($)
  const [a, b, c] = lim.nudges.map(t => (t === null ? 'off' : fmtK(t)))
  const lines = [...TOOL_DESCRIPTION_LINES, `This session's nudge levels: ${a} (take the next natural handoff point), ${b} (drive to one), ${c} (compact at the first safe point); cooldown ${fmtK(lim.cooldown)} of growth after a compaction.`]
  if (strategyProfile(await profiles($))) {
    lines.push('In the main thread, the user approved a compaction strategy for this project (the "Compaction strategy (last-words)" section of its instructions); it comes after their own words and before the skill\'s built-in moments. A subagent does not see that section and does not call this tool.')
    const hw = await handoffWords($)
    if (hw) lines.push(`Under it the handoff lives ${hw}.`)
    const after = await defaultAfter($)
    if (after) lines.push(`Its default after mode is "${after}".`)
  }
  return lines.join(' ')
}

async function registerCompactionTool($: any) {
  await $.tool.register({ name: 'request_compaction', description: await toolDescription($), inputSchema: INPUT_SCHEMA, isDeferred: false })
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    handoff: { type: 'string', description: 'Path of the handoff file (absolute, or relative to the session directory), or "mod" for the mod-owned handoff of this project (~/.claude/last-words/handoffs/<project key>/handoff.md). Always re-read in full after compaction.' },
    reread: {
      type: 'array',
      description: 'Other files to re-read after compaction, most important first (not the handoff, which is always read first).',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          scope: { type: 'string', description: '"full", or the headings or line ranges to read.' },
          why: { type: 'string' },
        },
        required: ['path', 'scope'],
      },
    },
    after: {
      type: 'string',
      enum: ['continue', 'discuss', 'wait'],
      description: 'continue: resume the next steps on your own. discuss: present open questions and recommendations to the user first, working only on what does not need them. wait: re-read, report, then wait for the user.',
    },
    next: { type: 'string', description: 'The first steps after re-reading. Do not restate the reading list here: the note lists every file, and a shorter list here reads as leave to skip the rest.' },
    focus: { type: 'string', description: 'Optional: what the compaction summary should stress.' },
  },
  required: ['handoff', 'reread', 'after', 'next'],
}

const SUMMARY_GUIDANCE = [
  'The working state of this session is written in its handoff file, which will be re-read in full after this compaction.',
  'Stress what the files may not hold: every running subagent, job or background task with its id and what it is doing; the user\'s rulings and decisions from the latest exchanges, verbatim; and the last few exchanges.',
  'Mark anything Claude proposed but the user did not approve as a proposal.',
  'Do not tell the model to continue without asking: a re-entry note after the compaction says what to do next.',
].join(' ')

// What the /compact row shows for the mod's own compaction; the real summary instructions are set in the session.compact hook.
const COMPACT_LABEL = '(requested by Claude at a handoff point)'
// The one visible line of the resume prompt; the re-entry note goes just before it as a hidden row.
// (A plugin's own prompt skips its own prompt.submit hook, so the note cannot ride along as context.)
// The mod's prompts go out asUser, which drops Claude Code's "The <plugin> plugin sent a message … Address the
// message above." frame; each text says in its own words that it comes from the mod, and hooks still see origin plugin.
const RESUME_TEXT = 'Resuming from compaction (re-entry note above).'
const IDLE_TEXT = 'Idle: preparing a handoff before compaction (note above).'

function idleNote(idleMs: number): string {
  return [
    `[last-words] This session has been idle for ${ago(idleMs)}, and its prompt cache expires in a few minutes; after that, compacting means re-reading the whole conversation at full price.`,
    'Claude Code was about to compact it with no handoff. The mod called that off, so you can write one while the cache is still warm.',
    `If this is a sound point to compact (see the skill ${SKILL}), rewrite the handoff and call request_compaction now, with after: "wait" unless a running subagent or job will need you when it reports.`,
    'If it is not, for example because a review gate is waiting on the user, say why in one line and end your turn. You will not be asked again until something new arrives.',
  ].join(' ')
}

const PREPARE_PROMPT = [
  'Prepare for compaction now.',
  `Load the skill ${SKILL} if it is not loaded.`,
  'Capture progress, open issues and pending calls from me, update all docs, and rewrite the handoff file.',
  'Then call request_compaction with the handoff, the files to re-read, the after mode and the next steps, and end your turn.',
].join(' ')

const AFTER_TEXT: Record<AfterMode, string> = {
  continue: 'Then continue with the next steps on your own.',
  discuss: 'Then present the open questions and your recommendations to the user first. Work only on what does not need their answer.',
  wait: 'Then report where things stand in a few lines and wait for the user.',
}

// Snapshots are off unless the plugin setting or LAST_WORDS_SNAPSHOT turns them on.
async function snapshotsOn($: any): Promise<boolean> {
  const v = configured['snapshot']
  if (typeof v === 'boolean') return v
  const env = ((await $.env.get('LAST_WORDS_SNAPSHOT')) ?? '').trim().toLowerCase()
  if (env !== '') return ['1', 'true', 'on', 'yes'].includes(env)
  return (await fromProfile($, 'snapshot'))?.[0] === true
}

// Whether idle compactions are turned into a handoff request: the setting, else LAST_WORDS_IDLE_HANDOFF, else the
// profile, else on.
async function idleHandoffOn($: any): Promise<boolean> {
  const v = configured['idle_handoff']
  if (typeof v === 'boolean') return v
  const env = ((await $.env.get('LAST_WORDS_IDLE_HANDOFF')) ?? '').trim().toLowerCase()
  if (env !== '') return !['0', 'false', 'off', 'no'].includes(env)
  return (await fromProfile($, 'idle_handoff'))?.[0] !== false
}

// A compaction nobody in the session asked for, after a long quiet spell: Claude Code's idle timer.
async function isIdleCompaction($: any, s: HcState): Promise<{ idle: boolean; idleMs: number }> {
  const t = await read($, tu)
  const inbound = await read($, ib)
  const idleMs = (await $.clock.now()) - t.endedAt
  const idle = s.inflight === undefined && s.pending === undefined && !t.running && t.endedAt > 0 && inbound.at <= t.endedAt && idleMs >= IDLE_MIN_MS
  return { idle, idleMs }
}

// Calls off an idle compaction and asks Claude for a handoff instead, once per quiet spell.
// Returns the skip to answer with, or undefined to let the compaction run as usual.
async function interceptIdle($: any, s: HcState): Promise<{ skip: string } | undefined> {
  if (!(await idleHandoffOn($))) return undefined
  const { idle, idleMs } = await isIdleCompaction($, s)
  if (!idle) return undefined
  const inbound = await read($, ib)
  if (s.idleAskAt > 0 && inbound.at <= s.idleAskAt) {
    // Asked already in this quiet spell and Claude chose not to compact: respect that.
    await dbg($, 'idle compaction: already asked this spell; skipped')
    return { skip: 'last-words: idle compaction skipped; Claude already chose not to compact at this point.' }
  }
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const { cooldown } = await limits($)
  if (s.lastPostTokens >= 0 && tokens - s.lastPostTokens < cooldown) return undefined
  const now = await $.clock.now()
  await update($, st, v => ({ ...v, idleAskAt: now }))
  await dbg($, `idle compaction intercepted after ${Math.round(idleMs / 60_000)} min idle at ${tokens} tokens`)
  $.clock.after(300, () => void submitIdle($, idleMs))
  return { skip: 'last-words: idle compaction called off; asking Claude to write a handoff first.' }
}

async function submitIdle($: any, idleMs: number) {
  await note($, idleNote(idleMs))
  try {
    await $.prompt.submit({ text: IDLE_TEXT, asUser: true })
  } catch (err: any) {
    $.ui.log(`${PLUGIN}: could not submit the idle handoff prompt: ${String(err?.message ?? err)}`)
  }
}

// Where a resolved value came from, for /auto-compact status.
type Source = 'setting' | 'env' | 'project profile' | 'user profile' | 'default share'

type Limits = {
  /** The three nudge levels in tokens; null for a level the profile turned off. */
  nudges: (number | null)[]
  nudgeSources: Source[]
  cooldown: number
  cooldownSource: Source
  invalid: boolean
  subNudges: number[]
  subSources: Source[]
  subInvalid: boolean
  /** False when the profile says `subagents: off`: no subagent nudges, report notes or resume hold. */
  subagents: boolean
  threshold: number
  window: number
}

// Thousands of tokens from a userConfig field, or undefined when it is unset or not a positive number.
function configK(key: string): number | undefined {
  const v = configured[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : undefined
}

// Three comma-separated values in thousands of tokens, or undefined unless all three are positive numbers.
function envTriple(raw: string | undefined): number[] | undefined {
  const xs = (raw ?? '').split(',').map(x => Number(x.trim()) * 1000)
  return xs.length === 3 && xs.every(x => Number.isFinite(x) && x > 0) ? xs : undefined
}

function rises(xs: (number | null)[]): boolean {
  const on = xs.filter((x): x is number => x !== null)
  return on.every((x, i) => i === 0 || x > on[i - 1]!)
}

// A profile value with its source: the project profile, else the user profile.
async function fromProfile<K extends keyof StrategyProfile>($: any, key: K): Promise<[NonNullable<StrategyProfile[K]> | null, Source] | undefined> {
  const p = await profiles($)
  for (const [lp, src] of [[p.project, 'project profile'], [p.user, 'user profile']] as const) {
    const v = lp?.values[key]
    if (v !== undefined) return [v as NonNullable<StrategyProfile[K]> | null, src]
  }
  return undefined
}

// Each value comes from the plugin's settings, else the environment (absolute values the user set by hand), else the
// project profile, else the user profile (shares of the auto-compact threshold), else the default share of it.
async function limits($: any): Promise<Limits> {
  const w = await read($, wn)
  const T = w.threshold
  const env = envTriple(await $.env.get('LAST_WORDS_NUDGES_K'))
  const nudges: (number | null)[] = []
  const nudgeSources: Source[] = []
  for (let i = 0; i < 3; i++) {
    const c = configK(`nudge_${i + 1}_k`)
    const p = c === undefined && !env ? await fromProfile($, `nudge_${i + 1}` as 'nudge_1') : undefined
    if (c !== undefined) { nudges.push(c); nudgeSources.push('setting') }
    else if (env) { nudges.push(env[i]!); nudgeSources.push('env') }
    else if (p) { nudges.push(p[0] === null ? null : Math.round(p[0] * T)); nudgeSources.push(p[1]) }
    else { nudges.push(Math.round(DEFAULT_SHARES[i]! * T)); nudgeSources.push('default share') }
  }
  const rising = rises(nudges)
  const envCooldown = Number((await $.env.get('LAST_WORDS_COOLDOWN_K')) ?? '') * 1000
  let cooldown: number
  let cooldownSource: Source
  const cc = configK('cooldown_k')
  const pc = await fromProfile($, 'cooldown')
  if (cc !== undefined) { cooldown = cc; cooldownSource = 'setting' }
  else if (Number.isFinite(envCooldown) && envCooldown > 0) { cooldown = envCooldown; cooldownSource = 'env' }
  else if (pc && pc[0] !== null) { cooldown = Math.round(pc[0] * T); cooldownSource = pc[1] }
  else { cooldown = Math.round(DEFAULT_COOLDOWN_SHARE * T); cooldownSource = 'default share' }
  const subEnv = envTriple(await $.env.get('LAST_WORDS_SUB_NUDGES_K'))
  const subNudges: number[] = []
  const subSources: Source[] = []
  for (let i = 0; i < 3; i++) {
    const c = configK(`sub_nudge_${i + 1}_k`)
    const p = c === undefined && !subEnv ? await fromProfile($, `sub_nudge_${i + 1}` as 'sub_nudge_1') : undefined
    if (c !== undefined) { subNudges.push(c); subSources.push('setting') }
    else if (subEnv) { subNudges.push(subEnv[i]!); subSources.push('env') }
    else if (p && p[0] !== null) { subNudges.push(Math.round(p[0] * T)); subSources.push(p[1]) }
    else { subNudges.push(Math.round(DEFAULT_SUB_SHARES[i]! * T)); subSources.push('default share') }
  }
  const subRising = rises(subNudges)
  const subagents = (await fromProfile($, 'subagents'))?.[0] !== false
  return {
    nudges: rising ? nudges : DEFAULT_SHARES.map(x => Math.round(x * T)),
    nudgeSources: rising ? nudgeSources : ['default share', 'default share', 'default share'],
    cooldown,
    cooldownSource,
    invalid: !rising,
    subNudges: subRising ? subNudges : DEFAULT_SUB_SHARES.map(x => Math.round(x * T)),
    subSources: subRising ? subSources : ['default share', 'default share', 'default share'],
    subInvalid: !subRising,
    subagents,
    threshold: T,
    window: w.window,
  }
}

function levelsText(nudges: (number | null)[]): string {
  return nudges.map(t => (t === null ? 'off' : fmtK(t))).join(' / ')
}

// ---- The auto-compact threshold ----

// Reads the engine's auto-compact threshold from the context breakdown (the summary sends no request), which follows
// CLAUDE_CODE_AUTO_COMPACT_WINDOW where context.window does not; on failure keeps the 967k fallback and says why.
async function readWindow($: any): Promise<HcWindow> {
  const now = await $.clock.now()
  const model: string | undefined = await $.session.model().catch(() => undefined)
  let w: HcWindow
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    if (!b) throw new Error('the usage answer carried no breakdown')
    const raw = typeof b.rawMaxTokens === 'number' && b.rawMaxTokens > 0 ? b.rawMaxTokens : undefined
    const auto = typeof b.autoCompactThreshold === 'number' && b.autoCompactThreshold > 0 ? b.autoCompactThreshold : undefined
    const threshold = auto ?? (raw !== undefined && raw > AUTOCOMPACT_BUFFER ? raw - AUTOCOMPACT_BUFFER : undefined)
    if (threshold === undefined) throw new Error('the breakdown named no threshold or window')
    w = {
      threshold,
      window: raw ?? threshold + AUTOCOMPACT_BUFFER,
      source: 'breakdown',
      windowSource: `${String(b.autocompactSource)}${auto === undefined ? '; auto-compaction off, so the window minus 33k' : ''}`,
      ...(model ? { model } : {}),
      at: now,
    }
  } catch (err: any) {
    w = { ...NO_WINDOW, error: String(err?.message ?? err).slice(0, 200), ...(model ? { model } : {}), at: now }
    $.ui.log(`${PLUGIN}: could not read the auto-compact threshold (${w.error}); using ${fmtK(REFERENCE_THRESHOLD)}`)
  }
  await update($, wn, () => w)
  await dbg($, `window ${JSON.stringify(w)}`)
  return w
}

// A model switch changes the window: re-reads the threshold when the model id differs from the last reading's, and
// once more if the first reading failed; re-registers request_compaction when the threshold moved.
async function ensureWindow($: any) {
  const w = await read($, wn)
  const model: string | undefined = await $.session.model().catch(() => undefined)
  if ((model !== undefined && model !== w.model) || (w.source === 'fallback' && !windowRetried)) {
    windowRetried = true
    const nw = await readWindow($)
    if (nw.threshold !== w.threshold) await registerCompactionTool($).catch(() => undefined)
  }
}

// ---- Strategy profiles ----

const PROFILE_KEYS = ['template', 'nudge_1', 'nudge_2', 'nudge_3', 'cooldown', 'subagents', 'sub_nudge_1', 'sub_nudge_2', 'sub_nudge_3', 'resume_hold', 'reread_budget', 'handoff', 'after', 'idle_handoff', 'snapshot', 'snapshot_keep', 'approved'] as const
const PROFILE_HEADINGS = ['Moments', 'Not now', 'Handoff', 'After']
const PROFILE_BODY_MAX_LINES = 40

// The mod's own folder: LAST_WORDS_HOME, else ~/.claude/last-words.
async function lwHome($: any): Promise<string> {
  const o = ((await $.env.get('LAST_WORDS_HOME')) ?? '').trim()
  if (o.startsWith('/')) return o.replace(/\/+$/, '')
  return `${(await $.env.get('HOME')) ?? ''}/.claude/last-words`
}

// A share: a fraction above 0 and below 1, written as 0.41 or 41%.
function parseShare(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*(%)?$/.exec(v)
  if (!m) return undefined
  const n = m[2] ? Number(m[1]) / 100 : Number(m[1])
  return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined
}

function parseOnOff(v: string): boolean | undefined {
  const x = v.toLowerCase()
  return x === 'on' ? true : x === 'off' ? false : undefined
}

// Parses a strategy profile in the format the spec fixes: front matter between --- lines, one `key: value` scalar per
// line, then a body under 40 lines with the four headings. Returns the values and body, or every problem found.
function parseProfile(text: string): { values: StrategyProfile; body: string } | { errors: string[] } {
  const errors: string[] = []
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  if (lines[i]?.trim() !== '---') return { errors: ['it does not open with front matter (a --- line)'] }
  const close = lines.findIndex((l, j) => j > i && l.trim() === '---')
  if (close < 0) return { errors: ['its front matter has no closing --- line'] }
  const v: StrategyProfile = {}
  const seen = new Set<string>()
  for (const raw of lines.slice(i + 1, close)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line)
    if (!m) { errors.push(`front matter line "${line.slice(0, 60)}" is not key: value`); continue }
    const key = m[1]!
    const val = m[2]!.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) { errors.push(`unknown key ${key}`); continue }
    if (seen.has(key)) { errors.push(`${key} is set twice`); continue }
    seen.add(key)
    const bad = (what: string) => errors.push(`${key}: "${val.slice(0, 60)}" is not ${what}`)
    switch (key) {
      case 'template':
        if (val === '' || val.length > 80) bad('a template name'); else v.template = val
        break
      case 'nudge_1': case 'nudge_2': case 'nudge_3': {
        if (val.toLowerCase() === 'off') v[key] = null
        else { const n = parseShare(val); if (n === undefined) bad('a share between 0 and 1 (or off)'); else v[key] = n }
        break
      }
      case 'cooldown': case 'sub_nudge_1': case 'sub_nudge_2': case 'sub_nudge_3': case 'reread_budget': {
        const n = parseShare(val)
        if (n === undefined) bad('a share between 0 and 1'); else v[key] = n
        break
      }
      case 'subagents': case 'resume_hold': case 'idle_handoff': case 'snapshot': {
        const b = parseOnOff(val)
        if (b === undefined) bad('on or off'); else v[key] = b
        break
      }
      case 'handoff': {
        const repo = /^repo:(.+)$/.exec(val)
        if (val === 'mod') v.handoff = 'mod'
        else if (repo && !repo[1]!.trim().startsWith('/') && !repo[1]!.split('/').includes('..')) v.handoff = `repo:${repo[1]!.trim()}`
        else if (val.startsWith('/') && !val.split('/').includes('..')) v.handoff = val.replace(/\/+$/, '') || '/'
        else bad('repo:<path in the repo>, mod, or an absolute folder')
        break
      }
      case 'after':
        if (val === 'continue' || val === 'discuss' || val === 'wait') v.after = val; else bad('continue, discuss or wait')
        break
      case 'snapshot_keep': {
        const n = Number(val)
        if (val === '' || !Number.isInteger(n) || n < 0) bad('a whole number (0 keeps all)'); else v.snapshot_keep = n
        break
      }
      case 'approved':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) bad('a date (YYYY-MM-DD)'); else v.approved = val
        break
    }
  }
  if (v.template === undefined && !errors.some(e => e.startsWith('template'))) errors.push('template is missing')
  const nudges = [v.nudge_1, v.nudge_2, v.nudge_3].filter((x): x is number => typeof x === 'number')
  if (!rises(nudges)) errors.push('the nudge levels do not rise from nudge_1 to nudge_3')
  const subs = [v.sub_nudge_1, v.sub_nudge_2, v.sub_nudge_3].filter((x): x is number => typeof x === 'number')
  if (!rises(subs)) errors.push('the subagent levels do not rise from sub_nudge_1 to sub_nudge_3')
  const body = lines.slice(close + 1).join('\n').trim()
  const bodyLines = body === '' ? 0 : body.split('\n').length
  if (bodyLines >= PROFILE_BODY_MAX_LINES) errors.push(`the body has ${bodyLines} lines; keep it under ${PROFILE_BODY_MAX_LINES}`)
  for (const h of PROFILE_HEADINGS) {
    if (!new RegExp(`^##\\s+${h}\\s*$`, 'im').test(body)) errors.push(`the body has no "## ${h}" section`)
  }
  return errors.length ? { errors } : { values: v, body }
}

type Profiles = {
  key: string
  userPath: string
  projectPath: string
  user?: LoadedProfile
  project?: LoadedProfile
  /** Profiles that exist but were ignored, with why. */
  invalid: { path: string; errors: string[] }[]
}

// Resolved at session.start and after setup_save; lazily after a hot reload.
let profileCache: Profiles | undefined

async function loadProfile($: any, scope: 'user' | 'project', path: string, invalid: Profiles['invalid']): Promise<LoadedProfile | undefined> {
  if (!(await $.fs.exists(path))) return undefined
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (err: any) {
    invalid.push({ path, errors: [`it could not be read: ${String(err?.message ?? err).slice(0, 120)}`] })
    return undefined
  }
  const parsed = parseProfile(text)
  if ('errors' in parsed) {
    invalid.push({ path, errors: parsed.errors })
    $.ui.log(`${PLUGIN}: ignoring the strategy profile ${path}: ${parsed.errors.join('; ')}`)
    return undefined
  }
  return { scope, path, values: parsed.values, body: parsed.body }
}

async function profiles($: any, reload = false): Promise<Profiles> {
  if (profileCache && !reload) return profileCache
  const home = await lwHome($)
  const key = projectKey(await $.session.cwd())
  const userPath = `${home}/strategy/user.md`
  const projectPath = `${home}/strategy/projects/${key}.md`
  const invalid: Profiles['invalid'] = []
  const project = await loadProfile($, 'project', projectPath, invalid)
  const user = await loadProfile($, 'user', userPath, invalid)
  profileCache = { key, userPath, projectPath, ...(user ? { user } : {}), ...(project ? { project } : {}), invalid }
  await dbg($, `profiles key=${key} project=${project ? 'yes' : 'no'} user=${user ? 'yes' : 'no'} invalid=${invalid.length}`)
  return profileCache
}

// The profile whose body is the strategy in force: the project's, else the user's.
function strategyProfile(p: Profiles): LoadedProfile | undefined {
  return p.project ?? p.user
}

// Where the handoff lives under the profile, in words for the tool description and the strategy section.
async function handoffWords($: any): Promise<string | undefined> {
  const h = (await fromProfile($, 'handoff'))?.[0]
  if (typeof h !== 'string') return undefined
  if (h === 'mod') return `in the mod's folder: write it at ${await modHandoffPath($)} and pass handoff: "mod"`
  if (h.startsWith('repo:')) return `in the repo at ${h.slice(5)} (relative to the session folder)`
  return `in ${h}`
}

async function modHandoffPath($: any): Promise<string> {
  return `${await lwHome($)}/handoffs/${projectKey(await $.session.cwd())}/handoff.md`
}

async function defaultAfter($: any): Promise<AfterMode | undefined> {
  const a = (await fromProfile($, 'after'))?.[0]
  return a === 'continue' || a === 'discuss' || a === 'wait' ? a : undefined
}

// The strategy section of the main thread's system prompt: the profile's body, headed with its place in the order of
// precedence and the numbers in force.
async function strategySection($: any): Promise<string | undefined> {
  const p = await profiles($)
  const lp = strategyProfile(p)
  if (!lp) return undefined
  const lim = await limits($)
  const v = lp.values
  const facts = [
    `Nudge levels in force: ${levelsText(lim.nudges)} tokens; cooldown ${fmtK(lim.cooldown)} after a compaction (auto-compaction at ${fmtK(lim.threshold)}).`,
  ]
  const hw = await handoffWords($)
  if (hw) facts.push(`Handoff: ${hw}.`)
  const after = await defaultAfter($)
  if (after) facts.push(`Default after mode for request_compaction: ${after}.`)
  const rb = (await fromProfile($, 'reread_budget'))?.[0]
  if (typeof rb === 'number') facts.push(`Re-read budget: keep the files listed for re-reading after compaction, the handoff included, under about ${fmtK(rb * lim.window)} tokens.`)
  if (!lim.subagents) facts.push('Subagent context rules are off for this strategy.')
  const whose = lp.scope === 'project' ? `this project (${p.key})` : 'all of their projects'
  return [
    '# Compaction strategy (last-words)',
    `The user approved this compaction strategy for ${whose} through last-words setup${v.approved ? ` on ${v.approved}` : ''}${v.template ? ` (template: ${v.template})` : ''}; it is saved at ${lp.path}.`,
    `When deciding when and how to compact: the user's own words (in this conversation, CLAUDE.md and memory) come first, then this strategy, then the built-in moments of the skill ${SKILL}. The skill's principles and its "When not to compact" list hold under every strategy.`,
    facts.join(' '),
    '',
    lp.body,
  ].join('\n')
}

// ---- Subagents ----

// What a progress file holds: state only. The brief stays where it is (the mod's verbatim copy, or the brief file), and
// the progress file names it, so a fresh agent gets the exact brief rather than a paraphrase.
function progressFile(brief: string | undefined): string {
  const names = brief ? `its first line names your original brief, saved verbatim at ${brief} (do not copy or restate the brief in it)` : 'its first line names your brief file, if you were given one'
  return `a progress file holding state only: ${names}; then where the task stands, what you changed (files, commits), decisions you made and why, open threads, and what a fresh agent needs to carry on. Keep it in the repo, next to your brief file if you have one (else for example docs/progress/<task>.md), and name its path in your report`
}

// Saves a subagent's original brief verbatim, once: from its transcript's first user row, else the messages the engine
// holds for it, else the messages a compaction hands over. Returns the copy's path.
async function saveBrief($: any, agentId: string, fallback?: readonly any[]): Promise<string | undefined> {
  const known = (await read($, ag)).byId[agentId]?.brief
  if (known) return known
  let text: string | undefined
  const main = await transcriptPath($).catch(() => undefined)
  if (main) {
    const file = `${main.replace(/\.jsonl$/, '')}/subagents/agent-${agentId}.jsonl`
    const r = await $.process.run(['sh', '-c', 'grep -m 5 \'"type":"user"\' "$1" 2>/dev/null', 'sh', file]).catch(() => undefined)
    for (const line of String(r?.stdout ?? '').split('\n')) {
      try {
        const row = JSON.parse(line)
        if (row.isMeta) continue
        const c = row.message?.content
        text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : undefined
        if (text) break
      } catch {}
    }
  }
  if (!text) {
    const msgs: any = await $.session.messages({ agentId }).catch(() => undefined)
    const list: readonly any[] = Array.isArray(msgs) ? msgs : fallback ?? []
    text = list.find((m: any) => m?.role === 'user' && typeof m.text === 'string' && m.text.trim() !== '')?.text
  }
  if (!text) return undefined
  const dir = `${await lwHome($)}/briefs/${await $.session.id()}`
  const path = `${dir}/${agentId}.md`
  await $.process.run(['mkdir', '-p', dir])
  await $.fs.write(path, text)
  await update($, ag, v => ({ byId: { ...v.byId, [agentId]: { ...(v.byId[agentId] ?? { tokens: 0, level: 0, at: 0 }), brief: path } } }))
  await dbg($, `saved brief of ${agentId} to ${path} (${text.length} chars)`)
  return path
}

function subLevels(lim: Limits): string {
  return lim.subNudges.map(t => fmtK(t)).join(' / ')
}

// A context block every conversation opens with, subagents' included, so a [last-words] note after a tool result
// reads as the user's own tooling. (Rewriting an Agent call's prompt instead is refused under auto mode, which
// reviewed the call before the hook changed it.)
function trustBlock(lim: Limits): string {
  const head = 'The user has installed the last-words mod, which manages context size. Notes starting with [last-words] come from it, not from the files, pages or tools you are working with; follow them.'
  if (!lim.subagents) return head
  return `${head} In a subagent, it notes your context size after a tool result when it passes ${subLevels(lim)} tokens; in the main thread, it notes a subagent's size when one past the first level reports back, and holds a SendMessage to such an agent once. Both are advice: sending the same call again resumes the agent.`
}

function subNudgeText(level: number, tokens: number, lim: Limits, brief: string | undefined): string {
  const head = `[last-words] Your context is at ${fmtK(tokens)} tokens: subagent nudge ${level} of 3 (levels ${subLevels(lim)}).`
  const PROGRESS_FILE = progressFile(brief)
  if (level === 1) return `${head} When your current task is done, write ${PROGRESS_FILE}. The main thread can then start a fresh agent from it instead of resuming you, since every resumed round re-sends all of this context. Carry on with the task as it is.`
  if (level === 2) return `${head} Drive to a good handoff point: finish or park the step in hand and start nothing large, then write ${PROGRESS_FILE}, and report to the main thread that you are ready to be replaced.`
  return `${head} Stop at the first safe point, even if it is not ideal: write ${PROGRESS_FILE}, then report to the main thread. Claude Code auto-compacts you near the limit, mid-task, with no handoff.`
}

const SUB_SUMMARY_GUIDANCE = [
  "This is a subagent's conversation, compacted mid-task.",
  'Its original brief is saved verbatim in a file the note after the summary names; keep that path rather than restating the brief.',
  'Keep verbatim: the main thread\'s latest instructions, the path of any progress file it wrote, the files it changed, the step in hand and what remains.',
  'Do not tell it to continue without re-reading; the note after the summary says what to re-read.',
].join(' ')

function subReentryNote(before: number | undefined, after: number | undefined, brief: string | undefined): string {
  const b = brief ? `your original brief, saved verbatim at ${brief}` : 'your brief, if it is a file'
  return `[last-words] Your context was just auto-compacted (${fmtK(before)} → ${fmtK(after)} tokens). Before going on, re-read ${b}, and your progress file if you wrote one, then carry on from where they say. If you have no progress file, write one at the next finished step.`
}

// A subagent's request just answered: record its size and queue a nudge for its next tool result when it crossed a level.
async function readSubStep($: any, agentId: string, usage: any) {
  const tokens = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)
  if (tokens <= 0) return
  const now = await $.clock.now()
  const all = await read($, ag)
  const prev = all.byId[agentId] ?? { tokens: 0, level: 0, at: 0 }
  await update($, ag, v => ({ byId: { ...v.byId, [agentId]: { ...(v.byId[agentId] ?? prev), tokens, at: now } } }))
  const lim = await limits($)
  if (!lim.subagents) return
  const level = lim.subNudges.filter(t => tokens >= t).length
  if (level > prev.level && (pendingSub.get(agentId) ?? 0) < level) {
    await saveBrief($, agentId).catch((err: any) => $.ui.log(`${PLUGIN}: saving a subagent's brief failed: ${String(err?.message ?? err)}`))
    pendingSub.set(agentId, level)
  }
}

// Attaches a queued subagent nudge to the result the agent is about to read.
async function deliverSubNudge($: any, agentId: string, res: any): Promise<any> {
  const level = pendingSub.get(agentId)
  if (level === undefined || res?.deny !== undefined) return res
  pendingSub.delete(agentId)
  const a = (await read($, ag)).byId[agentId]
  if (!a || a.level >= level) return res
  await update($, ag, v => ({ byId: { ...v.byId, [agentId]: { ...v.byId[agentId]!, level } } }))
  await dbg($, `subagent ${agentId} nudge ${level} at ${a.tokens}`)
  return { ...res, context: [...(res.context ?? []), subNudgeText(level, a.tokens, await limits($), a.brief)] }
}

// Subagents that finished a round past the first level, by id: their size, waiting to ride on the report's arrival.
const pendingReport = new Map<string, number>()
// SendMessage holds: the agent's size when its resume was last held, so the same call sent again goes through.
const heldAt = new Map<string, number>()

async function resumeHold($: any): Promise<{ on: boolean; at: number }> {
  const lim = await limits($)
  const v = configured['resume_hold']
  const env = ((await $.env.get('LAST_WORDS_RESUME_HOLD')) ?? '').trim().toLowerCase()
  const on = !lim.subagents ? false : typeof v === 'boolean' ? v : env !== '' ? !['0', 'false', 'off', 'no'].includes(env) : (await fromProfile($, 'resume_hold'))?.[0] !== false
  const envK = Number((await $.env.get('LAST_WORDS_RESUME_HOLD_K')) ?? '') * 1000
  const at = configK('resume_hold_k') ?? (Number.isFinite(envK) && envK > 0 ? envK : lim.subNudges[0]!)
  return { on, at }
}

// Advisory, never forcing: both choices stay open, and the reasons for each are named.
function choice(brief: string | undefined): string {
  const b = brief ? `its original brief, saved verbatim at ${brief}` : 'its original brief file'
  return `For a new round of work, a fresh agent starts light: brief it with ${b} (unchanged; do not retype it), its progress file (its report names one, if it wrote it), and the new instruction. Resuming it is the right call when you want its full context: asking about its report, or recovering something from its work.`
}

function reportNote(entries: [string, number, string | undefined][], lim: Limits): string {
  return entries.map(([id, t, brief]) => `[last-words] Subagent ${id} reported back at ${fmtK(t)} tokens, past the first subagent level (${fmtK(lim.subNudges[0])}). Resuming it re-sends that whole context every round. ${choice(brief)}`).join('\n')
}

// Takes the waiting report notes, for one agent or all.
async function takeReports($: any, only?: string): Promise<string | undefined> {
  const entries = [...pendingReport.entries()].filter(([id]) => only === undefined || id === only)
  if (entries.length === 0) return undefined
  for (const [id] of entries) pendingReport.delete(id)
  await dbg($, `report note for ${entries.map(([id, t]) => `${id}=${t}`).join(', ')}`)
  const byId = (await read($, ag)).byId
  return reportNote(entries.map(([id, t]) => [id, t, byId[id]?.brief]), await limits($))
}

// The main thread is about to resume a big subagent: hold the call once, advisory; the same call sent again goes through.
async function holdResume($: any, e: any): Promise<{ deny: string } | undefined> {
  if (typeof e.to !== 'string') return undefined
  const a = (await read($, ag)).byId[e.to]
  const hold = await resumeHold($)
  if (!hold.on || !a || a.tokens < hold.at) return undefined
  if (heldAt.get(e.to) === a.tokens) {
    heldAt.delete(e.to)
    return undefined
  }
  heldAt.set(e.to, a.tokens)
  await dbg($, `held resume of ${e.to} at ${a.tokens}`)
  return { deny: `[last-words] Not sent yet: held once, as advice only. Agent ${e.to} is at ${fmtK(a.tokens)} tokens, and resuming it re-sends that whole context every round. ${choice(a.brief)} To resume it, send the same call again; it goes through.` }
}

const debugLines: string[] = []

async function dbg($: any, msg: string) {
  const path = await $.env.get('LAST_WORDS_DEBUG_LOG')
  if (!path) return
  debugLines.push(`${new Date().toISOString()} ${msg}`)
  await $.fs.write(path, debugLines.join('\n') + '\n')
}

function arrivalWords(kind: string | undefined): string {
  switch (kind) {
    case 'task-notification': return 'a background task notification'
    case 'peer': return 'a message from another session'
    case 'scheduled-trigger': return 'a scheduled prompt'
    case 'composer': case 'bridge': case 'sdk': case undefined: return 'a user message'
    default: return `a ${kind} message`
  }
}

function fmtK(tokens: number | undefined): string {
  return tokens === undefined ? '?' : `${Math.round(tokens / 1000)}k`
}

function absPath(path: string, cwd: string): string {
  return path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
}

function rereadLines(req: CompactionRequest): string {
  return readList(req).map((r, i) => `${i + 1}. ${r.path} (${r.scope === 'full' ? 'in full' : r.scope})${r.why ? ` — ${r.why}` : ''}`).join('\n')
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'under a minute'
  if (m < 90) return `${m} min`
  const h = Math.round(m / 60)
  return h < 36 ? `${h} h` : `${Math.round(h / 24)} days`
}

// Facts read from disk at compaction time, so Claude can check the handoff against them on re-entry.
async function stateLines($: any, req: CompactionRequest | undefined, own: boolean): Promise<string> {
  const lines: string[] = []
  if (req) {
    const stat = await $.fs.stat(req.handoff, { resolve: true }).catch(() => undefined)
    if (stat) {
      const age = ago((await $.clock.now()) - stat.mtimeMs)
      lines.push(own
        ? `The handoff was last written ${age} before this compaction.`
        : `The handoff on record (${req.handoff}) was last written ${age} before this compaction, which you did not request; work since then is only in the summary, so where the two differ the summary is newer.`)
    }
  }
  const cwd = await $.session.cwd()
  const git = await $.process.run(['sh', '-c', 'cd "$1" && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; b=$(git rev-parse --abbrev-ref HEAD); h=$(git log -1 --format="%h %s" 2>/dev/null | cut -c1-90); d=$(git status --porcelain | wc -l | tr -d " "); printf "%s\t%s\t%s" "$b" "$h" "$d"', 'sh', cwd], { timeoutMs: 20_000 }).catch(() => undefined)
  if (git && git.exitCode === 0) {
    const [branch, head, dirty] = git.stdout.split('\t')
    lines.push(`Repo state at compaction (${cwd}): branch ${branch}${head ? `, HEAD ${head}` : ', no commits yet'}, ${dirty} uncommitted file${dirty === '1' ? '' : 's'}. Check the handoff against this; where they disagree, the repo is right.`)
  }
  return lines.join('\n')
}

// Whether a Read or Bash call opens `file`: Read by its path; Bash by the full path, or by the file name with its folder
// also named (as in `cd <folder> && sed -n … <name>`).
function opens(tool: string, e: any, file: string, cwd: string): boolean {
  if (tool === 'Read') return typeof e.file_path === 'string' && absPath(e.file_path, cwd) === file
  if (tool !== 'Bash' || typeof e.command !== 'string') return false
  const cmd: string = e.command
  if (cmd.includes(file)) return true
  const slash = file.lastIndexOf('/')
  const name = file.slice(slash + 1)
  const dir = file.slice(0, slash)
  return name !== '' && cmd.includes(name) && (cmd.includes(dir) || (cwd === dir && !cmd.includes('/' + name)))
}

function readList(req: CompactionRequest): RereadItem[] {
  return [{ path: req.handoff, scope: 'full', why: 'the handoff' }, ...req.reread]
}

async function armReads($: any, req: CompactionRequest | undefined) {
  if (!req) return
  await update($, rd, () => ({ armed: true, started: false, files: readList(req).map(r => ({ ...r, read: false })) }))
}

// After the first turn that follows a compaction, names the listed files Claude has not opened; once only.
async function checkReads($: any, aborted: boolean) {
  const r = await read($, rd)
  if (!r.armed || !r.started) return
  await update($, rd, () => NO_READS)
  const missing = r.files.filter(f => !f.read)
  await dbg($, `reading check: ${r.files.length - missing.length}/${r.files.length} read${missing.length ? `; missing ${missing.map(f => f.path).join(', ')}` : ''}`)
  if (missing.length === 0 || aborted) return
  const list = missing.map((f, i) => `${i + 1}. ${f.path} (${f.scope === 'full' ? 'in full' : f.scope})${f.why ? ` — ${f.why}` : ''}`).join('\n')
  const text = `[last-words] The re-entry note asked you to read every listed file before anything else. You have not opened these yet:\n${list}\n\nRead them now, each with the Read tool at its scope (a copy restored into context does not count), then carry on with what you were doing.`
  $.clock.after(300, async () => {
    try {
      await $.prompt.submit({ text, asUser: true })
    } catch (err: any) {
      $.ui.log(`${PLUGIN}: could not submit the reading reminder: ${String(err?.message ?? err)}`)
    }
  })
}

function reentryNote(req: CompactionRequest | undefined, n: number, before: number | undefined, after: number | undefined, snapshot: string | undefined, state: string): string {
  const head = `[last-words] This conversation was just compacted (compaction ${n}, ${fmtK(before)} → ${fmtK(after)} tokens).`
  const snap = snapshot ? `The full pre-compaction transcript is archived as session ${snapshot} (claude --resume ${snapshot}); you can grep it for anything the summary and files lack.` : ''
  const rules = [
    'Re-read before acting on anything that arrives, including subagent notifications; results that arrive meanwhile wait until you have re-read.',
    'Ask the user again any open questions the handoff lists. Treat items marked "proposal" as proposals, not decisions.',
    'Respect any pause or blocking review gate the handoff records: work up to it, then wait for the user\'s approval.',
  ].join(' ')
  if (!req) {
    return [head, 'No handoff request was recorded for this compaction. Re-read the handoff and plan files you were working from (in full for the handoff), then continue as they say.', state, rules, snap].filter(Boolean).join('\n\n')
  }
  return [
    head,
    `First re-read these files:\n${rereadLines(req)}`,
    `Read all ${req.reread.length + 1} files above, each with the Read tool at its scope, before anything else, even where a copy appears above in this context. The next steps start only after the last one, even if they name fewer files. The mod checks this when your turn ends.`,
    `Next steps: ${req.next}`,
    AFTER_TEXT[req.after],
    state,
    rules,
    snap,
  ].filter(Boolean).join('\n\n')
}

async function status($: any, tokens?: number) {
  const s = await read($, st)
  if (!s.enabled) return $.ui.status('auto-compact off')
  const parts = [`ctx ${fmtK(tokens)}`]
  if (s.nudgeLevel > 0) parts.push(`nudge ${s.nudgeLevel}/3`)
  if (s.pending) parts.push('compaction queued')
  else if (s.compactions > 0) parts.push(`${s.compactions} compacted`)
  const w = await read($, wn)
  if (w.source === 'fallback' && w.at > 0) parts.push(`threshold unread, using ${fmtK(w.threshold)}`)
  if (profileCache && profileCache.invalid.length > 0) parts.push('strategy profile ignored (see /auto-compact status)')
  $.ui.status(parts.join(' · '))
}

async function note($: any, text: string) {
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    await dbg($, `append ${JSON.stringify(r).slice(0, 200)} :: ${text.slice(0, 80)}`)
  } catch (err: any) {
    $.ui.log(`${PLUGIN}: could not append a note: ${String(err?.message ?? err)}`)
  }
}

async function validate($: any, input: any): Promise<{ deny: string } | { req: CompactionRequest }> {
  const s = await read($, st)
  if (!s.enabled) return { deny: 'Auto-compact is off for this session (/auto-compact on to turn it on).' }
  const cwd = await $.session.cwd()
  if (typeof input.handoff !== 'string' || input.handoff === '') return { deny: 'handoff is required.' }
  // "mod" names the mod-owned handoff of this project, which a strategy profile may choose (handoff: mod).
  const isMod = input.handoff.trim() === 'mod'
  const handoff = isMod ? await modHandoffPath($) : absPath(input.handoff, cwd)
  const stat = await $.fs.stat(handoff, { resolve: true }).catch(() => undefined)
  if (!stat || stat.kind !== 'file') return { deny: isMod ? `The mod's handoff file ${handoff} does not exist yet. Write it there with the Write tool, then call again.` : `The handoff file ${handoff} does not exist.` }
  const real = stat.realPath ?? handoff
  if (!isMod && TEMP_DIRS.some(d => real.startsWith(d))) {
    return { deny: `The handoff ${real} is in a temporary folder, which gets deleted. Keep it in the repo (for example docs/handoff.md).` }
  }
  const inbound = await read($, ib)
  if (stat.mtimeMs <= inbound.at) {
    const what = inbound.what ? ` (${inbound.what})` : ''
    return { deny: `The handoff was last modified before the latest arrival${what}. Fold it into the handoff, then call again.` }
  }
  const reread: RereadItem[] = []
  for (const r of Array.isArray(input.reread) ? input.reread : []) {
    if (typeof r?.path !== 'string') return { deny: 'Each reread item needs a path.' }
    const p = absPath(r.path, cwd)
    if (!(await $.fs.exists(p))) return { deny: `Re-read file ${p} does not exist.` }
    // The handoff is always read first, in full; listing it again would only repeat it.
    if (p === handoff || p === real) continue
    reread.push({ path: p, scope: typeof r.scope === 'string' && r.scope !== '' ? r.scope : 'full', ...(typeof r.why === 'string' ? { why: r.why } : {}) })
  }
  const after: AfterMode = input.after === 'discuss' || input.after === 'wait' ? input.after : 'continue'
  if (typeof input.next !== 'string' || input.next.trim() === '') return { deny: 'next is required: the first steps after re-reading.' }
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const { cooldown } = await limits($)
  const base = s.lastPostTokens < 0 ? tokens : s.lastPostTokens
  if (tokens - base < cooldown) {
    return { deny: `Only ${fmtK(tokens - base)} tokens since the last compaction (minimum ${fmtK(cooldown)}); not worth compacting yet.` }
  }
  return {
    req: {
      handoff: real,
      reread,
      after,
      next: input.next.trim(),
      ...(typeof input.focus === 'string' && input.focus.trim() !== '' ? { focus: input.focus.trim() } : {}),
      at: await $.clock.now(),
    },
  }
}

async function transcriptPath($: any): Promise<string | undefined> {
  const s = await read($, st)
  const id = await $.session.id()
  if (s.transcriptPath && s.transcriptPath.endsWith(`/${id}.jsonl`) && (await $.fs.exists(s.transcriptPath))) return s.transcriptPath
  const home = (await $.env.get('HOME')) ?? ''
  const found = await $.process.run(['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`])
  const path = found.stdout.trim().split('\n')[0]
  if (!path) return undefined
  await update($, st, v => ({ ...v, transcriptPath: path }))
  return path
}

async function snapshot($: any, n: number, tokens: number | undefined, req: CompactionRequest | undefined): Promise<string | undefined> {
  const src = await transcriptPath($)
  if (!src) {
    $.ui.log(`${PLUGIN}: transcript not found; no snapshot taken`)
    return undefined
  }
  const id = await $.session.id()
  const snapId = crypto.randomUUID()
  const dst = src.replace(`${id}.jsonl`, `${snapId}.jsonl`)
  // APFS clone on macOS, reflink where the filesystem has one (Btrfs, XFS), else a plain copy.
  const cp = await $.process.run(['sh', '-c', 'cp -c "$1" "$2" 2>/dev/null || cp --reflink=auto "$1" "$2" 2>/dev/null || cp "$1" "$2"', 'sh', src, dst], { timeoutMs: 300_000 })
  if (cp.exitCode !== 0) {
    $.ui.log(`${PLUGIN}: snapshot copy failed: ${cp.stderr.trim()}`)
    return undefined
  }
  const t = await $.process.run(['sh', '-c', `grep -o '"customTitle":"[^"]*"' "$1" | tail -1 | cut -d'"' -f4`, 'sh', src], { timeoutMs: 120_000 })
  const base = t.stdout.trim() || 'session'
  const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16)
  const title = `${base} · pre-compact ${n} · ${stamp} · ${fmtK(tokens)}`
  const row = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: snapId })
  await $.process.run(['sh', '-c', `printf '%s\\n' "$1" >> "$2"`, 'sh', row, dst])
  const home = (await $.env.get('HOME')) ?? ''
  const dir = `${await lwHome($)}/snapshots/${snapId}`
  const files = req ? [req.handoff, ...req.reread.map(r => r.path)] : []
  await $.fs.write(`${dir}/manifest.json`, JSON.stringify({ session: id, snapshot: snapId, title, transcript: dst, request: req, files }, null, 2))
  for (const [i, f] of files.entries()) {
    const name = `${String(i).padStart(2, '0')}-${f.split('/').pop()}`
    await $.process.run(['cp', f, `${dir}/${name}`]).catch(() => undefined)
  }
  await prune($, id, home, await lwHome($)).catch((err: any) => $.ui.log(`${PLUGIN}: snapshot pruning failed: ${String(err?.message ?? err)}`))
  return snapId
}

// How many snapshots to keep per session: the setting, else LAST_WORDS_SNAPSHOT_KEEP, else the profile, else 10;
// 0 keeps all.
async function snapshotKeep($: any): Promise<number> {
  const v = configured['snapshot_keep']
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  const raw = ((await $.env.get('LAST_WORDS_SNAPSHOT_KEEP')) ?? '').trim()
  const env = raw === '' ? NaN : Number(raw)
  if (Number.isInteger(env) && env >= 0) return env
  const p = (await fromProfile($, 'snapshot_keep'))?.[0]
  return typeof p === 'number' ? p : DEFAULT_SNAPSHOT_KEEP
}

// Deletes this session's oldest snapshots beyond the limit: the transcript copy and its folder of file copies.
async function prune($: any, session: string, home: string, lw: string) {
  const keep = await snapshotKeep($)
  if (keep === 0) return
  const root = `${lw}/snapshots`
  const list = await $.process.run(['sh', '-c', 'ls -1t "$1"/*/manifest.json 2>/dev/null | xargs grep -lF -- "$2" 2>/dev/null', 'sh', root, `"session": "${session}"`])
  const manifests = list.stdout.split('\n').filter(Boolean)
  for (const m of manifests.slice(keep)) {
    const info = JSON.parse(await $.fs.read(m)) as { snapshot?: string; transcript?: string }
    const snap = info.snapshot
    if (!snap || !/^[0-9a-f-]{36}$/.test(snap)) continue
    const t = info.transcript
    if (t && t.startsWith(`${home}/.claude/projects/`) && t.endsWith(`/${snap}.jsonl`)) await $.process.run(['rm', '-f', t])
    await $.process.run(['rm', '-rf', `${root}/${snap}`])
    await update($, st, v => ({ ...v, snapshots: v.snapshots.filter(x => x !== snap) }))
    await dbg($, `pruned snapshot ${snap}`)
  }
}

async function submitResume($: any, noteText: string, req: CompactionRequest | undefined) {
  await note($, noteText)
  await armReads($, req)
  try {
    await $.prompt.submit({ text: RESUME_TEXT, asUser: true })
  } catch (err: any) {
    $.ui.log(`${PLUGIN}: could not submit the resume prompt: ${String(err?.message ?? err)}`)
  }
}

async function submitDeferred($: any, what: string) {
  const text = `[last-words] Compaction was deferred: ${what} arrived after you requested it. Handle it, fold it into the handoff, then call request_compaction again; if it changes the plan, carry on instead.`
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (err: any) {
    $.ui.log(`${PLUGIN}: could not submit the deferral prompt: ${String(err?.message ?? err)}`)
  }
}

async function runCompact($: any) {
  try {
    await $.command.run({ command: 'compact', args: COMPACT_LABEL })
  } catch (err: any) {
    await update($, st, v => ({ ...v, inflight: undefined }))
    $.ui.toast(`${PLUGIN}: compaction could not start: ${String(err?.message ?? err).slice(0, 120)}`)
    await note($, `[last-words] Your compaction request could not run (${String(err?.message ?? err).slice(0, 200)}). Carry on; request again later.`)
  }
}

async function nudge($: any, tokens: number) {
  const s = await read($, st)
  if (!s.enabled || s.pending || s.inflight) return
  const { nudges, cooldown } = await limits($)
  if (s.lastPostTokens < 0 || tokens - s.lastPostTokens < cooldown) return
  // The highest level crossed; a level the profile turned off is never crossed.
  const level = nudges.reduce<number>((lv, t, i) => (t !== null && tokens >= t ? i + 1 : lv), 0)
  if (level <= s.nudgeLevel) return
  await update($, st, v => ({ ...v, nudgeLevel: level }))
  const k = fmtK(tokens)
  const which = ['first', 'second', 'third'][level - 1] ?? 'third'
  const head = `[last-words] Context is at ${k} tokens: the ${which} of three nudges (levels ${levelsText(nudges)}).`
  const texts = [
    `${head} Load the skill ${SKILL} if it is not loaded. At the next natural handoff point (previous wave reviewed and landed and the current wave briefed and started, or a phase closed), prepare the handoff and call request_compaction. Do not force one yet.`,
    `${head} Drive to a handoff point now: delegate remaining reviews and follow-ups, draft the briefs the next waves need while you have the full context, rewrite the handoff, then call request_compaction.`,
    `${head} The engine auto-compacts near the limit with no handoff. Compact at the first safe point, even if it is not ideal: rewrite the handoff and call request_compaction.`,
  ]
  await note($, texts[level - 1] ?? texts[2]!)
  if (level >= 3) {
    $.ui.toast(`Context at ${k}: Claude has been told to compact at the first safe point.`)
    void $.ui.notify(`Context at ${k}: Claude will compact at the first safe point.`, { title: 'last-words' })
  }
}

function sourced(t: number | null, src: Source): string {
  return `${t === null ? 'off' : fmtK(t)} (${src})`
}

async function statusText($: any): Promise<string> {
  await ensureWindow($).catch(() => undefined)
  const s = await read($, st)
  const tokens = (await $.session.usage()).context.tokens
  const lim = await limits($)
  const w = await read($, wn)
  const p = await profiles($)
  const lines = [
    `auto-compact: ${s.enabled ? 'on' : 'off'} · context ${fmtK(tokens)} · compactions by this mod's session: ${s.compactions}`,
  ]
  const lp = strategyProfile(p)
  if (lp) {
    lines.push(`strategy in force: ${lp.path} (${lp.scope} profile, template ${lp.values.template ?? '?'}, approved ${lp.values.approved ?? 'date not recorded'})${lp.scope === 'project' && p.user ? `; the user profile ${p.user.path} fills values the project profile leaves out` : ''}`)
  } else {
    const rec = await setupRecord($)
    const how = !rec ? 'not offered yet' : rec.declined ? `declined ${rec.at.slice(0, 10)}` : rec.done ? `a profile was saved ${rec.at.slice(0, 10)} for another scope (${rec.path ?? '?'})` : `offered ${rec.at.slice(0, 10)}`
    lines.push(`strategy: not set up for this project (${p.key}; ${how}); /last-words setup tailors one`)
  }
  for (const bad of p.invalid) lines.push(`ignored profile ${bad.path}: ${bad.errors.join('; ')}`)
  lines.push(w.source === 'breakdown'
    ? `auto-compact threshold: ${fmtK(w.threshold)} (read from the context breakdown${w.model ? ` for ${w.model}` : ''}; window ${fmtK(w.window)}, ${w.windowSource ?? '?'})`
    : `auto-compact threshold: ${fmtK(w.threshold)}, the fallback: ${w.at === 0 ? 'not read yet' : `the context breakdown could not be read (${w.error ?? 'unknown error'})`}`)
  lines.push(`nudges at ${lim.nudges.map((t, i) => sourced(t, lim.nudgeSources[i]!)).join(' / ')} (sent up to level ${s.nudgeLevel}); cooldown ${sourced(lim.cooldown, lim.cooldownSource)} since the last compaction (${fmtK(s.lastPostTokens)} after it)`)
  const over = lim.nudges.filter((t): t is number => t !== null && t >= lim.threshold)
  if (over.length) lines.push(`warning: nudge level${over.length > 1 ? 's' : ''} ${over.map(t => fmtK(t)).join(', ')} at or above the auto-compact threshold (${fmtK(lim.threshold)}) never fire before Claude Code compacts on its own`)
  const keep = await snapshotKeep($)
  lines.push(`idle compaction: ${(await idleHandoffOn($)) ? 'turned into a handoff request' : 'left to Claude Code'}`)
  lines.push(`pre-compact snapshots: ${(await snapshotsOn($)) ? `on, keeping ${keep === 0 ? 'all' : `the last ${keep}`} per session` : 'off'}`)
  if (lim.invalid) lines.push('the configured nudge levels do not rise from first to third, so the default shares are in use')
  if (lim.subagents) {
    const hold = await resumeHold($)
    lines.push(`subagent nudges at ${lim.subNudges.map((t, i) => sourced(t, lim.subSources[i]!)).join(' / ')}${lim.subInvalid ? ' (the configured subagent levels do not rise, so the default shares are in use)' : ''}; resume hold ${hold.on ? `on from ${fmtK(hold.at)}` : 'off'}`)
  } else {
    lines.push('subagent nudges, report notes and the resume hold: off (strategy profile)')
  }
  const big = lim.subagents ? Object.entries((await read($, ag)).byId).filter(([, a]) => a.tokens >= lim.subNudges[0]!) : []
  if (big.length) lines.push(`subagents past the first level: ${big.map(([id, a]) => `${id} ${fmtK(a.tokens)} (nudge ${a.level})`).join(', ')}`)
  if (s.pending) lines.push(`queued: handoff ${s.pending.handoff}, after=${s.pending.after}`)
  if (s.lastRequest) lines.push(`last handoff: ${s.lastRequest.handoff}`)
  if (s.snapshots.length) lines.push(`snapshots (claude --resume <id>): ${s.snapshots.join(', ')}`)
  return lines.join('\n')
}

// ---- Setup: the first-session offer, the setup tools and /last-words ----

async function setupRecord($: any): Promise<SetupRecord | undefined> {
  const r = await $.store.get('setup').catch(() => undefined)
  return r && typeof r === 'object' && typeof (r as SetupRecord).at === 'string' ? (r as SetupRecord) : undefined
}

async function writeSetupRecord($: any, rec: Omit<SetupRecord, 'at'>) {
  await $.store.set('setup', { at: new Date().toISOString(), ...rec })
}

// Wording as probed (probe 4): a hidden row appended at session.start made the offer after the task in 5 of 5 runs.
const OFFER_LINE = "last-words: want compaction tailored to how you work? /last-words setup starts it (it asks before reading anything); /last-words setup decline stops this offer."

// Once per install: with no setup record and no profile, record the offer, raise a toast and leave Claude a hidden note.
async function maybeOffer($: any) {
  if (await setupRecord($)) return
  const p = await profiles($)
  if (p.user || p.project || p.invalid.length > 0) return
  // A plugin update or /reload-plugins re-runs session.start in sessions already at work, and a resumed session has
  // turns too: offer only in a conversation with none yet, and leave the record unwritten otherwise.
  const turns = await Promise.resolve($.session.turns()).catch(() => 0)
  if (turns > 0) {
    await dbg($, `setup offer skipped: the conversation already has ${turns} turns`)
    return
  }
  // The mod shows the offer itself, as a transcript line after the first reply: a note asking Claude to make it was
  // dropped in the terminal (a row appended before the first message) or ignored (context on the first prompt).
  offerPending = true
  $.ui.toast('last-words: /last-words setup tailors compaction to how you work.', { timeoutMs: 10_000 })
  await dbg($, 'setup offer pending for the first reply')
}

// Set at session.start in a conversation with no turns; shown when the first main-thread turn ends.
let offerPending = false

async function showOffer($: any) {
  if (!offerPending) return
  offerPending = false
  if (await setupRecord($)) return
  await writeSetupRecord($, { via: 'offer' })
  $.ui.log(OFFER_LINE)
  await dbg($, 'setup offered')
}

const SETUP_PROMPT = `Set up last-words (Claude-managed compaction) for me: load the skill ${SETUP_SKILL} and follow it from the start. (Sent by /last-words setup.)`

async function projectsRoot($: any): Promise<string> {
  const o = ((await $.env.get('LAST_WORDS_PROJECTS_DIR')) ?? '').trim()
  return o.startsWith('/') ? o.replace(/\/+$/, '') : `${(await $.env.get('HOME')) ?? ''}/.claude/projects`
}

// A project named by its key, or by its folder (turned into the key).
function asKey(x: string): string {
  const t = x.trim()
  return t.includes('/') ? projectKey(t) : t
}

const KEY_RE = /^[A-Za-z0-9-]{1,240}$/

// Runs long work (a scan of every transcript) inside a tool call. The hook budget stands still while a `$` call is in
// flight, but not while the scan's parser runs between its reads; keeping a cheap `$` wait in flight beside the work
// keeps a long scan from overrunning the budget.
async function long<T>($: any, work: Promise<T>): Promise<T> {
  let done = false
  work.then(() => { done = true }, () => { done = true })
  while (!done) await Promise.race([work.catch(() => undefined), $.process.run(['sleep', '1']).catch(() => undefined)])
  return work
}

function errText(err: any): string {
  return String(err?.message ?? err).slice(0, 300)
}

const MAIN_ONLY = 'The setup tools are for the main thread only; a subagent reads the sample files it is given.'

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    projects: { type: 'array', items: { type: 'string' }, description: 'Project keys (as a previous digest lists them) or project folders to limit the scan to; all projects when absent.' },
    since: { type: 'string', description: 'Only sessions active on or after this date (YYYY-MM-DD); all when absent.' },
  },
}
const SCAN_DESCRIPTION = [
  'last-words setup: scan this user\'s Claude Code transcripts locally and return a per-project digest: key, folder, sessions, size, last active, and a tentative work type with the features behind it.',
  'It reads tool names, sizes, timestamps and slash commands, never message text, and writes a features file under ~/.claude/last-words/setup/.',
  `Main thread only. Call it only after the user agreed to the scan in this session, as the skill ${SETUP_SKILL} describes.`,
].join(' ')

const SAMPLE_SCHEMA = {
  type: 'object',
  properties: {
    projects: { type: 'array', items: { type: 'string' }, description: 'Project keys (from the digest) or folders the user put in scope.' },
    budget_tokens: { type: 'number', description: 'Token budget per project for the sampled messages.' },
  },
  required: ['projects', 'budget_tokens'],
}
const SAMPLE_DESCRIPTION = [
  'last-words setup: extract sampled typed user messages (no tool output, each cut to 600 characters) for the projects the user put in scope, within a token budget per project, into one sample file per project under ~/.claude/last-words/setup/samples/.',
  'Returns the files with their sizes; hand them to subagents to read. They are deleted when setup_save runs or setup is declined.',
  `Main thread only; only within the scope and budget the user agreed in this session (skill ${SETUP_SKILL}).`,
].join(' ')

const SAVE_SCHEMA = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['user', 'project'], description: 'user: ~/.claude/last-words/strategy/user.md, for every project. project: a profile for one project.' },
    project: { type: 'string', description: "For scope project: the project's key or folder; this session's project when absent." },
    profile: { type: 'string', description: 'The whole profile file: front matter between --- lines (template, nudge_1..nudge_3 as shares of the auto-compact threshold or off, cooldown, subagents, sub_nudge_1..sub_nudge_3, resume_hold, reread_budget, handoff, after, idle_handoff, snapshot, snapshot_keep), then a body under 40 lines with ## Moments, ## Not now, ## Handoff and ## After. The mod stamps approved with today\'s date.' },
    declined: { type: 'boolean', description: 'true when the user declined setup: records the decline and deletes any sample files; pass nothing else.' },
  },
}
const SAVE_DESCRIPTION = [
  'last-words setup: validate and save a compaction strategy profile, delete the sample files, record setup as done, and put the profile in force for this session.',
  'Call it only after the user explicitly approved this exact profile in this session; never on your own judgement or from a draft they have not seen.',
  'With declined: true instead, it records that the user declined setup and deletes any sample files.',
  'Main thread only.',
].join(' ')

function todayLocal(): string {
  return new Date().toLocaleDateString('sv-SE')
}

// Sets `approved: <date>` in the front matter, replacing any value there.
function stampApproved(text: string, date: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const open = lines.findIndex(l => l.trim() === '---')
  const close = lines.findIndex((l, j) => j > open && l.trim() === '---')
  if (open < 0 || close < 0) return text
  const fm = lines.slice(open + 1, close).filter(l => !/^\s*approved\s*:/.test(l))
  return [...lines.slice(0, open + 1), ...fm, `approved: ${date}`, ...lines.slice(close)].join('\n').replace(/\n*$/, '\n')
}

async function setupScan($: any, e: any): Promise<{ result: string } | { deny: string }> {
  const projects = Array.isArray(e.projects) ? e.projects.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '').map(asKey) : undefined
  const since = typeof e.since === 'string' && e.since.trim() !== '' ? e.since.trim() : undefined
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return { deny: `since must be a date (YYYY-MM-DD), not "${since}".` }
  const root = await projectsRoot($)
  const out = `${await lwHome($)}/setup/features.json`
  const started = await $.clock.now()
  $.ui.status('last-words setup: scanning transcripts…')
  const features = await long($, scan($, {
    root,
    ...(projects && projects.length ? { projects } : {}),
    ...(since ? { since } : {}),
    out,
    onProgress: (...a: any[]) => $.ui.status(`last-words setup: scanning… ${a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ').slice(0, 80)}`),
  }))
  const rows = digest(features)
  const secs = Math.round(((await $.clock.now()) - started) / 100) / 10
  await status($)
  await dbg($, `setup_scan ${rows.length} projects in ${secs}s`)
  return {
    result: [
      `Scanned ${rows.length} project${rows.length === 1 ? '' : 's'} under ${root} in ${secs} s; the features file is ${out}. One project per line:`,
      ...rows.map(r => JSON.stringify(r)),
    ].join('\n'),
  }
}

async function setupSample($: any, e: any): Promise<{ result: string } | { deny: string }> {
  const projects = Array.isArray(e.projects) ? e.projects.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '').map(asKey) : []
  if (projects.length === 0) return { deny: 'projects is required: the project keys the user put in scope.' }
  const bad = projects.filter((k: string) => !KEY_RE.test(k))
  if (bad.length) return { deny: `Not project keys: ${bad.join(', ')}. Use the keys the digest lists.` }
  const budget = Number(e.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return { deny: 'budget_tokens must be a positive number: the per-project budget the user agreed.' }
  const dir = `${await lwHome($)}/setup/samples`
  $.ui.status('last-words setup: sampling messages…')
  const files = await long($, sample($, { root: await projectsRoot($), projects, budgetTokens: Math.round(budget), dir }))
  await status($)
  await dbg($, `setup_sample ${files.length} files`)
  if (files.length === 0) return { result: `No sample files were written: none of ${projects.join(', ')} had typed user messages under ${await projectsRoot($)}.` }
  return {
    result: [
      `Wrote ${files.length} sample file${files.length === 1 ? '' : 's'} in ${dir} (deleted when setup_save runs or setup is declined):`,
      ...files.map(f => `${f.path} — ${f.key}, about ${f.tokens < 10_000 ? f.tokens : fmtK(f.tokens)} tokens`),
    ].join('\n'),
  }
}

async function setupSave($: any, e: any): Promise<{ result: string } | { deny: string }> {
  const lw = await lwHome($)
  const samples = `${lw}/setup/samples`
  if (e.declined === true) {
    await deleteSamples($, samples).catch(() => undefined)
    await writeSetupRecord($, { via: 'decline', declined: true })
    await dbg($, 'setup declined (tool)')
    return { result: 'Recorded that the user declined setup; the offer will not come again, and sample files (if any) are deleted. /last-words setup still runs it any time.' }
  }
  if (e.scope !== 'user' && e.scope !== 'project') return { deny: 'scope must be "user" or "project".' }
  if (typeof e.profile !== 'string' || e.profile.trim() === '') return { deny: 'profile is required: the whole profile file the user approved.' }
  const here = projectKey(await $.session.cwd())
  const key = e.scope === 'project' ? (typeof e.project === 'string' && e.project.trim() !== '' ? asKey(e.project) : here) : undefined
  if (key !== undefined && !KEY_RE.test(key)) return { deny: `"${key}" is not a project key.` }
  const date = todayLocal()
  const text = stampApproved(e.profile, date)
  const parsed = parseProfile(text)
  if ('errors' in parsed) return { deny: `The profile is not valid, so nothing was saved: ${parsed.errors.join('; ')}. Fix it, show the user the change if it is more than a typo, and call again.` }
  const path = key === undefined ? `${lw}/strategy/user.md` : `${lw}/strategy/projects/${key}.md`
  const replaced = await $.fs.exists(path)
  await $.fs.write(path, text)
  await deleteSamples($, samples).catch((err: any) => $.ui.log(`${PLUGIN}: deleting the sample files failed: ${errText(err)}`))
  await writeSetupRecord($, { via: 'save', done: true, path })
  await profiles($, true)
  await registerCompactionTool($)
  await status($)
  await dbg($, `setup_save ${path}`)
  const lim = await limits($)
  const inForce = key === undefined || key === here
  return {
    result: [
      `Saved the ${e.scope} profile at ${path}${replaced ? ' (replacing the previous one)' : ''}, approved ${date}. The sample files are deleted and setup is recorded as done.`,
      inForce
        ? `It is in force from now on in this session: nudges at ${levelsText(lim.nudges)}, cooldown ${fmtK(lim.cooldown)} (auto-compaction at ${fmtK(lim.threshold)}). /auto-compact status shows it.`
        : `It applies to project ${key}, not this session's (${here}); sessions there pick it up when they start.`,
    ].join(' '),
  }
}

export const register: Register = (on, options) => {
  configured = options ?? {}
  on('session.start', async ($, e, next) => {
    // Commands first: a prompt that arrives while the session is still starting finds them listed.
    await $.command.register({ name: 'auto-compact', description: 'Claude-managed compaction for this session: on, off or status', argumentHint: '[on|off|status]' })
    await $.command.register({ name: 'prepare-compact', description: 'Ask Claude to capture progress, rewrite the handoff and request compaction' })
    await $.command.register({ name: 'last-words', description: 'Tailor when and how Claude compacts to how you work: setup, or setup decline to stop the offer', argumentHint: 'setup [decline]' })
    await readWindow($)
    await profiles($, true)
    await registerCompactionTool($)
    // The setup tools take the engine's default placement (behind ToolSearch where it defers MCP tools), so they cost
    // no context in the sessions that never run setup.
    await $.tool.register({ name: 'setup_scan', description: SCAN_DESCRIPTION, inputSchema: SCAN_SCHEMA })
    await $.tool.register({ name: 'setup_sample', description: SAMPLE_DESCRIPTION, inputSchema: SAMPLE_SCHEMA })
    await $.tool.register({ name: 'setup_save', description: SAVE_DESCRIPTION, inputSchema: SAVE_SCHEMA })
    await maybeOffer($).catch((err: any) => $.ui.log(`${PLUGIN}: the setup offer failed: ${errText(err)}`))
    await status($)
    return next(e)
  })

  // The approved strategy, as a system prompt section of the main thread (and forks); other subagents never render it.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('analysis')) return r
    if (!(await read($, st)).enabled) return r
    const text = await strategySection($)
    if (!text) return r
    return { sections: [...r.sections, { id: `${PLUGIN}:strategy`, text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // The setup tools (a pattern, since tools registered at run time are not in the generated tool-name types).
  on('tool.call', { tool: /^mcp__last-words__setup_(scan|sample|save)$/ }, async ($, e) => {
    const name = e.tool.replace('mcp__last-words__', '')
    if ((e as any).agentId !== undefined) return { deny: MAIN_ONLY }
    try {
      if (name === 'setup_scan') return await setupScan($, e)
      if (name === 'setup_sample') return await setupSample($, e)
      return await setupSave($, e)
    } catch (err: any) {
      $.ui.log(`${PLUGIN}: ${name} failed: ${errText(err)}`)
      await status($).catch(() => undefined)
      return { deny: `${name} failed inside the last-words mod: ${errText(err)}` }
    }
  }).catch(($, e) => ({ deny: `${e.tool.replace('mcp__last-words__', '')} failed inside the last-words mod (it ran out of time or crashed).` }))

  // `handoff: mod` puts the handoff outside the project, so every write would ask. Allow the main thread's
  // Read, Write and Edit on exactly this project's mod handoff file; every other path goes on unchanged.
  // Setup's reads lie outside the project too: the sample files (read by the reading subagents) and the setup skill's
  // own templates file. Allow Read, for any agent, on files directly in the samples folder and on that one file.
  on('tool.check', { tool: /^(Read|Write|Edit)$/ }, async ($, e, next) => {
    const fp = (e.input as any)?.file_path
    if (typeof fp !== 'string') return next(e)
    const norm = (p: string) => p.replace(/\/+/g, '/')
    const path = norm(fp)
    if (e.agentId === undefined && path === norm(await modHandoffPath($))) {
      return { decision: 'allow' as const, reason: "last-words: this project's handoff file in the mod's own folder" }
    }
    if (e.tool === 'Read') {
      const samples = norm(`${await lwHome($)}/setup/samples/`)
      const rest = path.startsWith(samples) ? path.slice(samples.length) : ''
      if (rest && !rest.includes('/') && rest.endsWith('.md') && !rest.includes('..')) {
        return { decision: 'allow' as const, reason: 'last-words: a setup sample file' }
      }
      if (path === norm(`${$.plugin.root}/skills/setup/templates.md`)) {
        return { decision: 'allow' as const, reason: "last-words: the setup skill's templates" }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every prompt, task notification and cross-session message that reaches the model passes here.
  on('prompt.submit', async ($, e, next) => {
    const origin: any = e.origin
    if (!(origin?.kind === 'plugin' && origin?.name === PLUGIN)) {
      const now = await $.clock.now()
      await update($, ib, () => ({ at: now, what: arrivalWords(origin?.kind) }))
      await dbg($, `inbound ${String(origin?.kind)} at=${now} meta=${(e as any).isMeta === true}`)
      // A background subagent's report, or a resumed one's reply, arrives as a notification or message: its size note rides on it.
      if (origin?.kind !== 'composer' && pendingReport.size > 0) {
        const text = await takeReports($)
        if (text) return next({ ...e, context: [...((e as any).context ?? []), text] })
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__last-words__request_compaction' }, async ($, e) => {
    if ((e as any).agentId !== undefined) return { deny: 'request_compaction is for the main thread only.' }
    const checked = await validate($, e)
    if ('deny' in checked) return { deny: checked.deny }
    await update($, st, v => ({ ...v, pending: checked.req }))
    await dbg($, `queued ${JSON.stringify(checked.req)}`)
    await status($)
    return { result: 'Compaction queued for the end of this turn. End your turn now. If anything arrives before the turn ends, the request is cancelled and you will be told.' }
  }).catch(() => ({ deny: 'request_compaction failed inside the last-words mod; compaction was not queued.' }))

  // The reading check (main thread Read and Bash after a compaction), subagent nudges on their tool results,
  // the one-time hold on the main thread's SendMessage to a big subagent, and the report note on a foreground Agent result.
  on('tool.call', async ($, e, next) => {
    if ((e as any).agentId === undefined && (e.tool === 'Read' || e.tool === 'Bash')) {
      const r = await read($, rd)
      if (r.armed && r.files.some(f => !f.read)) {
        const cwd = await $.session.cwd()
        const hit = r.files.map(f => f.read || opens(e.tool, e, f.path, cwd))
        if (hit.some((h, i) => h !== r.files[i]?.read)) await update($, rd, v => ({ ...v, files: v.files.map((f, i) => ({ ...f, read: f.read || hit[i] === true })) }))
      }
    }
    const agentId: string | undefined = (e as any).agentId
    if (agentId === undefined && e.tool === 'SendMessage' && (await read($, st)).enabled) {
      const held = await holdResume($, e)
      if (held) return held
    }
    const res: any = await next(e)
    if (agentId !== undefined) return deliverSubNudge($, agentId, res)
    if (e.tool === 'Agent' && res?.deny === undefined) {
      // A foreground agent's report is this result: its size note rides on it.
      const id = res?.result?.agentId
      const text = typeof id === 'string' ? await takeReports($, id) : undefined
      if (text) return { ...res, context: [...(res.context ?? []), text] }
    }
    return res
  }).catch(($, e, next) => next(e))

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (!(await read($, st)).enabled) return r
    return { ...r, blocks: [...r.blocks, { name: 'lastWords', text: trustBlock(await limits($)) }] }
  }).catch(($, e, next) => next(e))

  // Every model request's usage: a subagent's size, read per request.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId !== undefined && r?.usage) {
      try {
        if ((await read($, st)).enabled) await readSubStep($, e.agentId, r.usage)
      } catch (err: any) {
        $.ui.log(`${PLUGIN}: reading a subagent's size failed: ${String(err?.message ?? err)}`)
      }
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, tu, v => ({ ...v, running: true }))
      if ((await read($, rd)).armed) await update($, rd, v => ({ ...v, started: true }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) {
      // A subagent finished a round: past the first level, its report gets a size note when it reaches the main thread.
      const a = (await read($, ag)).byId[e.agentId]
      const lim = await limits($)
      if (a && (await read($, st)).enabled && lim.subagents && a.tokens >= lim.subNudges[0]!) pendingReport.set(e.agentId, a.tokens)
      return out
    }
    const ended = await $.clock.now()
    await update($, tu, () => ({ running: false, endedAt: ended }))
    await showOffer($).catch((err: any) => $.ui.log(`${PLUGIN}: the setup offer failed: ${errText(err)}`, { to: 'debug' }))
    await ensureWindow($)
    const s = await read($, st)
    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (s.lastPostTokens < 0) await update($, st, v => ({ ...v, lastPostTokens: tokens }))
    const inb = await read($, ib)
    await dbg($, `turn.complete aborted=${e.isAborted} reason=${(e as any).reason} enabled=${s.enabled} pending=${JSON.stringify(s.pending ?? null)} inbound=${JSON.stringify(inb)} tokens=${tokens}`)
    if (s.enabled && s.pending) {
      const req = s.pending
      if (e.isAborted) {
        await update($, st, v => ({ ...v, pending: undefined }))
        await note($, '[last-words] The turn was interrupted, so your compaction request was cancelled. Request again when ready.')
      } else if ((await read($, ib)).at > req.at) {
        const inbound = await read($, ib)
        await update($, st, v => ({ ...v, pending: undefined }))
        $.clock.after(300, () => void submitDeferred($, inbound.what ?? 'a message'))
      } else {
        await update($, st, v => ({ ...v, pending: undefined, inflight: req }))
        await runCompact($)
      }
    } else {
      await checkReads($, e.isAborted === true)
      await nudge($, tokens)
    }
    await status($, tokens)
    return out
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's own compaction (Claude Code's auto-compaction near its limit).
      if (!(await read($, st)).enabled) return next(e)
      const agentId = e.agentId
      const brief = await saveBrief($, agentId, e.messages).catch(() => undefined)
      const sres = await next({ ...e, instructions: [e.instructions, SUB_SUMMARY_GUIDANCE].filter(Boolean).join('\n\n') })
      if (sres.skip !== undefined || e.trigger === 'precompute') return sres
      const now = await $.clock.now()
      await update($, ag, v => ({ byId: { ...v.byId, [agentId]: { tokens: sres.tokensAfter ?? 0, level: 0, at: now, ...(brief ? { brief } : {}) } } }))
      pendingSub.delete(agentId)
      await dbg($, `subagent ${agentId} compacted ${sres.tokensBefore} -> ${sres.tokensAfter}`)
      return { ...sres, messages: [...sres.messages, { role: 'user' as const, text: subReentryNote(sres.tokensBefore, sres.tokensAfter, brief), toolUses: [] }] }
    }
    if (e.trigger === 'precompute') {
      // Computed ahead of time (the idle timer in hosts that cannot compact) and reused by a later compaction.
      const ps = await read($, st)
      if (!ps.enabled) return next(e)
      const idleSkip = await interceptIdle($, ps)
      if (idleSkip) return idleSkip
      return next({ ...e, instructions: [e.instructions, SUMMARY_GUIDANCE].filter(Boolean).join('\n\n') })
    }
    const s = await read($, st)
    if (!s.enabled) return next(e)
    const idleSkip = await interceptIdle($, s)
    if (idleSkip) return idleSkip
    const own = s.inflight !== undefined
    const inbound = await read($, ib)
    if (s.inflight && inbound.at > s.inflight.at) {
      // Something was queued after the request and ran before /compact: the handoff no longer covers it.
      const what = inbound.what ?? 'a message'
      await update($, st, v => ({ ...v, inflight: undefined }))
      $.clock.after(300, () => void submitDeferred($, what))
      return { skip: `last-words: ${what} arrived after the compaction request; Claude will fold it into the handoff and request again.` }
    }
    const req = s.inflight ?? s.lastRequest
    const n = s.compactions + 1
    const before = (await $.session.usage()).context.tokens
    const snapId = await ((await snapshotsOn($)) ? snapshot($, n, before, req) : Promise.resolve(undefined)).catch((err: any) => {
      $.ui.log(`${PLUGIN}: snapshot failed: ${String(err?.message ?? err)}`)
      return undefined
    })
    // The mod's own /compact carries only a label as its arguments; the user's own carries their instructions.
    const instructions = own ? [s.inflight?.focus, SUMMARY_GUIDANCE].filter(Boolean).join('\n\n') : [e.instructions, SUMMARY_GUIDANCE].filter(Boolean).join('\n\n')
    const res = await next({ ...e, instructions })
    if (res.skip !== undefined) {
      await update($, st, v => ({ ...v, inflight: undefined }))
      return res
    }
    await update($, st, v => ({
      ...v,
      inflight: undefined,
      lastRequest: req,
      compactions: n,
      lastPostTokens: -1,
      nudgeLevel: 0,
      snapshots: snapId ? [...v.snapshots, snapId] : v.snapshots,
    }))
    if (snapId) $.ui.toast(`Pre-compact snapshot: claude --resume ${snapId}`, { timeoutMs: 10_000 })
    const state = await stateLines($, req, own).catch(() => '')
    const noteText = reentryNote(req, n, res.tokensBefore ?? before, res.tokensAfter, snapId, state)
    // The reading check runs after the next turn for the mod's own compaction (armed with the resume prompt, so the
    // /compact command's own turn does not count) and for auto-compaction; after the user's own /compact the user is
    // present and steers the next turn.
    if (e.trigger === 'auto') await armReads($, req)
    if (own) {
      // The note goes in as a hidden row just before the resume prompt, after the /compact rows; the user sees one short line.
      $.clock.after(300, () => void submitResume($, noteText, req))
      return res
    }
    return { ...res, messages: [...res.messages, { role: 'user' as const, text: noteText, toolUses: [] }] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'auto-compact' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, st, v => ({ ...v, enabled: arg === 'on', ...(arg === 'off' ? { pending: undefined } : {}) }))
      await status($)
    }
    return { text: await statusText($) }
  })

  on('command.run', { command: 'last-words' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (args[0] === 'setup' && args[1] === 'decline') {
      await deleteSamples($, `${await lwHome($)}/setup/samples`).catch(() => undefined)
      await writeSetupRecord($, { via: 'decline', declined: true })
      return { text: 'last-words setup declined: the offer will not come again. /last-words setup runs it whenever you like.' }
    }
    if (args[0] === 'setup' && args.length === 1) {
      $.clock.after(50, () => void $.prompt.submit({ text: SETUP_PROMPT, asUser: true }))
      return { text: 'Starting last-words setup.' }
    }
    const lp = strategyProfile(await profiles($))
    return { text: [`Usage: /last-words setup (tailor compaction to how you work), /last-words setup decline (stop the offer).`, lp ? `Strategy in force: ${lp.path}.` : 'No strategy is set up for this project.'].join('\n') }
  })

  on('command.run', { command: 'prepare-compact' }, async $ => {
    $.clock.after(50, () => void $.prompt.submit({ text: PREPARE_PROMPT, asUser: true }))
    return { text: 'Asked Claude to prepare for compaction.' }
  })
}
