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
	created_at: string;  // ISO 8601
	updated_at: string;  // ISO 8601
	content: string;
	status: CommentStatus;
}

export interface Comment {
	id: string;
	author: string;
	created_at: string;   // ISO 8601
	updated_at: string;   // ISO 8601
	location: Location;
	content: string;
	status: CommentStatus;
	resolved_at?: string;  // ISO 8601
	resolved_by?: string;
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

export interface CommentFile {
	version: string;
	note_path: string;
	created_at: string;   // ISO 8601
	updated_at: string;   // ISO 8601
	comments: Comment[];
	metadata: CommentFileMetadata;
}

// ── Plugin Settings ────────────────────────────────────────────

export interface PluginSettings {
	// Display
	showGutterIndicators: boolean;

	// Author
	defaultAuthor: string;

	// Filtering
	hideResolvedByDefault: boolean;

	// UI
	commentIndicatorStyle: "icon" | "badge" | "highlight";
	customGutterEmoji: string;
	maxCommentsInPopup: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	showGutterIndicators: true,
	defaultAuthor: "claude",
	hideResolvedByDefault: true,
	commentIndicatorStyle: "icon",
	customGutterEmoji: "\u{1F4AC}",
	maxCommentsInPopup: 3,
};
