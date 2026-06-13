# Example action files

Reference set for the frontmatter-watch vocabulary (see
[`../../PLN - Frontmatter & File Watch.md`](../../PLN%20-%20Frontmatter%20%26%20File%20Watch.md), D1a). At
build time these live at `skill/watch-vault-comments/actions/`; the skill reads
the folder, derives the trigger list (the filenames) and the receipt
exclude-set (the `completedTag` values), and arms the monitor — the bash script
never parses YAML.

## The convention in one screen

- **The filename is the trigger root.** `translate.yml` matches `annotated: translate`
  and `annotated: translate/spanish` (root = the part before `/`).
- **`do:`** — instructions for the agent when a note carries this action. `{arg}`
  interpolates the part after `/`; it may be a comma list (`spanish,french`).
- **`completedTag`** — the receipt the agent writes when done. Omit it to default
  to the filename's past tense (`review` → `reviewed`); declare it for irregular
  verbs (`proofread` → `proofread`) or to template the arg (`translated/{arg}`).
  Every `completedTag` is excluded from the trigger set, so the agent's own
  receipt writes never echo back as new events.
- **`clearedBy`** — `agent` (a request: the agent writes the receipt) or `human`
  (a mode: the human removes the field). Having a `completedTag` already implies
  `agent`; modes have none.
- **`output`** — where a result lands: `sibling` (managed companion note),
  `section` (managed heading block in the note), `comment` (a thread), or `none`
  (default — the work is its own side effect). Managed targets are replaced on
  re-run, not duplicated.

`blocked` is reserved/built-in — the universal failure receipt the agent writes
(with an explaining comment) when it can't fulfill a request or meets an unknown
value. It is not a user file.

## This set

| file | kind | shows |
|------|------|-------|
| `review.yml` | request | the minimum — derived receipt, `output: none` |
| `summarize.yml` | request | `output: sibling`, a managed artifact note |
| `translate.yml` | request | `{arg}` params, comma-list fan-out, templated receipt |
| `active.yml` | mode | human-cleared, no `completedTag` |
| `proofread.yml` | request | explicit irregular past tense, `output: section` |

Add a workflow by dropping in one more `<name>.yml`. Remove one by deleting its
file. Neither touches `SKILL.md`.
