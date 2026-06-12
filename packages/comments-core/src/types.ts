// Canonical comment model for the .comments.json sidecar format
// (schema: ../schemas/comments.schema.json). The plugin's richer model is the
// contract — resolved_by / resolved_at / is_stale / updated_at are first-class.

// ── Location Types ──────────────────────────────────────────────

export interface RangeLocation {
	type: "range";
	start_line: number;  // 1-indexed
	start_char: number;  // 0-indexed offset in line
	end_line: number;    // 1-indexed
	end_char: number;    // 0-indexed offset in line
}

export type Location = RangeLocation;

// ── Comment Status ─────────────────────────────────────────────

export type CommentStatus = "open" | "resolved";

// ── Comments ───────────────────────────────────────────────────

export interface CommentReply {
	id: string;
	author: string;
	author_id?: string;  // identity id when written by a key-authenticated writer (PLN Decision 4)
	created_at: string;  // ISO 8601
	updated_at: string;  // ISO 8601
	content: string;
	status: CommentStatus;
}

export interface Comment {
	id: string;
	author: string;
	author_id?: string;   // identity id when written by a key-authenticated writer (PLN Decision 4)
	created_at: string;   // ISO 8601
	updated_at: string;   // ISO 8601
	location: Location;
	content: string;
	status: CommentStatus;
	resolved_at?: string;  // ISO 8601
	resolved_by?: string;
	resolved_by_id?: string;  // identity id when resolved by a key-authenticated writer
	replies: CommentReply[];
	last_activity_at: string;  // ISO 8601 — created_at or latest reply's created_at
	content_snippet?: string;  // first 50 chars of the annotated line
	is_stale?: boolean;        // true if snippet couldn't be matched on open
}

// ── Comment File ───────────────────────────────────────────────

export interface CommentFileMetadata {
	total_comments: number;
	open_count: number;
	resolved_count: number;
	authors: string[];
}

export const SCHEMA_VERSION = 1;

export interface CommentFile {
	version: number;
	createdBy: string;
	note_path: string;
	created_at: string;   // ISO 8601
	updated_at: string;   // ISO 8601
	comments: Comment[];
	metadata: CommentFileMetadata;
}
