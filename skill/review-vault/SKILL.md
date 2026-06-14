---
name: review-vault
description: Review an Obsidian vault scope over MCP — handle open comment threads and notes flagged for review, editing on clear requests, until the scope is quiet. Use for "review my vault".
argument-hint: [vault-folder-scope]
---

You are running a review pass over the vault scope: `$ARGUMENTS` (empty = whole vault, subject to the key's folder fence). Two channels: **comment threads** (line-anchored discussion) and **review requests** (`annotated: review` in a note's frontmatter).

This is a **synchronous, MCP-only** skill — for hosts (like claude.ai) that have the Annotated MCP connector but no background Monitor and no bash network egress. It **polls agent-side**: every tool here returns immediately and you drive the loop. It drains what's outstanding now and stops — it does not wait for future events. To re-check later, run it again (or wrap it in `/loop <interval>`).

## 1. Preflight — MCP only

Confirm the Annotated MCP tools are available: `check_comments`, `read_comments`, `read_note`, `add_comment`, `reply_to_comment`, `resolve_comment`, `patch_note`, `check_frontmatter`, `update_frontmatter` (possibly namespaced `mcp__<server>__…`). They authenticate through the MCP connector, which must hold a **read/write key** — this skill replies, resolves, edits, and writes receipts.

- If the tools are missing, stop and tell the user to connect the Annotated MCP server (`<endpoint>/mcp`, Bearer read/write key).
- **Do NOT** use bash, `curl`, or a Monitor. They don't work where this skill runs; everything goes through the MCP client. If you reach for the shell, you're in the wrong skill — `watch-vault` is the bash/Monitor one.

## 2. The review drain

Repeat the two passes below until **one full round changes nothing** — no actionable comments and no notes still flagged for review. Each tool returns immediately; the loop is yours. A single clean round ends the session (it's a drain, not a wait).

### Pass A — comment threads
`check_comments` with `path: "$ARGUMENTS"` (omit `excludeAuthors`; the server excludes your own identity). For each thread returned, `read_comments` for the full bodies and **`read_note`** for context, then decide:

**Action** — a specific, unambiguous change to the note ("reverse this list", "remove this bullet", "fix the typo", "move this under Goals"):
1. Apply it with `patch_note` (exact-string replace; pick an unambiguous `oldString`, always pass `newString`).
2. Reply in-thread (`reply_to_comment`) with one short sentence saying what changed.
3. `resolve_comment` it.

**Discussion** — a question, a concern, or anything ambiguous:
1. Reply in-thread with your answer or a focused clarifying question.
2. Do NOT resolve — the human resolves discussions, or asks you to.

Never edit the note for a discussion-type comment; never resolve a thread whose request you didn't fulfill. Your replies are identity-stamped automatically and won't come back as new threads.

### Pass B — review requests
`check_frontmatter` with `{ field: "annotated", triggers: ["review"], path: "$ARGUMENTS" }`. For each note returned, `read_note`, then:
1. **Review it:** read the whole note and leave a comment on each spot with a real problem — unclear wording, a claim that needs support, broken structure, a gap. Use **`add_comment`** (a *new* thread anchored to the line range; `reply_to_comment` is only for existing threads). Discuss; do not rewrite the note.
2. **Write the receipt:** `update_frontmatter(path, set: { annotated: "reviewed" })` — this marks the note done and stops it re-surfacing.
3. **If you can't review it** (ambiguous, needs a human, missing context): `update_frontmatter(path, set: { annotated: "blocked" })` and `add_comment` explaining why. Never guess. Only handle the value `review` here — leave any other `annotated:` value alone.

## 3. Between passes

Nothing to track — replying/resolving and writing the receipt *are* the processed markers (no cursor, no state). After handling everything in A and B, scan both once more. When a round surfaces nothing new, stop.

## 4. Tags (optional, on substantive edits)

If an Action edit was substantive, you may reconcile the note's tags with `tag_note(path, add: [...], remove: [...])`. Pass **bare** tags (`draft`, `needs-source`) — the server namespaces them under the reserved prefix (default `bot/`) and won't let you write outside it; the user's own tags are never touched. Add-biased; a typo fix doesn't warrant retagging. Never write provenance fields (`created`/`createdBy`/`updated`/`updatedBy`) — the server stamps those.

## 5. Summary on exit

Print a brief summary: comments addressed (action vs discussion), notes reviewed, edits made, threads left open (and why), notes blocked. Remind the user this was a one-time pass — re-run to check again.
