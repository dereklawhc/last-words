# Setup templates

Starting points for the setup proposal.
Adapt and combine them; never apply one unread.
A project that moves between kinds of work (research, then a build) gets moments for each phase.

## Principles

Every strategy holds to these; only the tailored parts vary.

- **Reaching the engine's auto-compaction is a failure of the strategy.** Claude writes the handoff and requests compaction itself, before the engine does it mid-turn with no handoff.
- **Losing context the work still needs is a failure of the strategy.** Anything needed after compaction is on disk, in the handoff or in the re-read list, before compaction.
- **Compacting too often and re-reading too much is a cost.** Each compaction costs a summary (60–360 s) and a re-read; a strategy picks few, good points and sizes the re-read list to the window.
- **The user's word wins.** Explicit instructions, `CLAUDE.md` and memory come before the strategy, which comes before the built-in defaults.
- **Never at a review gate the user has not approved.**
- **The "When not to compact" list holds in every strategy:** an unreviewed result, a merge in progress, mid-exchange with an agent, an instruction not yet on disk, stuck or mid-derivation.
- **A question for the user never blocks compaction;** it goes into the handoff with a recommendation and a default.

Tailored: the moments, the numbers, the handoff (place, contents, re-read budget), the default `after` mode, idle handoff and snapshots, and the scope (user-wide or per project).

## Numbers

Levels and the cooldown are shares of the engine's auto-compact limit, which is the compaction window minus 33k.
The re-read budget is a share of the window.
The shipped defaults as shares:

| Value | Share | On a 1M window (limit 967k) | On a 200k window (limit 167k) |
| --- | --- | --- | --- |
| First nudge | 0.414 | 400k | 69k |
| Second nudge | 0.724 | 700k | 121k |
| Third nudge | 0.879 | 850k | 147k |
| Cooldown | 0.103 | 100k | 17k |
| Subagent nudges | 0.362 / 0.517 / 0.724 | 350k / 500k / 700k | 60k / 86k / 121k |

A 60–120k re-read is routine on a 1M window and most of a 200k one; size the budget to the window.
An absolute value the user set in the plugin settings or the environment still wins over any profile.

## Templates

Each entry: signature (what the scan and samples show), moments, numbers, handoff, after.
"Defaults" means the table above. Token figures are on 1M / 200k windows.

### Short tasks (`short-tasks`)

- **Signature:** one or two human prompts per session, peaks under 30% of the window, frequent `/clear` or new sessions.
- **Moments:** none. Between unrelated tasks, suggest `/clear`.
- **Numbers:** the third level only, as a safety net: `nudge_1: off`, `nudge_2: off`, `nudge_3: 0.879` (850k / 147k). Subagent rules off unless subagents appear. Re-read budget 0.05 (50k / 10k).
- **Handoff:** none, unless a task runs long; then a short note in the mod's folder.
- **After:** `continue`.

### Long single-thread build (`single-thread-build`)

- **Signature:** many turns on one feature, mostly edits and shell commands, few subagents, regular commits.
- **Moments:** after a commit with passing tests, before the next feature or step. Never mid-debug.
- **Numbers:** defaults. Subagent rules off. Re-read budget 0.08 (80k / 16k).
- **Handoff:** light: goal, commits so far, next steps, open bugs. Re-read the handoff and the files in hand.
- **After:** `continue`.

### Multi-wave builds through subagents (`multi-wave-subagents`)

- **Signature:** many subagents, resumed agents, waves of briefs, review and commit cycles.
- **Moments:** the shipped strategy: a build wave has started (previous wave reviewed and committed, briefs are files, agents running, later briefs drafted); a phase has closed; a long wait.
- **Numbers:** defaults. Subagent rules on at the default shares, resume hold on. Re-read budget 0.12 (120k / 24k).
- **Handoff:** the compaction-handoff skill's full contents, in the repo (`docs/handoff.md` unless `CLAUDE.md` names a path).
- **After:** `continue`; `discuss` when a phase closes.

### Phased research and analysis (`phased-research`)

- **Signature:** heavy web search, fetching and reading; findings docs written; many human prompts in long discussions.
- **Moments:** a discussion has concluded on one question, its answer is written up, and the conversation moves to the next question. Never before or during a discussion, which needs the full history.
- **Numbers:** the second level earlier, so a discussion under way can finish before the third: 0.414 / 0.60 / 0.879 (400k / 580k / 850k; 69k / 100k / 147k), cooldown 0.103. Subagent rules on if research is delegated. Re-read budget 0.10 (100k / 20k).
- **Handoff:** the findings doc is the source of truth; the handoff names what is settled and the question now open.
- **After:** `continue` when the next question is already posed; `discuss` when the user has not opened it.

### Experiment and ops loops (`experiment-ops`)

- **Signature:** long shell runs, background tasks and monitors, idle gaps over 30 minutes, logs read with `tail`, few edits.
- **Moments:** a run has started and its monitor is armed; a run's results are written up. Never while a result is unread.
- **Numbers:** defaults. Idle handoff on. Re-read budget 0.05 (50k / 10k).
- **Handoff:** run ids, exact commands, monitors and heartbeats to re-arm, where results land. A light re-read.
- **After:** `continue`.

### Visual iteration and QA (`visual-iteration`)

- **Signature:** a high image share from screenshots and browser tools, the same image paths re-read, short edit-and-check loops.
- **Moments:** after an iteration the user accepted.
- **Numbers:** lower, since images make growth fast and each one is stale after the next iteration: 0.30 / 0.55 / 0.80 (290k / 532k / 774k; 50k / 92k / 134k), cooldown 0.103. Re-read budget 0.05 (50k / 10k).
- **Handoff:** the current state in words with paths to the accepted screenshots, never the images; open feedback items.
- **After:** `continue`; `discuss` while a visual judgement from the user is pending.

### Long-running document work (`document-work`)

- **Signature:** most writes are documents; large document reads and edits; many review rounds.
- **Moments:** a section or chapter is done and accepted, before the next.
- **Numbers:** defaults. Re-read budget 0.10 (100k / 20k).
- **Handoff:** the document holds the state; the handoff holds outline status, agreed style rules and open comments. Re-read the outline and the current section, not the whole document.
- **After:** `continue`; `discuss` when the next section needs the user's direction.

### Persistent assistant or operations session (`persistent-assistant`)

- **Signature:** one session open for days, many unrelated short items (email, tickets, messages, data pulls), MCP-heavy, scheduled triggers, often no repo.
- **Moments:** between items, with nothing mid-flight; when idle.
- **Numbers:** a lower first level and a shorter cooldown, since there are no phases to wait for: 0.30 / 0.724 / 0.879 (290k / 700k / 850k; 50k / 121k / 147k), cooldown 0.05 (48k / 8k). Idle handoff on. Re-read budget 0.05 (50k / 10k).
- **Handoff:** a running ledger of standing state (open items, who is waiting, recurring routines), in the mod's folder by default.
- **After:** `wait`; `continue` for a scheduled routine.

### Data wrangling (`data-wrangling`)

- **Signature:** CSV, SQL and notebook files; large tabular shell output; data files read.
- **Moments:** after an analysis question is answered and its result saved to a file.
- **Numbers:** defaults. The strategy also asks for truncated outputs (`head`, row limits). Re-read budget 0.08 (80k / 16k).
- **Handoff:** questions answered with paths to their outputs, the pipeline steps, open questions.
- **After:** `continue`.

## Profile format

One file per scope: `~/.claude/last-words/strategy/user.md` (user-wide) or `~/.claude/last-words/strategy/projects/<project key>.md` (one project).
Front matter between `---` lines, one `key: value` per line:

- `template`: the template name, as in the headings above.
- `nudge_1`, `nudge_2`, `nudge_3`: shares of the auto-compact limit, or `off`.
- `cooldown`: a share of the auto-compact limit.
- `subagents`: `on` or `off`; `sub_nudge_1`..`sub_nudge_3`: shares; `resume_hold`: `on` or `off`.
- `reread_budget`: a share of the window.
- `handoff`: `repo:<path>`, `mod` (the mod's folder for this project), or an absolute folder.
- `after`: `continue`, `discuss` or `wait`.
- `idle_handoff`, `snapshot`: `on` or `off`; `snapshot_keep`: a whole number, `0` keeps all.
- `approved`: the date the user approved it.

The body, under 40 lines: `## Moments`, `## Not now`, `## Handoff`, `## After`.
It holds what the user approved in plain words, never transcript text.

Example, a project profile from the phased-research template:

```markdown
---
template: phased-research
nudge_1: 0.414
nudge_2: 0.60
nudge_3: 0.879
cooldown: 0.103
subagents: on
sub_nudge_1: 0.362
sub_nudge_2: 0.517
sub_nudge_3: 0.724
resume_hold: on
reread_budget: 0.10
handoff: repo:docs/research/handoff.md
after: discuss
idle_handoff: on
snapshot: off
snapshot_keep: 10
approved: 2026-11-18
---
## Moments
- A discussion has concluded on one question, its answer is written into `docs/research/findings.md`, and the conversation moves to the next question.
- A batch of reading subagents is running and nothing will come back for a while.

## Not now
- Before or during a discussion: it needs the full history.
- A finding has arrived and is not yet written into the findings doc.

## Handoff
- `docs/research/handoff.md`; the findings doc is the source of truth.
- Holds: the questions settled, one line each with a pointer into the findings doc; the question now open and what is known so far; sources still to read; the user's rulings, verbatim and dated; open questions with a recommendation.
- Re-read: the handoff and the findings doc's section on the open question.

## After
- `continue` when the next question is already posed.
- `discuss` when the user has not opened it yet.
```
