---
name: watch-vault-comments
description: Arm a background Monitor that watches an Obsidian vault scope for comment activity via the Annotated plugin's hosted endpoint, then act on each comment event through MCP tools (reply, edit the note, resolve). Non-blocking — the conversation stays free between events. Use when the user wants comments watched/handled while working on other things, or says "watch my vault comments".
argument-hint: [vault-folder-scope]
---

You are setting up an event-driven comment watch on the vault scope: `$ARGUMENTS` (empty = whole vault, subject to the key's folder fence).

This replaces the blocking `watch_comments` pattern: a Monitor polls the hosted endpoint in the background and injects one debounced line per note when threads need attention; you act on events via MCP tools and stay free otherwise.

## 1. Resolve configuration (in order)

- **Endpoint**: `$ANNOTATED_MCP_ENDPOINT` if set, else `http://127.0.0.1:27191`. Verify with `curl -s <endpoint>/health` — expect `{"ok":true,...}`. If unreachable, stop and tell the user (is Obsidian running? is the endpoint URL right for this session's location?).
- **Watch key**: must be in `$ANNOTATED_WATCH_KEY` (a *poll*-scope key minted in Obsidian → Settings → Annotated). Never print it. If missing, stop and ask the user to provide it as a session secret/env var.
- **MCP tools**: confirm the Annotated server's tools are available (`check_comments`, `read_comments`, `reply_to_comment`, `resolve_comment`, `read_note`, `patch_note` — possibly namespaced `mcp__<server>__...`). They authenticate with the *read/write* key via the user's MCP client config, not via this skill. If absent, tell the user to connect the MCP server (`<endpoint>/mcp`, Bearer read/write key) and stop.

## 2. Initial backlog scan

Call `check_comments` once with `path: "$ARGUMENTS"` (omit `excludeAuthors` — the server defaults to excluding your own identity). Handle everything it returns per §4 before arming the watch.

## 3. Arm the Monitor

Use the Monitor tool with the script bundled in this skill:

```
bash ~/.claude/skills/watch-vault-comments/watch-comments.sh
```

Environment for the Monitor (no secrets inline — reference the env var by name):

- `WATCH_ENDPOINT=<endpoint>`
- `WATCH_KEY_VAR=ANNOTATED_WATCH_KEY`
- `WATCH_SCOPE=$ARGUMENTS` (omit if empty)
- defaults are fine for `POLL_INTERVAL` (30s) and `DEBOUNCE_QUIET` (50s)

Each injected event line looks like: `new comments on <note_path>: <id>[, <id>...]`
A line `watch-comments: endpoint unreachable for 5+ minutes` means the server is down — tell the user once, keep the monitor running (it recovers by itself).

The monitor dies with the session (watcher, not daemon). Re-arming = re-invoking this skill. Expect comment-to-event latency of vault-sync + poll interval + debounce — tell the user roughly this once when armed.

## 4. Handling each event

On an event for `<note_path>`: call `check_comments` with `path: <note_path>`, then `read_comments` for full thread bodies, and **read the note** with `read_note` before responding. For each actionable thread, decide:

**Action** — the comment requests a specific, unambiguous change to the note ("reverse this list", "remove this bullet", "fix the typo", "move this under Goals"):
1. Apply it with `patch_note` (exact-string replace; pick an unambiguous `oldString`, always pass `newString`).
2. Reply in-thread (`reply_to_comment`) with one short sentence saying what changed.
3. `resolve_comment` it.

**Discussion** — the comment asks a question, raises a concern, or is ambiguous:
1. Reply in-thread with your answer or a focused clarifying question.
2. Do NOT resolve — the human resolves discussions, or asks you to.

Never edit the note for a discussion-type comment; never resolve a thread whose request you didn't fulfill. Your replies are stamped with your key's identity automatically — your own replies will not echo back as events.

## 5. Between events

Nothing. There is no cursor or state to maintain (replying/resolving *is* the processed marker). Continue whatever else the conversation is doing; the Monitor wakes you when comments need attention. A comment left unhandled at session death resurfaces on the next session's first scan — by design.
