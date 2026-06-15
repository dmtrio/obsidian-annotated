---
status: accepted
created: 2026-06-13
parent: PLN - Event-Driven Comment Watch
depends: PLN - Frontmatter & File Watch
repos:
  - obsidian-Annotated
---
# PLN — Note Provenance & Tags

> **Implementation status: shipped in v0.1.6 (provenance) / v0.1.7 (server-enforced `tag_note`); live verification is a per-deploy runtime check.** Steps 1–4 implemented and tested: list-aware `update_frontmatter`, `stampProvenance` wired into all MCP write tools (gated on identity, git-style `name <id>`, write-once `created`), the `ProvenanceStamper` editor hooks for UI edits (loop-guarded), and the synced `tagPrefix` setting + the server-enforced `tag_note` tool (the server prepends the prefix; the agent passes bare tags and cannot escape the namespace) + skill tag policy. Step 5 (live verification) waits on deploying the current build.

> Stamp general provenance (`created`/`createdBy`/`updated`/`updatedBy`) onto notes as a side effect of writing them, and let the agent maintain content-derived tags under a reserved namespace. Distinct from [[PLN - Frontmatter & File Watch]] (the *watch channel* / action vocabulary) but shares its `update_frontmatter` tool and editor-hook plumbing — so it depends on that plan's tool landing first.

---

## Purpose

The plugin currently writes **nothing** into note frontmatter automatically — comments live in sidecars, body edits touch only their target bytes, `create_note` writes only authored content. So note frontmatter is 100% the user's today. Two additions are wanted, with *opposite* risk profiles, kept deliberately separate:

1. **Provenance** — mechanical who/when metadata stamped as a side effect of any write. No judgment. The value is real in a multi-identity world: "Claude created this, Demetrio last edited it."
2. **Tags** — content-derived classification the agent maintains. Pure judgment. Useful, but must never silently clobber the user's hand-curated tag vocabulary (248 notes, 184 tags, `ai`/`mcp`/`game-design`/… — surveyed 2026-06-13).

These ride on the same machinery (`update_frontmatter` + editor hooks) but are governed by different rules below.

**Definition of done**

- [ ] A note created through any path gains `created` (bare date) + `createdBy` (identity), write-once.
- [ ] Any real content **or** frontmatter change — agent writes *and* the user's Obsidian-UI edits — updates `updated` + `updatedBy`. Reads and no-op writes never stamp.
- [ ] Stamping is gated on an identity existing — an unchosen name is never written (carried from the comment-watch identity rule).
- [ ] The agent can add/remove tags only within a reserved, configurable prefix (default `bot/`); it never touches the user's flat tags. Tag writes go through list-aware `update_frontmatter`, not string surgery.
- [ ] The editor hook does not loop — the plugin's own stamp write is not re-stamped.
- [ ] No churn: a provenance stamp rides along with the edit that triggered it (same save), never a separate revision.

## Decisions

- **D1 — Four scalar fields, not a compound string.** `created`, `createdBy`, `updated`, `updatedBy`. Separating date from author keeps each cleanly queryable (Dataview "notes Claude created", "edited this week") and — bonus — leaves `created` a **bare date**, matching the convention already in use across the vault's PLN/LOG frontmatter (additive, not a type change to existing notes). The split is consistent: **dates are bare, authors are git-style** —
  ```yaml
  created: 2026-06-13
  createdBy: claude <i_c33ddf55>
  updated: 2026-06-14
  updatedBy: demetrio <i_7f7f832c>
  ```
  - **Both `createdBy` and `updatedBy` carry name *and* id, git-style** (`name <id>`). Name-first so search/group keys on the readable name; the id in brackets survives identity renames and disambiguates same-named identities — exactly git's `Author Name <email>`. Visible (frontmatter has no hidden values), which on reflection is a benefit for a historical record.

- **D2 — Stamping rules.** `created`/`createdBy` are **write-once** at creation, never rewritten. `updated`/`updatedBy` stamp on **every real change — body or frontmatter** (including a tag edit or a watch receipt like `annotated: reviewed`; the user's call: "updates to frontmatter should change updated"). Never on reads, never on a no-op write. The stamp is **bundled into the triggering save** (one revision, not two) — which is what dissolves the churn concern that would otherwise apply (cf. the rejected per-keystroke line-number idea, LOG 2026-06-12). Gated on an identity existing: no identity selected → no stamp (never writes an unchosen name).

- **D3 — Coverage via two editor hooks; loop-guarded.** Agent writes through MCP stamp themselves trivially. The user's **UI edits** need plugin hooks or the fields lie ("last edited by Claude" when the user edited after):
  - `vault.on("create")` → write-once `created`/`createdBy`.
  - `vault.on("modify")` (debounced) → `updated`/`updatedBy`.
  - **Loop guard:** the plugin's own stamp write fires `modify` again, so it must ignore writes whose only delta is the stamp (a transient in-progress flag, or a "frontmatter-stamp-only ⇒ skip" check). This is the **echo-loop pattern a third time** — comment self-exclusion, frontmatter receipts, now provenance — killed the same proven way each time, so it's tractable, not novel risk. (Precedent: the "Update time on edit" community plugin is exactly this hook.)

- **D4 — Identity source reuses the existing model.** Agent writes → the key's identity. UI edits → the device's selected UI-default identity (`uiIdentityId`). Both resolve through the same synced identity registry, so provenance attribution is consistent with comment attribution — one identity model, two surfaces.

- **D5 — Agent tags live under a reserved, configurable prefix (default `bot/`), enforced server-side.** The agent adds/removes only tags it owns — `bot/draft`, `bot/needs-source` — and never touches the user's flat tags, killing the two-writers-one-list clobber. **The namespace is enforced by the server, not the agent's good behavior:** the `tag_note(path, add, remove)` tool prepends the configured prefix (idempotently) before writing, so the agent passes *bare* tags and structurally cannot write outside `bot/`. (Earlier sketch had the agent read the prefix via a `get_config` tool and prepend it; server-enforcement is strictly better — a hard invariant, simpler agent, and the boundary owned by the component that should own it.) Default `bot/` chosen because the 2026-06-13 survey found it unused, readable, and never a plausible *topic* (whereas `ai/` would have nested the vault's #1 tag). **The prefix is a synced setting** (`data.json`, not device-local) — tags are shared note content, so two devices must agree or the tag tree fragments. Tag management is an **edit-time capability, not mandatory on every edit**: the agent *may* reconcile its namespace when it makes a *substantive* content change, add-biased — a typo fix shouldn't retag. `blocked`-style guardrails (never guess, fail loud) carry over from the watch vocabulary.

- **D6 — `update_frontmatter` gains list-aware ops.** The watch PLN's `update_frontmatter` sets/clears scalar fields; tags need **add-item / remove-item** on a list field so the agent edits `tags:` structurally — adding/removing one entry without disturbing siblings, body, or YAML formatting. Removal via `patch_note` string-surgery on a YAML array (`tags: [a, b]` → `tags: [a]`) is explicitly rejected: array style/order/inline-vs-block all break the exact match. This is the single shared dependency on [[PLN - Frontmatter & File Watch]].

## Plan

> One commit per step in `obsidian-Annotated`. **Blocked on the watch PLN's `update_frontmatter` tool** (and on deploying v0.1.5's note-write tools). Container/UI deploy rides livesync.

1. **`update_frontmatter` list-aware ops (D6).** Extend the watch PLN's tool with add-item/remove-item for list fields; round-trip unknown fields + body byte-for-byte; fence-checked. *Accept: add/remove a tag with unknown sibling fields + body preserved; scalar set/clear unaffected; over HTTP.*
2. **Provenance stamping on MCP writes (D1/D2/D4).** `create_note` stamps `created`/`createdBy`; `patch_note`/`append_note`/`update_frontmatter` stamp `updated`/`updatedBy`, bundled into the same save, gated on identity, write-once for `created`. Git-style `name <id>`. *Accept: unit tests for each tool — fields appear/advance correctly, `created` never rewritten, no stamp without an identity, no stamp on a no-op.*
3. **Editor hooks for UI coverage (D3).** `vault.on("create")` + debounced `vault.on("modify")`, loop-guarded; stamps use the device identity. *Accept: a UI create/edit (simulated via the vault adapter in tests) stamps correctly; the plugin's own stamp write does not re-fire; debounce collapses a burst.*
4. **Agent tag namespace + prefix setting (D5).** Synced `tagPrefix` setting (default `bot/`); skill rules for add-biased, namespace-only tag reconciliation on substantive edits. *Accept: agent adds/removes only `bot/*`; user's flat tags untouched across an edit; changing the prefix setting is honored and syncs.*
5. **Live verification + docs.** Create a note (agent + UI), edit both ways, confirm all four fields; agent tags a note, confirm only `bot/*` changes; README / parent LOG. *Accept: DoD demonstrated live on the container and the Mac.*

## Risks / notes

- **Churn** — mitigated by D2 (stamp rides the triggering save). The only way it bites is stamping on reads/no-ops, which the rules forbid.
- **`created` convention** — kept as a bare date precisely to *not* retype the field across the ~248 existing notes; `createdBy` etc. are additive.
- **Backfill** — existing notes have no provenance; this stamps **going forward only**. A one-shot backfill (e.g. `createdBy` from git/sidecar history) is explicitly out of scope unless asked.
- **Two-writer races** — agent stamp vs. a simultaneous UI edit is last-write-wins, same as comments; the single-CommentStore path mitigates within an instance, cross-instance is sync-mediated.
- **Tag prefix as content** — because the prefix is written into notes, changing it later doesn't rename already-written `bot/*` tags; a migration would be a separate one-shot. Noted so the default (`bot/`) is chosen to last.
- **`metadataCache` vs. disk** — the plugin host reads frontmatter from `metadataCache`; a future stdio host parses from disk (same injected-source pattern as the watch query).
