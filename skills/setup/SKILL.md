---
name: setup
description: Tailor last-words to how this user works. With their consent, scan their Claude Code history, read samples through subagents, propose a compaction strategy per project or group from the templates, discuss it, and save it only on their approval. Load when the user accepts the mod's setup offer, runs `/last-words setup`, or asks to tailor when or how their sessions compact.
---

# Setup

Setup gives this user a compaction strategy designed around the work they do and how they do it.
The shipped strategy came from one user's multi-wave subagent builds; it is one template among several, and this user's work may look nothing like it.
The strategy is the main part: when to compact, when not to, where the handoff lives, what happens after.
The numbers only set urgency.

Judge every proposal by three measures:
- Reaching the engine's auto-compaction is a failure of the strategy. Claude should always compact first, at a point it chose, with a handoff written.
- Losing context the work still needs is a failure of the strategy.
- Compacting too often, or re-reading too much afterwards, is not ideal.

Read `templates.md` beside this file before step 6: it holds the fixed principles, the nine templates and the exact profile format.

The user can stop at any step. Then save nothing, delete any samples (step 5), and say in one line that `/last-words setup` runs it any time. If they decline setup as a whole, record it with `setup_save({ declined: true })` so the offer is not made again.

The setup tools (`setup_scan`, `setup_sample`, `setup_save`) may need loading through tool search before the first call.

## 1. Offer

The mod itself offers setup once, as a line after your first reply in the first session after install; you need not offer it.
If the user accepts that offer, runs `/last-words setup`, or asks to tailor compaction, continue here.

## 2. Ask before reading anything

Say what setup would read and ask. Use this wording, adapted to the conversation:

> Setup can learn how you work from your Claude Code history before it proposes anything.
> With your OK, the mod reads your past sessions in `~/.claude/projects`, your `CLAUDE.md` files and your memory files, here on this machine.
> The scan keeps counts of tools, sizes, timings and commands, never what you wrote.
> Nothing leaves this machine except what this session already sends its model: the scan's summary, and later, only if you agree, short samples of your own messages from the projects you choose.
> Setup keeps that summary in `~/.claude/last-words/setup/` and, once you approve one, the strategy itself.
> Or skip the history, and I'll ask you a few questions about how you work instead.
> Shall I scan your history?

Wait for a clear yes. On a no to the scan, go to "No history: the interview" below.

## 3. Scan

Call `setup_scan` with no arguments, unless the user limited the scan to some projects or a period (`projects`, `since`).

On a large history the scan takes a minute or two; say so before calling it.
If it finds no sessions, go to the interview.

## 4. Present the digest and propose a scope

Present each project in human terms: its folder name, sessions, total size, when last active, and the tentative work type with the evidence behind it in words ("most sessions peak past half the window; 4 auto-compactions; two thirds of steps are edits and shell commands").
Never show project keys or hashes; keys go only into tool calls.
Say first, for each project, whether compaction matters there at all. Fold the projects where it does not (short sessions, low peaks) into one line.

Then suggest a scope for the reading pass, with your recommendation first:
- **Full reading:** every project where compaction matters.
- **Chosen projects or sessions:** the ones the user names, or the ones you would pick and why.
- **Dig into a pattern** the scan found, for example "three projects hit auto-compaction often; read what happened around those".

Give each option a reading budget: tokens per project (default 20k; 10k for a small or plainly typed project, 40k for a large mixed one), the total, and roughly how long. The subagents run in parallel, each taking a few minutes on 20–40k tokens, so the pass takes about as long as the slowest one.
The user picks the scope and may change the budget.

## 5. Reading pass

Call `setup_sample({ projects, budget_tokens })` with the chosen projects' keys and the per-project budget.
It returns the sample files: the user's own typed messages, grouped under the moments that show a work rhythm (session start, around `/clear` and `/compact`, auto-compactions, after a long gap), each with its session and time.

Start one subagent per project, or per group of small similar projects, all in one message, with `model: "sonnet"`: characterising how someone works is judgement over short text, which Sonnet does well and cheaply. Use Haiku only for mechanical extraction, never for the characterisation.
Do not open the sample files yourself; only the characterisations come back to the main thread.

Brief each subagent with:
- the sample file paths, and the instruction to read only those;
- the project's digest lines;
- for a session or pattern scope, which sessions or moments to read (the samples carry session ids, times and moment headings);
- the layout below, to be returned exactly and with nothing else;
- quotes under 15 words each, at most six, copying no other message text, and writing no files.

```markdown
## <project folder name>
- **Work:** what the work is, in one or two sentences.
- **Rhythm:** how a session runs: one task or many, how long, how many exchanges, waits and absences.
- **Boundaries already used:** where the user already stops, clears, compacts, commits or moves to the next question.
- **Review gates:** where the user checks results before work goes on, and how they say so.
- **Hand-over habits:** notes, plan or handoff files, "re-read X" prompts, how work is passed to agents or sessions.
- **Unclear:** what the samples cannot show.
- **Evidence:** each quote under 15 words, with its date and moment.
```

## 6. Proposal

Group projects that work alike. Suggest one user-wide strategy for the most common kind of work and a project profile only where a project differs; the user may prefer one profile per project.
If a project's `CLAUDE.md` or the user's memory already sets a compaction routine, it outranks any profile: build on it, or leave that project out.

For each project or group, present:
- **Template:** the matched template or templates from `templates.md`, and the one reason it fits. A project that moves between kinds of work (research, then a build) gets moments for each phase.
- **Compact when:** the moments, in plain words for this work, adapted from the template and the characterisation.
- **Not now:** the fixed "When not to compact" list applies everywhere; add only what this work needs (for example "during a discussion").
- **Handoff:** where it lives (a path in the repo, `mod` for a folder the mod keeps per project, or a folder the user chooses), what it holds, and what to re-read after compaction.
- **After compaction:** the `after` mode and when it changes.
- **Numbers:** each level as a share of the auto-compact limit with what it means on this user's window. The limit is 967k on the 1M window, lower if the user set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Example: "second nudge at 60% of the limit, 580k on your 1M window". Then the cooldown, the re-read budget (a share of the window), whether the subagent rules apply, idle handoff and snapshots.
- **Evidence:** behind each choice, the digest feature in words or a quote from the characterisation.

Then ask only what the data cannot answer, each question with your recommendation: whether review gates are expected, whether sessions run while the user is away, where handoff notes should live, and anything the characterisations marked unclear.

## 7. Discussion and approval

Revise until the user is satisfied.
Then show each profile exactly as it will be saved, in the format at the end of `templates.md`: front matter, then a body under 40 lines with `## Moments`, `## Not now`, `## Handoff`, `## After`.
Approval is the user's explicit yes to those profiles, in this session. A yes to the general direction is not approval of a file.

## 8. Save

Only after that approval, call `setup_save` once per scope:
- `{ scope: 'user', profile }` for the user-wide strategy;
- `{ scope: 'project', project: <key from the digest>, profile }` for each project profile.

`profile` is the approved text, unchanged.
Then tell the user, in a few lines:
- it takes effect in this session and every new one;
- `/auto-compact status` shows the profile in force and the levels in tokens;
- `/last-words setup` runs setup again; deleting a profile file under `~/.claude/last-words/strategy/` removes it.

Saving deletes the samples. If setup ends without a save after step 5, delete `~/.claude/last-words/setup/samples/` and say so.

## No history: the interview

When the user declined the scan or it found nothing, ask in one message:
- Describe a typical long session: what you work on, how long it runs, how much back-and-forth.
- Do you run subagents, background jobs or long waits?
- Do you leave sessions running while you are away?
- Should Claude stop at review gates for you to check?
- Where should handoff notes live: in the repo, a folder you choose, or the mod's own folder?

Then continue at step 6, with the user's answers as the evidence ("you said …").
