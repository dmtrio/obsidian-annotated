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

import type { Identity } from "@annotated/comments-core";

export interface PluginSettings {
	// Display
	showGutterIndicators: boolean;

	// Author
	defaultAuthor: string;

	// Identity registry (PLN Decision 4b): lives in data.json so it SYNCS
	// between instances. Keys/bind-config are device-local — never here.
	identities: Identity[];

	// Reserved namespace for agent-written tags (synced). The agent only adds/removes tags under this prefix, never the user's flat tags.
	tagPrefix: string;

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
	identities: [],
	tagPrefix: "bot/",
	hideResolvedByDefault: true,
	commentIndicatorStyle: "icon",
	customGutterEmoji: "\u{1F4AC}",
	maxCommentsInPopup: 3,
	defaultSortMode: "line",
};
