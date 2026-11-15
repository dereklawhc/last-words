import { atom, read, update } from 'claude-code'
import type { PluginOptions, Register } from 'claude-code'

import type { AfterMode, CompactionRequest, HcInbound, HcReads, HcState, HcTurns, RereadItem } from '../types'

const PLUGIN = 'last-words'
const SKILL = `${PLUGIN}:compaction-handoff`
const DEFAULT_NUDGES = [400_000, 700_000, 850_000]
const DEFAULT_COOLDOWN = 100_000
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

function toolDescription(lim: Limits): string {
  const [a, b, c] = lim.nudges.map(t => fmtK(t))
  return [...TOOL_DESCRIPTION_LINES, `This session's nudge levels: ${a} (take the next natural handoff point), ${b} (drive to one), ${c} (compact at the first safe point); cooldown ${fmtK(lim.cooldown)} of growth after a compaction.`].join(' ')
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    handoff: { type: 'string', description: 'Path of the handoff file (absolute, or relative to the session directory). Always re-read in full after compaction.' },
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
  return ['1', 'true', 'on', 'yes'].includes(env)
}

// Whether idle compactions are turned into a handoff request: the setting, else LAST_WORDS_IDLE_HANDOFF, else on.
async function idleHandoffOn($: any): Promise<boolean> {
  const v = configured['idle_handoff']
  if (typeof v === 'boolean') return v
  const env = ((await $.env.get('LAST_WORDS_IDLE_HANDOFF')) ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(env)
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

type Limits = { nudges: number[]; cooldown: number; invalid: boolean }

// Thousands of tokens from a userConfig field, or undefined when it is unset or not a positive number.
function configK(key: string): number | undefined {
  const v = configured[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : undefined
}

// Each value comes from the plugin's settings, else the environment, else the default.
async function limits($: any): Promise<Limits> {
  const env = ((await $.env.get('LAST_WORDS_NUDGES_K')) ?? '').split(',').map((x: string) => Number(x.trim()) * 1000)
  const envOk = env.length === 3 && env.every((x: number) => Number.isFinite(x) && x > 0)
  const nudges = DEFAULT_NUDGES.map((d, i) => configK(`nudge_${i + 1}_k`) ?? (envOk ? env[i]! : d))
  const rising = nudges.every((x, i) => i === 0 || x > nudges[i - 1]!)
  const envCooldown = Number((await $.env.get('LAST_WORDS_COOLDOWN_K')) ?? '') * 1000
  const cooldown = configK('cooldown_k') ?? (Number.isFinite(envCooldown) && envCooldown > 0 ? envCooldown : DEFAULT_COOLDOWN)
  return { nudges: rising ? nudges : DEFAULT_NUDGES, cooldown, invalid: !rising }
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
  const handoff = absPath(input.handoff, cwd)
  const stat = await $.fs.stat(handoff, { resolve: true }).catch(() => undefined)
  if (!stat || stat.kind !== 'file') return { deny: `The handoff file ${handoff} does not exist.` }
  const real = stat.realPath ?? handoff
  if (TEMP_DIRS.some(d => real.startsWith(d))) {
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
  const dir = `${home}/.claude/last-words/snapshots/${snapId}`
  const files = req ? [req.handoff, ...req.reread.map(r => r.path)] : []
  await $.fs.write(`${dir}/manifest.json`, JSON.stringify({ session: id, snapshot: snapId, title, transcript: dst, request: req, files }, null, 2))
  for (const [i, f] of files.entries()) {
    const name = `${String(i).padStart(2, '0')}-${f.split('/').pop()}`
    await $.process.run(['cp', f, `${dir}/${name}`]).catch(() => undefined)
  }
  await prune($, id, home).catch((err: any) => $.ui.log(`${PLUGIN}: snapshot pruning failed: ${String(err?.message ?? err)}`))
  return snapId
}

// How many snapshots to keep per session: the setting, else LAST_WORDS_SNAPSHOT_KEEP, else 10; 0 keeps all.
async function snapshotKeep($: any): Promise<number> {
  const v = configured['snapshot_keep']
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  const raw = ((await $.env.get('LAST_WORDS_SNAPSHOT_KEEP')) ?? '').trim()
  const env = raw === '' ? NaN : Number(raw)
  return Number.isInteger(env) && env >= 0 ? env : DEFAULT_SNAPSHOT_KEEP
}

// Deletes this session's oldest snapshots beyond the limit: the transcript copy and its folder of file copies.
async function prune($: any, session: string, home: string) {
  const keep = await snapshotKeep($)
  if (keep === 0) return
  const root = `${home}/.claude/last-words/snapshots`
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
  const level = nudges.filter(t => tokens >= t).length
  if (level <= s.nudgeLevel) return
  await update($, st, v => ({ ...v, nudgeLevel: level }))
  const k = fmtK(tokens)
  const which = ['first', 'second', 'third'][level - 1] ?? 'third'
  const head = `[last-words] Context is at ${k} tokens: the ${which} of three nudges (levels ${nudges.map(t => fmtK(t)).join(' / ')}).`
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

async function statusText($: any): Promise<string> {
  const s = await read($, st)
  const tokens = (await $.session.usage()).context.tokens
  const lim = await limits($)
  const lines = [
    `auto-compact: ${s.enabled ? 'on' : 'off'} · context ${fmtK(tokens)} · compactions by this mod's session: ${s.compactions}`,
    `nudges at ${lim.nudges.map(t => fmtK(t)).join(' / ')} (sent up to level ${s.nudgeLevel}); cooldown ${fmtK(lim.cooldown)} since the last compaction (${fmtK(s.lastPostTokens)} after it)`,
  ]
  const keep = await snapshotKeep($)
  lines.push(`idle compaction: ${(await idleHandoffOn($)) ? 'turned into a handoff request' : 'left to Claude Code'}`)
  lines.push(`pre-compact snapshots: ${(await snapshotsOn($)) ? `on, keeping ${keep === 0 ? 'all' : `the last ${keep}`} per session` : 'off'}`)
  if (lim.invalid) lines.push('the configured nudge levels do not rise from first to third, so the defaults are in use')
  if (s.pending) lines.push(`queued: handoff ${s.pending.handoff}, after=${s.pending.after}`)
  if (s.lastRequest) lines.push(`last handoff: ${s.lastRequest.handoff}`)
  if (s.snapshots.length) lines.push(`snapshots (claude --resume <id>): ${s.snapshots.join(', ')}`)
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  configured = options ?? {}
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'request_compaction', description: toolDescription(await limits($)), inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.command.register({ name: 'auto-compact', description: 'Claude-managed compaction for this session: on, off or status', argumentHint: '[on|off|status]' })
    await $.command.register({ name: 'prepare-compact', description: 'Ask Claude to capture progress, rewrite the handoff and request compaction' })
    await status($)
    return next(e)
  })

  // Every prompt, task notification and cross-session message that reaches the model passes here.
  on('prompt.submit', async ($, e, next) => {
    const origin: any = e.origin
    if (!(origin?.kind === 'plugin' && origin?.name === PLUGIN)) {
      const now = await $.clock.now()
      await update($, ib, () => ({ at: now, what: arrivalWords(origin?.kind) }))
      await dbg($, `inbound ${String(origin?.kind)} at=${now} meta=${(e as any).isMeta === true}`)
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

  // The reading check: marks each listed file as read when the main thread opens it after a compaction.
  on('tool.call', async ($, e, next) => {
    if ((e as any).agentId === undefined && (e.tool === 'Read' || e.tool === 'Bash')) {
      const r = await read($, rd)
      if (r.armed && r.files.some(f => !f.read)) {
        const cwd = await $.session.cwd()
        const hit = r.files.map(f => f.read || opens(e.tool, e, f.path, cwd))
        if (hit.some((h, i) => h !== r.files[i]?.read)) await update($, rd, v => ({ ...v, files: v.files.map((f, i) => ({ ...f, read: f.read || hit[i] === true })) }))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, tu, v => ({ ...v, running: true }))
      if ((await read($, rd)).armed) await update($, rd, v => ({ ...v, started: true }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    const ended = await $.clock.now()
    await update($, tu, () => ({ running: false, endedAt: ended }))
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
    if (e.agentId !== undefined) return next(e)
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

  on('command.run', { command: 'prepare-compact' }, async $ => {
    $.clock.after(50, () => void $.prompt.submit({ text: PREPARE_PROMPT, asUser: true }))
    return { text: 'Asked Claude to prepare for compaction.' }
  })
}
