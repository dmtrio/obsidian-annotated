# Annotated

Code-review-style **comments** for Obsidian notes — and an **MCP server** that lets Claude (or any MCP client) read those comments, reply, resolve, and edit the note, all over your vault.

Two channels work together:

- **Comments** — line-anchored threads on a note (select text → comment). A human and an agent discuss; the agent can apply a clear request and resolve.
- **Frontmatter actions** — note-level workflow state in YAML (`annotated: review` / `summarize` / `translate/…`). A human sets the field, the agent does the work and writes a receipt (`reviewed`). The request and its fulfilment live in the same data — no cursor, crash-recovery free.

Comments live in a sibling `*.comments.json` sidecar (never inside the note). Agent access is through **identity-bound, capability-tiered, folder-fenced keys** minted in **Settings → Annotated**.

## Repository layout

The repo is organised into clear sibling parts:

| dir | what's in it |
|-----|--------------|
| `plugin/` | the Obsidian plugin — UI, settings, editor hooks, comment manager, i18n, provenance stamping |
| `server/` | the MCP server + OAuth gate + the plugin↔server host binding (`AnnotatedMcpServer`, `OAuthGate`, `PluginMcpHost`) |
| `shared/` | `comments-core` — the host-agnostic core (comment store, auth/tier logic, frontmatter, the sidecar schema). Published as the `@annotated/comments-core` workspace package |
| `skills/` | agent skills — `review-vault` (MCP-only review) and `watch-vault` (background watch) |
| `tests/` · `scripts/` · `docs/` | test suites · build tooling (skill packager, monitor scripts) · design docs (PLNs) |

The server **core** (`AnnotatedMcpServer`, `OAuthGate`) imports no `obsidian` and is fully tested in plain Node (`tests/`); `PluginMcpHost` is the thin host binding that wires it to the vault.

## Install

- **Manual:** build (below), then copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/obsidian-annotated/` and enable it in Settings → Community plugins.
- **From source:** `npm install && npm run build` (writes `main.js`). `npm run dist` also stages the loadable bundle under `dist/obsidian-annotated/`.

Requires Obsidian ≥ 1.5.0. Works on desktop and mobile (the MCP server is desktop-only).

## The MCP server

Enable it in **Settings → Annotated**. Endpoints:

- **Local:** `http://127.0.0.1:27191/mcp`
- **Remote** (behind your reverse proxy, TLS terminated on 443 — the server speaks plain HTTP internally): `https://<your-host>/mcp`, plus `/comments/actionable`, `/frontmatter/actionable`, and an open `/health`.

Optionally enable the **OAuth sign-in** toggle so OAuth-only clients (claude.ai connectors) can paste a key once on an authorize page. The OAuth gate is compiled out of the lite build (`npm run build:lite`).

## Access keys & capability tiers

Each mint in Settings → Annotated creates a **pair** bound to one identity (the key carries the identity, so give each client its own; a key can be **fenced** to specific root folders). Capability is an ordered ladder:

| tier | token | grants |
|------|-------|--------|
| **poll** | `ann_poll_…` | read/search/list notes & comments + the actionable feed (drives review/watch polling) |
| **additive** | `ann_additive_…` | everything in poll **+** write: reply, resolve, comment, patch, append, create note, frontmatter, tags |
| **destructive** | `ann_destructive_…` | everything in additive **+** move & delete (to trash) |

Two mint buttons:

- **Create Read/Write** → a `poll` + `additive` pair (the common case).
- **Create Read/Write + Move/Delete** → a `poll` + `destructive` pair.

The pair always includes a `poll` key, so a 24/7 watcher can run read-only even if it leaks. Tools are gated by **conditional registration** — a key never even *sees* a tool above its tier. (Legacy `full`/`watch` keys still work; they normalise to `additive`/`poll`.)

### MCP tools by tier

| tier | tools |
|------|-------|
| **poll** | `check_comments` · `check_frontmatter` · `read_comments` · `read_note` · `read_multiple_notes` · `list_commented_notes` · `list_notes` · `search_notes` |
| **additive** | `add_comment` · `reply_to_comment` · `resolve_comment` · `patch_note` · `append_note` · `create_note` · `update_frontmatter` · `tag_note` |
| **destructive** | `move_note` · `delete_note` |

## Connecting a client

**Claude Code (CLI)** — an additive (or destructive) key as a bearer header:

```sh
claude mcp add --transport http annotated \
  https://<your-host>/mcp \
  --header "Authorization: Bearer ann_additive_…"
```

Use `http://127.0.0.1:27191/mcp` if it runs alongside your local Obsidian.

**claude.ai / Claude Desktop (connector)** — add a custom connector with URL `https://<your-host>/mcp`, leave the OAuth fields empty; on connect, paste an Annotated key once on the authorize page. (Requires the **OAuth sign-in** toggle on that instance.)

## Reviewing & watching the vault

Two skills, for two runtimes:

- **`review-vault`** — a synchronous, **MCP-only** review pass: it scans for open comment threads and notes flagged `annotated: review`, handles each (edit on a clear request; critique comments + `reviewed` receipt on flagged notes), and loops until the scope is quiet. No bash, no background watcher — so it runs anywhere the MCP connector works, **including claude.ai**. Say *"review my vault"*.
- **`watch-vault`** — an event-driven **background** watch (comments + frontmatter actions). It arms a Monitor that polls the actionable endpoints and wakes the agent on events. Needs a host with a Monitor primitive **and** bash network egress to the endpoint (e.g. Claude Code), so it does **not** run on claude.ai.

`watch-vault` uses the **poll** key as an environment variable (read by name, never inlined or printed):

```sh
export ANNOTATED_WATCH_KEY=ann_poll_…
export ANNOTATED_MCP_ENDPOINT=https://<your-host>   # omit for local 127.0.0.1:27191
claude
```

A watcher Claude wants **both** keys from the same pair: the `poll` key (env var) so the monitor wakes it, and an `additive` key (`claude mcp add`) so it can act.

Package a skill for upload with `npm run skill:zip:review` (or `npm run skill:zip` for `watch-vault`) → `dist/<skill>.zip`.

## The sidecar format

Comments are stored in `*.comments.json` next to each note. The format is the cross-tool contract — see [`shared/comments-core/schemas/COMMENTS-FORMAT.md`](shared/comments-core/schemas/COMMENTS-FORMAT.md) and the JSON Schema beside it.

## Development

| script | does |
|--------|------|
| `npm run dev` | esbuild watch (inline sourcemaps) |
| `npm run build` | production bundle → `main.js` |
| `npm run build:lite` | production bundle with the OAuth gate tree-shaken out (community-store artifact) |
| `npm run dist` | build + stage `main.js`/`manifest.json`/`styles.css` under `dist/obsidian-annotated/` |
| `npm test` | Vitest (`tests/` + `shared/*/tests/`) |
| `npm run skill:zip` / `:review` | package a skill into `dist/<skill>.zip` |

Design history lives in [`docs/`](docs/) (the PLNs). The current behaviour is this README.

## License

MIT © Demetrio Urquidi
