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

export type CommentStatus = "open" | "resolved" | "archived";

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
}

// ── Comment File ───────────────────────────────────────────────

export interface CommentFileMetadata {
	total_comments: number;
	open_count: number;
	resolved_count: number;
	archived_count: number;
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
	showSidebar: boolean;
	defaultCommentStatus: "open" | "resolved";

	// Author
	defaultAuthor: string;

	// File handling
	autoCreateCommentFile: boolean;
	commentFileLocation: "adjacent" | "folder";

	// Filtering
	hideResolvedByDefault: boolean;
	hideArchivedByDefault: boolean;

	// UI
	commentIndicatorStyle: "icon" | "badge" | "highlight";
	maxCommentsInPopup: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	showGutterIndicators: true,
	showSidebar: true,
	defaultCommentStatus: "open",
	defaultAuthor: "claude",
	autoCreateCommentFile: true,
	commentFileLocation: "adjacent",
	hideResolvedByDefault: true,
	hideArchivedByDefault: true,
	commentIndicatorStyle: "icon",
	maxCommentsInPopup: 3,
};
