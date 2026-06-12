# Comment File Format (`*.comments.json`)

Every Markdown note can have a sibling comment file. For `notes/todo.md`, the comment file is `notes/todo.md.comments.json`.

Validated by [`comments.schema.json`](./comments.schema.json).

---

## File Structure

```
{
  "version":    1,                             ── schema version (integer)
  "createdBy":  "obsidian-annotated@0.1.0",    ── plugin version that created this file
  "note_path":  "notes/todo.md",               ── vault-relative path of the annotated note
  "created_at": "2025-01-15T10:00:00.000Z",    ── when this file was first created
  "updated_at": "2025-01-15T12:30:00.000Z",    ── last write timestamp (auto-updated)
  "comments":   [ ... ],                       ── array of top-level comments
  "metadata":   { ... }                        ── aggregate stats (auto-calculated)
}
```

### Sections

| Section      | Purpose |
|-------------|---------|
| **Header**   | `version`, `createdBy`, `note_path`, timestamps — identifies the file and its format |
| **Comments** | Array of top-level `Comment` objects, each anchored to a line range |
| **Metadata** | `total_comments`, `open_count`, `resolved_count`, `authors` — recalculated on every save |

---

## How a Comment is Added

When a user selects text on line 5 of `todo.md` and submits "This needs a test":

```json
{
  "version": 1,
  "createdBy": "obsidian-annotated@0.1.0",
  "note_path": "notes/todo.md",
  "created_at": "2025-01-15T10:00:00.000Z",
  "updated_at": "2025-01-15T10:00:00.000Z",
  "comments": [
    {
      "id": "c_m1abc2def3",
      "author": "alice",
      "created_at": "2025-01-15T10:00:00.000Z",
      "updated_at": "2025-01-15T10:00:00.000Z",
      "location": {
        "type": "range",
        "start_line": 5,
        "start_char": 0,
        "end_line": 5,
        "end_char": 0
      },
      "content": "This needs a test",
      "status": "open",
      "replies": [],
      "last_activity_at": "2025-01-15T10:00:00.000Z",
      "content_snippet": "- [ ] implement auth middleware"
    }
  ],
  "metadata": {
    "total_comments": 1,
    "open_count": 1,
    "resolved_count": 0,
    "authors": ["alice"]
  }
}
```

Key behaviors:
- `content_snippet` captures the first 50 chars of line 5. On next open, the plugin uses this to relocate the comment if lines shifted.
- `last_activity_at` equals `created_at` since there are no replies yet.
- `metadata` is recalculated on every save — never edit it by hand.

---

## How Threading Works

Replies are nested inside the parent comment's `replies` array. There is no separate replies collection — each comment **is** its own thread.

When Bob replies "I'll add one":

```json
{
  "id": "c_m1abc2def3",
  "author": "alice",
  "created_at": "2025-01-15T10:00:00.000Z",
  "updated_at": "2025-01-15T10:05:00.000Z",
  "location": { "type": "range", "start_line": 5, "start_char": 0, "end_line": 5, "end_char": 0 },
  "content": "This needs a test",
  "status": "open",
  "replies": [
    {
      "id": "c_m1xyz9abc1",
      "author": "bob",
      "created_at": "2025-01-15T10:05:00.000Z",
      "updated_at": "2025-01-15T10:05:00.000Z",
      "content": "I'll add one",
      "status": "open"
    }
  ],
  "last_activity_at": "2025-01-15T10:05:00.000Z",
  "content_snippet": "- [ ] implement auth middleware"
}
```

What changed:
- A `Reply` was appended to `replies[]`. Replies are ordered chronologically (newest last).
- `last_activity_at` was updated to the reply's `created_at`. This drives "newest first" sorting.
- `updated_at` on the parent comment was updated.
- `metadata.authors` now includes `["alice", "bob"]`.

### Resolving

When Alice resolves the thread:

```json
{
  "status": "resolved",
  "resolved_at": "2025-01-15T11:00:00.000Z",
  "resolved_by": "alice"
}
```

If someone adds a new reply to a resolved comment, it automatically reopens: `status` reverts to `"open"` and `resolved_at`/`resolved_by` are cleared.

---

## Comment Relocation

When the note is edited and lines shift, the plugin uses `content_snippet` to find where the comment moved:

1. **Exact match** — if the stored line still starts with the snippet, nothing changes.
2. **Nearby search** — scan within 50 lines of the original position for an exact `startsWith` match.
3. **Fuzzy match** — if no exact match, use bigram similarity (threshold >= 0.7) to find the best candidate.
4. **Stale** — if all three fail, `is_stale` is set to `true` and a warning badge appears in the UI.

---

## Location Model

```
"location": {
  "type":       "range",   ── discriminator (only "range" currently)
  "start_line": 5,         ── first line, 1-indexed
  "start_char": 0,         ── char offset in start line, 0-indexed
  "end_line":   7,         ── last line, 1-indexed
  "end_char":   42         ── char offset in end line, 0-indexed
}
```

- Single-line comment: `start_line === end_line`
- Full-line annotation (no sub-selection): `start_char` and `end_char` are both `0`
- The `type` field exists to allow future location types (e.g., block references) without breaking the schema.
