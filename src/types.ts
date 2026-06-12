// ── Comment Model ───────────────────────────────────────────────
// Canonical home is @annotated/comments-core (types + schema + CRUD);
// re-exported here so existing "../types" imports keep working.

export {
	SCHEMA_VERSION,
	type Comment,
	type CommentFile,
	type CommentFileMetadata,
	type CommentReply,
	type CommentStatus,
	type Location,
	type RangeLocation,
} from "@annotated/comments-core";

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

	// Sorting
	defaultSortMode: "line" | "oldest" | "newest";
}

export const DEFAULT_SETTINGS: PluginSettings = {
	showGutterIndicators: true,
	defaultAuthor: "claude",
	hideResolvedByDefault: true,
	commentIndicatorStyle: "icon",
	customGutterEmoji: "\u{1F4AC}",
	maxCommentsInPopup: 3,
	defaultSortMode: "line",
};
