---
status: draft
created: 2026-06-13
parent: PLN - Event-Driven Comment Watch
repos:
  - obsidian-Annotated
---
# PLN — Frontmatter & File Watch

> Extend the event-driven watch from line-anchored comments to **note-level workflow state**. A human sets a frontmatter field (`annotated: review`); the same actionable-by-construction machinery that drives comment watching treats "field at a trigger value, in scope" as an event; the agent does the work and writes the field forward to a receipt. The request and its fulfillment live in the same data — no cursor, crash recovery free. Follow-on to [[PLN - Event-Driven Comment Watch]] (shipped, live on the container) and [[PLN - MCP OAuth Shim]] (done). This is the parked "designed-but-deferred" backlog from the LOG (2026-06-12), promoted to its own plan.

---

## Purpose

Comments are the right channel for *line-anchored discussion* — "this sentence is wrong", "reverse this list". They're the wrong channel for *note-level workflow* — "review this whole note", "summarize this", "keep this in context while you work". Those are properties of the note, not of any line, and the vault already has a place for note-level properties: frontmatter. The user's own `status: draft → accepted` playbook is exactly this pattern used by hand.

Frontmatter is uniquely suited to be a watch channel because it is **self-clearing by the same actor model that makes comments work**: a human writes the request value, the agent writes the receipt value, and "is there a request value here right now" is a stateless, idempotent question — precisely the actionable-by-construction property (PLN — Event-Driven Comment Watch, Decision 3) that let comment watching drop its cursor. Obsidian's `metadataCache` already indexes every note's frontmatter, so the server side is nearly free — no file reads to detect state.

The result is a clean **two-channel model**:
- **Comments** = line-anchored discussion; cleared by reply/resolve.
- **Frontmatter** = note-level workflow state; cleared by the agent writing a receipt (or a human flipping a mode off).

**Definition of done**

- [ ] A watch surface (endpoint + `check_frontmatter`-style tool) returns notes whose frontmatter holds a *trigger* value, scoped by folder and clamped by the key's fence — statelessly, like `/comments/actionable`.
- [ ] The plugin server exposes `update_frontmatter` (set/clear a single field) so the agent can write receipts; it round-trips unknown frontmatter fields and body content untouched.
- [ ] The monitor announces one event per note when a trigger value appears, deduped by `path + value` so a re-request (receipt → request) re-announces but the agent's own receipt write does **not** echo back (the frontmatter analog of the comment echo loop).
- [ ] The skill carries a **user-editable vocabulary table** mapping values → meaning; the plugin/server stay value-agnostic (they transport "note X has `annotated: Y`", they don't interpret Y).
- [ ] Grammar is enforced by convention, not by an enum: imperative verb = request, its past tense = receipt (`review → reviewed`, `summarize → summarized`, `translate → translated` works the day it's invented); modes (human-cleared) and failure states are the only explicitly-listed values; an unknown/ambiguous value fails loudly into `blocked` + a comment, never a guess.
- [ ] No silent state loss: a note left at a trigger value when the session dies resurfaces on the next session's first scan, exactly like an unhandled comment.

## Decisions

- **D1 — Frontmatter is a value-agnostic transport; meaning lives in the skill.** The plugin and server never hardcode `review`/`summarize`/etc. They answer "which notes in scope have field `annotated` set, and to what". The vocabulary — what each value *means* and what work it triggers — is a table in the watch skill, editable by the user. **A new workflow is a skill edit, never a plugin release.** This mirrors how the comment watch kept policy (action-vs-discussion) in the skill, not the server.

  - **D1a — The vocabulary table is a *bundled file*, not inline prose.** A skill is a directory; `SKILL.md` can ship sibling files and reference them (the existing `watch-vault-comments` skill already bundles `watch-comments.sh` this way). So the table lives in its own `vocabulary.md` next to `SKILL.md`, loaded on demand. The layering: **`SKILL.md`** holds the stable grammar + handling rules (request→work→receipt, blocked-on-unknown, echo-guard); **`vocabulary.md`** holds the user-customizable value table (modes + any explicitly-named values). A new user clones the skill and edits one short, human-readable file — never the prose, never the logic.
    - *Trigger-list fork (the table has two readers):* the agent reads `vocabulary.md` for *meaning*, but the **monitor (bash)** needs a flat *trigger allowlist* (`triggers=…`) for the D3 echo-guard. Keep one source of truth via either **(a)** markdown `vocabulary.md` + a sibling plain `triggers.txt` / `WATCH_TRIGGERS` env (each file matched to its reader — *leaning this*, since the markdown table is what makes it approachable), or **(b)** a single YAML/JSON vocabulary the agent reads natively and a `jq`/grep one-liner feeds to the monitor. Settle at step 4.

- **D2 — Grammar by convention, enum only where it must be.** Three value *kinds*, distinguished by part of speech, each with different clearing semantics:
  - **Requests** (imperative verb — *agent* clears by writing the receipt): `annotated: review` → agent reads the note, leaves comments → writes `annotated: reviewed`. `annotated: summarize` → agent produces a summary → `annotated: summarized`.
  - **Receipts** (past tense — agent-written, terminal): `reviewed`, `summarized`. Preferred over *deleting* the field: a visible audit trail, Dataview-queryable, and a human re-triggers by flipping the receipt back to a request (the ledger re-announces on value change).
  - **Modes** (adjective — *human* clears; a standing state, not an event): `annotated: active` = keep this note in working context while watching this scope. Announced once when it appears, then it modulates behavior rather than generating repeat events.
  - **Failure** (`annotated: blocked`): the agent couldn't fulfill a request (ambiguous value, missing capability, work that needs a human). It writes `blocked` **and** leaves a comment explaining — frontmatter carries the state, the comment thread carries the conversation.
  - The receipt-is-past-tense convention means most new verbs need no registration: `translate → translated` is derivable mechanically. Only modes (human-cleared, can't be guessed from grammar) and failure states need to be listed. A value is **unknown** when it is *neither* a recognizable imperative-verb request *nor* a listed mode/failure — e.g. `annotated: urgent` (an adjective, so not a derivable request; and absent from the skill's mode list). Unknown values are **not** guessed — the agent writes `blocked` + a comment naming the unrecognized value, never inventing an action for it.

- **D3 — Echo-loop prevention (the frontmatter analog of the comment self-exclusion).** The agent writes receipts, and a naive watcher would see its own `reviewed` write as a fresh event. Two composable guards, mirroring how the comment watcher excludes its own identity:
  - **The "announce only non-past-tense" convention**: receipts are past tense, so a watch that triggers only on imperative/mode values structurally ignores the agent's own writes.
  - **An explicit trigger allowlist** on the watch surface (`triggers=review,summarize,active,...`) for cases where convention isn't enough — the watcher announces only listed values, so receipt writes fall outside it.
  - Ledger key is `path + hash(field value)` (not just `path`): a human flipping `reviewed → review` changes the value, so the ledger re-announces; the agent flipping `review → reviewed` also changes the value, but `reviewed` isn't a trigger, so it's never announced. Crash recovery: a fresh ledger re-announces all current trigger values, same as the comment monitor.

- **D4 — `update_frontmatter` is field-addressed patch, not string-addressed.** A new plugin-server tool. *Non-clobbering* is the property that matters: it touches only the fields you name and leaves every other field and the entire body byte-identical — the frontmatter analog of `patch_note`. To keep tool-call count down, **one call sets/clears multiple fields**: `update_frontmatter(path, set?: {field: value, …}, unset?: [field, …])`. So writing a receipt (and, say, a `reviewed_at`) on one note is a single call, not several. Reuses the same single-CommentStore / vault-adapter path as the other note tools (single writer, cache-coherent). Must round-trip unknown fields (the round-trip-preservation contract from comments-core, applied to YAML). Open sub-question: parse/serialize via Obsidian's `fileManager.processFrontMatter` (canonical, handles edge cases) vs. a hand-rolled YAML-block splice (no dependency on the editor being open) — settle in step 1.

  - **No separate read in the loop, no `get_frontmatter` needed.** The actionable event already carries `{note_path, field, value}`, so the agent knows the current value when it wakes; `read_note` already returns the full YAML block for the rare case it needs more. The normal cycle is **event → do work → one write** — one call per note per request. Cross-note batches (review 14 notes → 14 receipts) are inherently one write each; a bulk endpoint is deferred until call volume demonstrably hurts, not built speculatively.

- **D5 — Two watch surfaces, one model, or one unified surface?** Comments and frontmatter are both "actionable-by-construction, scoped, stateless" queries. Option (a): a second endpoint `GET /frontmatter/actionable?scope=&triggers=` + a `check_frontmatter` tool, monitor runs two polls. Option (b): one unified `GET /actionable` that returns both comment events and frontmatter events as a tagged union, one poll. **Leaning (a)** for step-boundary cleanliness and because the trigger-allowlist param is frontmatter-only; (b) is a possible later consolidation once both are proven. Recorded so it isn't re-litigated mid-build.

- **D6 — Scope of the "active" mode is bounded.** `active` (keep-in-context) is the one value with an open-ended cost: a watcher honoring `active` on twenty large notes blows the context budget. Mitigation deferred to implementation: a per-scope cap on how many `active` notes are honored, and/or a size budget, with the overflow announced (never silently dropped — the "no silent caps" rule). Not a blocker for requests/receipts, which are bounded by construction.

## Plan

> One commit per step in `obsidian-Annotated`. Container deploy rides livesync MAIN sync. This PLN is **blocked on deploy** of the note-write tools already built (v0.1.5: `create_note`, `append_note`, `patch_note` punctuation-folding) — those land first, then this builds on them.

0. **Ratify the vocabulary (this doc → accepted).** Review the D2 value table; confirm the request/receipt/mode/failure grammar and the starter set (`review/reviewed`, `summarize/summarized`, `active`, `blocked`). Lock before building so the skill table and the tool contract agree.

1. **`update_frontmatter` tool (plugin server).** Field-addressed set/clear per D4; round-trips unknown fields and body; zod-validated like the other tools; fence-checked. Decide `processFrontMatter` vs. YAML splice here. *Accept: unit tests — set a new field, change an existing one, clear one, all with unknown sibling fields + body preserved byte-for-byte; fence rejection; covered over HTTP.*

2. **Frontmatter actionable query (comments-core + endpoint + tool).** `queryActionableFrontmatter(notes, {scope, field, triggers})` returning `{ note_path, field, value, ... }`, oldest-first, fence-clamped, value-agnostic. Wire `GET /frontmatter/actionable` + `check_frontmatter` MCP tool (D5 option a). Source frontmatter from `metadataCache` on the plugin host; from file parse on the stdio host. *Accept: query unit tests (trigger filter, scope clamp, fence refusal); HTTP auth matrix reuses the comment-watch tests' shape.*

3. **Monitor: frontmatter channel.** Extend `watch-comments.sh` (or a sibling `watch-frontmatter.sh`) to poll the new surface with `triggers=`, ledger key `path + hash(value)`, one debounced line per note: `frontmatter <field>=<value> on <note_path>`. Echo-guard per D3 verified by test (agent's receipt write produces no event). *Accept: fixture-harness checks mirroring the comment monitor's 6-check suite; shellcheck-clean.*

4. **Skill: externalized vocabulary + handling rules (D1a).** Extend `watch-vault-comments` (or a paired skill): `SKILL.md` carries the stable rules (request→work→receipt loop, `blocked`+comment on unknown, echo-guard, `active`-mode injection with its D6 cap); a bundled `vocabulary.md` carries the user-editable value table. Settle the trigger-list fork (sibling `triggers.txt`/env vs. machine-parseable vocabulary). The agent derives receipts mechanically (past tense) and refuses to guess unknown values. *Accept: editing `vocabulary.md` alone adds a working workflow with no `SKILL.md` change; skill documents each value's clearing semantics; dry-run against a seeded note set.*

5. **Live verification + docs.** Seed a note with `annotated: review` on the container, confirm the monitor announces it, agent reviews + writes `reviewed`, no echo. Then `summarize` end-to-end (decide where the summary lands — see open question). Update README / the parent LOG. *Accept: DoD items demonstrated live; one full request→receipt cycle per starter verb.*

## Open questions (for ratification / surfacing during build)

- **Where does a `summarize` receipt's summary land?** Sibling note (`<name> (summary).md` via `create_note` — now possible), a `## Summary` section appended to the note (`append_note`), or a comment. Likely per-value config in the skill, not a global rule.
- **Param-carrying requests** (`summarize: 200w`, `translate: fr`)? Deferred — keep values enum-simple for v1; the grammar can grow to `verb: arg` later without breaking the convention.
- **`active` consumption cost** — the D6 cap's exact shape (count vs. token budget) waits for a real context-pressure observation.
- **Unify the two actionable surfaces (D5b)?** Revisit after both channels are proven.

## Risks / notes

- **Frontmatter churn vs. livesync**: every receipt write is a frontmatter edit → a synced revision. Bounded (one write per request fulfilled), unlike the rejected "record edit line-numbers" idea whose churn was per-keystroke (LOG 2026-06-12, REJECTED). Acceptable, but worth watching that high-volume `review` batches don't spam sync.
- **YAML is not Markdown**: `update_frontmatter` touches a structured region; a naive string splice can corrupt the block (quoting, multiline values, list values). This is why D4 leans toward `processFrontMatter`. The "undefined-written" bug class (LOG 2026-06-11) is the cautionary tale for under-validated writes.
- **Two-writer reality**: a human editing frontmatter in the Obsidian UI while the agent writes a receipt is last-write-wins, same as comments. The single-CommentStore path mitigates within one instance; cross-instance is sync-mediated, latency inherent.
- **`metadataCache` is plugin-host-only**: the stdio thin host (parent PLN step 8, still deferred on the comments-core publish decision) must parse frontmatter from disk instead. Keep the query's frontmatter source injected, like `NoteAccess`, so both hosts satisfy it.
- **Stale-anchor events** (the other deferred idea — "the text under a comment changed") are *not* in this PLN. They're a comment-channel extension, not frontmatter; kept separate so this plan stays one coherent channel. Logged in [[LOG - Event-Driven Comment Watch]] for whenever they get their own plan.
