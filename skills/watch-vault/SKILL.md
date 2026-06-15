---
name: watch-vault
description: Watch an Obsidian vault (Annotated plugin) for comment threads and frontmatter actions (review, summarize), handled in the background — non-blocking. Use for "watch my vault" or "review my vault".
argument-hint: [vault-folder-scope]
---

You are setting up an event-driven vault watch on the vault scope: `$ARGUMENTS` (empty = whole vault, subject to the key's folder fence). Two channels, same non-blocking model: **comments** — line-anchored discussion (§1–5) — and **frontmatter actions** — note-level workflow state (§6).

This replaces the blocking `watch_comments` pattern: a Monitor polls the hosted endpoint in the background and injects one debounced line per note when something needs attention; you act on events via MCP tools and stay free otherwise.

## 1. Resolve configuration (in order)

- **Endpoint**: `$ANNOTATED_MCP_ENDPOINT` if set, else `http://127.0.0.1:27191`. Verify with `curl -s <endpoint>/health` — expect `{"ok":true,...}`. If unreachable, stop and tell the user (is Obsidian running? is the endpoint URL right for this session's location?).
- **Watch key**: must be in `$ANNOTATED_WATCH_KEY` (a *poll*-scope key minted in Obsidian → Settings → Annotated). Never print it. If missing, stop and ask the user to provide it as a session secret/env var.
- **MCP tools**: confirm the Annotated server's tools are available (`check_comments`, `read_comments`, `reply_to_comment`, `resolve_comment`, `read_note`, `patch_note` — possibly namespaced `mcp__<server>__...`). They authenticate with the *read/write* key via the user's MCP client config, not via this skill. If absent, tell the user to connect the MCP server (`<endpoint>/mcp`, Bearer read/write key) and stop.

## 2. Initial backlog scan

Call `check_comments` once with `path: "$ARGUMENTS"` (omit `excludeAuthors` — the server defaults to excluding your own identity). Handle everything it returns per §4 before arming the watch.

## 3. Arm the Monitor

Use the Monitor tool with the script bundled in this skill:

```
bash ~/.claude/skills/watch-vault/watch-comments.sh
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

## 6. Frontmatter watch — note-level actions (second channel)

Comments are line-anchored discussion; frontmatter is note-level workflow state. A human sets `annotated: <action>` on a note's frontmatter, you do the work, and you write a receipt back into the same field. Same non-blocking model, a second Monitor. Arm this when the user wants frontmatter workflows handled (or alongside the comment watch).

**The vocabulary lives in `actions/*.yml` next to this file** — one file per action, the **filename is the trigger**. Read them, and call the `get_config` MCP tool once (for the tag prefix, §7). Derive `WATCH_TRIGGERS` = the action filenames, comma-joined.

Arm a second Monitor with the bundled script:

```
bash ~/.claude/skills/watch-vault/watch-frontmatter.sh
```

Env: `WATCH_ENDPOINT=<endpoint>`, `WATCH_KEY_VAR=ANNOTATED_WATCH_KEY`, `WATCH_TRIGGERS=<action filenames>`, `WATCH_SCOPE=$ARGUMENTS` (omit if empty), `WATCH_FIELD=annotated` (default), defaults fine for `POLL_INTERVAL`/`DEBOUNCE_QUIET`. Initial backlog: call `check_frontmatter` with `{ triggers: [...], path: "$ARGUMENTS" }` once and handle results before arming.

Each event line: `frontmatter annotated=<value> on <note_path>`.

### The action grammar (each `actions/<name>.yml`)
- `do:` — what to do when a note carries this action. `{arg}` = the part after `/` in a compound value (`translate/spanish` → arg `spanish`; may be a comma list `spanish,french` → loop over each).
- `completedTag:` — the **receipt** you write when done (defaults to the filename's past tense; e.g. `review` → `reviewed`). A receipt always differs from its trigger — that is what makes "done" distinguishable and stops re-runs.
- `clearedBy:` — `agent` (a **request**: you write the receipt when done) vs `human` (a **mode**: you NEVER change the field; the human clears it).
- `output:` — where a result lands: `sibling` (a companion note — `create_note`, or replace its body with `patch_note` if it already exists), `section` (a managed heading block via `patch_note`), `comment`, or `none` (the work is its own side effect, e.g. `review` just leaves comments).

### Handling a frontmatter event
1. `read_note` the note; split the `annotated` value into root (before `/`) + arg.
2. Resolve `actions/<root>.yml`. **Unknown** value (no matching action file and not a known mode) → set `annotated: blocked` via `update_frontmatter` and leave a comment naming the value. **Never guess.**
3. Do the `do:` work; write any artifact per `output:`.
4. **Request** (`clearedBy: agent`): mark done — `update_frontmatter` set `annotated` to the `completedTag` (templating `{arg}` if the receipt uses it). **Mode** (`clearedBy: human`, e.g. `active`): perform the behavior, do NOT change the field — it's announced once, then it just modulates how you work in this scope.
5. Failure (can't fulfill, ambiguous, needs a human): set `annotated: blocked` + a comment explaining.

Your receipt writes never echo back — receipts aren't past-tense filenames, so they're not in `WATCH_TRIGGERS`. A note left mid-action at session death resurfaces on the next scan.

### Adding/changing workflows
Drop a new `actions/<verb>.yml` (filename = trigger; receipt defaults to past tense) — no change to this file. The user can edit any `do:`/`completedTag:`/`output:`.

## 7. Tags

When you make a **substantive** content edit, you may reconcile a note's tags to its content with the `tag_note` tool: `tag_note(path, add: [...], remove: [...])`. Pass **bare** tags (`draft`, `needs-source`) — the server namespaces them under the reserved prefix (default `bot/`) for you, so you write `bot/draft` without typing the prefix and **cannot** write outside it. The user's own (un-prefixed) tags are never touched. To see what you've already tagged, read the note — your tags are the `bot/*` ones. Add-biased; a trivial edit (a typo fix) doesn't warrant retagging.

Provenance fields (`created`/`createdBy`/`updated`/`updatedBy`) are stamped automatically by the server and the editor hooks — never write them yourself.
