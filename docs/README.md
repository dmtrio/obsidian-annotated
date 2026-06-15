# Design docs

These are **design records** (PLNs — "plans"): the *why* behind major features — decisions, trade-offs, and alternatives considered. They are historical, written as-of their dates.

**For how the plugin works today, see the [root README](../README.md)** and the [comment-format spec](../shared/comments-core/schemas/COMMENTS-FORMAT.md). Where a PLN and the README disagree, the README wins.

| PLN | designs | shipped |
|-----|---------|---------|
| [Frontmatter & File Watch](<PLN - Frontmatter & File Watch.md>) | note-level `annotated:` actions + the actionable watch surface | v0.1.6–0.1.7 |
| [Note Provenance & Tags](<PLN - Note Provenance & Tags.md>) | provenance stamping + server-enforced `tag_note` | v0.1.6–0.1.7 |
| [Vault Tools & Key Capability Tiers](<PLN - Vault Tools & Key Capability Tiers.md>) | the poll/additive/destructive tier ladder + navigation & destructive tools | branch `feat/vault-tools-key-tiers` |

`examples/actions/` holds reference action files for the frontmatter-watch vocabulary (the `annotated: review` / `summarize` / `translate` set).

Two earlier PLNs — *Event-Driven Comment Watch* and *MCP OAuth Shim* — live in the design vault rather than this repo; the three above build on them.
