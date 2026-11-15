---
name: compaction-handoff
description: Protocol for Claude-managed compaction with the last-words mod — when to call request_compaction, when not to, how context size sets urgency, and what the handoff file must hold. Load when a last-words context note says so, when preparing for compaction, or when the user says "prepare for compact".
---

# Compaction handoff

The last-words mod lets you compact your own session.
You choose the moment, write the handoff, and call `request_compaction`; the mod compacts at the end of your turn (archiving a snapshot of the transcript first, when snapshots are on), and resumes you with a note listing what to re-read.
The user's explicit instructions always win over this protocol.

## When to compact

1. **First: what the user asked for.** If the user has said when to compact ("compact after each wave lands", "compact once this PR merges", "not until I'm back", "prepare for compact now"), or their `CLAUDE.md` or memory describes a compaction routine, follow it. Use the moments below only when they have expressed nothing.
2. **Default: a build wave has started.**
   - The previous wave's results are reviewed and committed.
   - Every brief of the current wave is a file, written before its agent started.
   - The current wave's agents are running and the main thread is waiting.
   - Briefs for later waves that need the full history are drafted, as files.
3. **A phase has closed.** The user approved its review gate, or a research question is answered, and the next phase opens with a new discussion. Use `after: "discuss"`.
4. **A long wait.** Everything is running and nothing will come back for a while.

## When not to compact

- A result has arrived and is not yet reviewed or committed.
- A merge is in progress.
- You are mid-exchange with a subagent or another session.
- The user has just given an instruction that is not yet written to disk.
- You are stuck or mid-derivation: chasing a failure you have not explained, halfway through reasoning out a design, or about to try the next fix. The working theory lives only in your context and a summary flattens it. Reach a resolved step first. If urgency forces compaction anyway, write the open line of reasoning into the handoff: what you tried, what you ruled out, and the current hypothesis.
- **The compaction point is a pause or blocking review gate the user asked for.** Do not compact until the user approves the gate. Once they approve, the phase has closed and compacting is natural.
- If work remains before such a pause or gate, compacting first is fine. After re-reading, work up to the gate and stop there.

A question for the user never blocks compaction. Write it in the handoff's open-questions section with your recommendation and default; after compaction you will ask it again.

## Urgency by context size

The mod nudges you three times as context grows.
Each note names its level and the session's configured sizes; the defaults are 400k, 700k and 850k tokens, and `/auto-compact status` shows the current ones.

- **Before the first nudge:** compact only at a major phase boundary before a big next phase.
- **After the first nudge:** take the next natural handoff point. Do not force one.
- **After the second nudge:** drive to a handoff point. Delegate the remaining reviews and follow-ups, draft the briefs the next waves need while you have the full context, rewrite the handoff, then compact.
- **After the third nudge:** compact at the first safe point, even if it is not ideal. The engine auto-compacts near the limit mid-turn, with no handoff.

## The handoff file

Rewrite it each time; do not append a log.
Keep it in the repo, never in a scratchpad or temporary folder (those are deleted).
Write it with the Write or Edit tool, not through Bash, Python or a heredoc.
If the project's `CLAUDE.md` names a handoff path, use it; otherwise use `docs/handoff.md`.
The plan and design docs are the source of truth; the handoff holds fast-changing state and pointers into them.
Standing rules belong in memory or `CLAUDE.md`, not the handoff.

It holds, in this order:

1. **Read after compaction.** The files to re-read with the sections to read, the same list you pass as `reread`.
2. **Goal and where we are.** The project goal in a line, the current phase or wave, and a pointer to the plan section.
3. **Running agents and jobs.** For each one:
   - name and id;
   - its brief file and the files it owns;
   - what "done" looks like, and what to do when it reports (review against which doc, then commit, then start what);
   - exact commands to resume or rerun it;
   - monitors and heartbeats to re-arm.
4. **Landed since the last handoff.** Commits, with one line each.
5. **The user's rulings and open questions.**
   - Rulings verbatim, with the date.
   - Open questions for the user, each with your recommendation and the default you will take.
   - Anything you proposed that the user has not approved, labelled "proposal".
6. **Environment.** Servers and ports, worktrees and branches, other sessions working on the same repo, outside resources such as GPU pods and how to reach them.
7. **Next steps.** What to do after re-reading, matching the `after` mode.

## Subagents

A subagent cannot be compacted at a handoff point; a big one is replaced instead. The mod helps both sides:

- **Inside a subagent:** the mod nudges it after a tool result as its context grows (defaults 350k, 500k, 700k):
  - first nudge: write a progress file when the current task is done;
  - second: drive to a good handoff point, write the progress file, report ready to be replaced;
  - third: stop at the first safe point, write the progress file, report.
- **The brief belongs to the main thread.** Once a subagent passes the first level, or first compacts, the mod saves its original brief verbatim and names that copy in its notes. Never rewrite a brief from memory.
- **A progress file holds state only:** its first line names the brief (the mod's copy, or the brief file), then where the task stands, what changed (files, commits), decisions and why, open threads, and what a fresh agent needs to carry on. It does not copy or restate the brief. It lives in the repo, next to the brief file if there is one, and the report names its path.
- **In the main thread:** a subagent under the first level (100–200k) can simply be resumed with SendMessage; it needs no progress file. A lead past it writes one when its task is done.
  - When a subagent past the first level reports back, the mod notes its size with the report. Decide then, before writing its next instruction.
  - For a new round of work, prefer a fresh agent. Its brief is three parts: the original brief (the path the mod's note names, unchanged), the progress file (path), and the new instruction. Write only the new instruction. If the new round changes the task itself, edit the brief file in the repo (the old version stays in git), or write a new one when it is a different task; either way the file you hand over is the brief. Never edit the mod's saved copy: copy it into the repo and edit that. Every resumed round re-sends the old agent's whole context.
  - Resume it when you want its full context: asking about its report, or recovering something from its work.
  - A SendMessage to such an agent is held once with this advice (configurable, on by default). Sending the same call again resumes it; that is a deliberate choice, not a workaround.
- If a subagent hits Claude Code's own auto-compaction anyway, the mod adds summary guidance and tells it to re-read its brief and progress file.

## When the mod asks after an idle spell

Claude Code compacts an idle session shortly before its prompt cache expires. The mod calls that off and asks you for a handoff instead, with "Idle: preparing a handoff before compaction (note above)."
Treat it like any other compaction point: if one of the moments above holds and nothing in "When not to compact" applies, rewrite the handoff and request compaction, usually with `after: "wait"`, since the user is away. If it does not, say why in one line and end your turn; the mod will not ask again until something new arrives.

## Calling request_compaction

- Rewrite the handoff after the last thing that arrived. The mod refuses a handoff modified before the latest prompt, notification or message.
- Pass `handoff`, `reread` (path, scope, why), `after` and `next`; `focus` only when the summary should stress something the handoff cannot hold.
- `reread` lists every file the handoff's reading section names, at the same scope; leave the handoff itself out, since it is always read first.
- `next` holds the steps after the reads. Do not restate a reading list in it ("re-read the handoff and notes, then …"): a shorter list there reads as leave to skip the rest.
- `after`:
  - `continue` when the next steps need nothing from the user;
  - `discuss` when the user has open questions to answer or a new phase starts with a discussion;
  - `wait` when the user asked you to stop after this point.
- End your turn right after the call. If anything arrives before the turn ends, the mod cancels the request; handle it, fold it into the handoff, and request again.

## After compaction

For a compaction you requested, the mod adds the re-entry note as a hidden message and starts your next turn with "Resuming from compaction (re-entry note above)." For one you did not request (the user's `/compact`, auto-compaction, idle compaction), the note follows the summary and says how old the handoff on record is; anything after it is only in the summary.
The note also states the repo's branch, HEAD and uncommitted file count at compaction time.

1. Re-read the handoff in full and every listed file at the listed scope, each with the Read tool, before acting on anything, including subagent notifications that arrived meanwhile. A copy restored into context does not count. After your first turn the mod names any listed file you did not open.
2. Check the handoff against the repo state in the note and the running agents' state (their output files). Where they disagree, trust the repo and the files.
3. Ask the user again any open questions the handoff lists.
4. Proceed as the `after` mode says.
