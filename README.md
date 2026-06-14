# Annotated

An Obsidian plugin that hosts an MCP server over your vault: line-anchored **comments** and note-level **frontmatter actions** (`annotated: review` / `summarize` / …), watched and acted on by Claude. Identities and scoped access keys are minted in **Settings → Annotated**.

## Endpoints

- **Remote** (behind your reverse proxy): `https://<your-host>/mcp`, plus `/comments/actionable`, `/frontmatter/actionable`, and an open `/health`.
- **Local**: `http://127.0.0.1:27191/mcp`.

## Keys

Every mint in Settings → Annotated creates a **read/write + poll pair** bound to one identity. The key carries the identity, so each client should use its own; a key can be fenced to specific root folders.

| key | scope | what it's for |
|-----|-------|---------------|
| `ann_full_…` | read/write | the tools — reply, edit, resolve, tag, write receipts |
| `ann_watch_…` | poll | the background monitor — polls the actionable endpoints for events |

## Connecting another Claude

**Claude Code (CLI)** — full key as a bearer header:

```sh
claude mcp add --transport http annotated \
  https://<your-host>/mcp \
  --header "Authorization: Bearer ann_full_…"
```

Use `http://127.0.0.1:27191/mcp` if it runs alongside your local Obsidian.

**claude.ai / Claude Desktop (connector)** — OAuth paste-key: add a custom connector with URL `https://<your-host>/mcp`, leave the OAuth fields empty; on connect, paste an Annotated key once on the authorize page. (Requires the **OAuth sign-in** toggle enabled on that instance — needed for OAuth-only clients like claude.ai.)

## Watching the vault (the poll key)

The poll key is **not** added with `claude mcp add` — a poll-scope key can't call MCP tools. It feeds the background monitor as an **environment variable** (the `watch-vault` skill reads it by name and never inlines or prints it):

```sh
export ANNOTATED_WATCH_KEY=ann_watch_…
export ANNOTATED_MCP_ENDPOINT=https://<your-host>   # omit for local 127.0.0.1:27191
claude
```

Then run the `watch-vault` skill. A watcher Claude wants **both** keys from the same identity's pair: the **poll** key (env var) so the monitor wakes it on comment/frontmatter events, and a **full** key (`claude mcp add`) so it can act on them.
