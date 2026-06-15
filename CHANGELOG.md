# Changelog

Notable changes to Annotated. Format loosely follows [Keep a Changelog](https://keepachangelog.com/). For current behaviour see the [README](README.md); for design rationale see [`docs/`](docs/).

## [0.2.0] — 2026-06-15

### Added
- **Capability tiers** — access keys are an ordered ladder `poll < additive < destructive` (replacing the binary full/watch model). Each MCP tool declares a minimum tier and is gated by conditional registration, so a key never sees a tool above its tier. Settings mints with two buttons — *Create Read/Write* (`poll`+`additive`) and *Create Read/Write + Move/Delete* (`poll`+`destructive`) — each a pair sharing one identity.
- **Navigation tools** (poll): `list_notes`, `read_multiple_notes`, `search_notes`.
- **Structural tools** (destructive): `move_note`, `delete_note` — recoverable (trash); the comment sidecar follows the note.
- **`review-vault` skill** — a synchronous, MCP-only review pass (handles open comment threads + notes flagged `annotated: review`). Needs no Monitor or bash egress, so it runs on claude.ai.

### Changed
- Repository restructured into sibling parts: `plugin/` (UI/settings), `server/` (MCP + OAuth), `shared/` (`comments-core`), `skills/`.
- `watch-vault-comments` skill renamed to `watch-vault` (it covers comments **and** frontmatter actions).
- Expanded the README (overview, repo map, tiers, tools, skills); corrected the comment-format spec to document `author_id` / `resolved_by_id` / `is_stale`.
- Legacy `full`/`watch` keys normalise to `additive`/`poll` (no re-mint required).

## [0.1.7]

### Changed
- Tags are **server-enforced** via the `tag_note` tool — the server prepends the reserved `bot/` prefix, so the agent passes bare tags and structurally cannot escape the namespace. The `get_config` tool was removed (superseded).

## [0.1.6]

### Added
- **Frontmatter watch** — note-level `annotated:` actions, the `update_frontmatter` and `check_frontmatter` tools, the `/frontmatter/actionable` endpoint, and the watch-frontmatter monitor + skill vocabulary (`actions/*.yml`).
- **Provenance stamping** — `created` / `createdBy` / `updated` / `updatedBy` written on every change, from both MCP writes and the editor hooks for UI edits.
- Synced reserved tag-prefix setting (default `bot/`).

## Earlier (0.1.x foundation)

- Code-review-style comments on notes, stored in `*.comments.json` sidecars (see the [format spec](shared/comments-core/schemas/COMMENTS-FORMAT.md)).
- In-plugin MCP server with identity-bound, folder-fenced access keys.
- OAuth sign-in shim for OAuth-only connectors (e.g. claude.ai), tree-shaken out of the lite build.
- Note-write tools: `create_note`, `append_note`, `patch_note` (with punctuation-folding).
