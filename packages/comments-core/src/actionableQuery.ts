// The one query, two faces (PLN step 3): the `check_comments` MCP tool and
// `GET /comments/actionable` both reduce to this module. Results are id-level
// and token-lean; full bodies come from read_comments afterwards.

import { Comment, CommentFile, CommentStatus } from "./types";
import { needsAttention } from "./actionable";

export interface ActionableRef {
	/**
	 * Id of the LATEST message in the thread (the root comment if no replies,
	 * else the newest reply). This is what monitors ledger for dedupe: a new
	 * human reply gives the thread a new id, so it re-announces; the thread
	 * root alone would announce once and go silent forever.
	 */
	id: string;
	note_path: string;
	/** Root comment id — what reply_to_comment / resolve_comment address. */
	thread_id: string;
	last_activity_at: string;
	/** Latest message content, trimmed, max 50 chars (endpoint exposure stays low). */
	snippet: string;
}

export interface ActionableQueryParams {
	/** Folder or exact note path, vault-relative. Empty/undefined = whole vault. */
	scope?: string;
	/** Authors whose last-word threads are NOT actionable (see effectiveExcludeAuthors). */
	excludeAuthors: string[];
	/**
	 * Default (or "open"): actionable semantics — open threads needing attention.
	 * "resolved": resolved threads in scope (inspection; no attention semantics).
	 */
	status?: CommentStatus;
}

const SNIPPET_MAX = 50;

export function pathInScope(notePath: string, scope: string | undefined): boolean {
	const normalized = (scope ?? "").replace(/^\/+|\/+$/g, "");
	if (normalized === "") return true;
	return notePath === normalized || notePath.startsWith(normalized + "/");
}

export function toActionableRef(comment: Comment, notePath: string): ActionableRef {
	const lastMessage =
		comment.replies.length > 0 ? comment.replies[comment.replies.length - 1] : comment;
	return {
		id: lastMessage.id,
		note_path: notePath,
		thread_id: comment.id,
		last_activity_at: comment.last_activity_at,
		snippet: lastMessage.content.trim().slice(0, SNIPPET_MAX),
	};
}

/**
 * Run the query over already-loaded sidecar files (scanning the vault/fs for
 * sidecars is the host's job). Results are oldest-activity-first, so a monitor
 * announces in conversation order.
 */
export function queryActionable(
	files: Iterable<{ notePath: string; file: CommentFile }>,
	params: ActionableQueryParams,
): ActionableRef[] {
	const refs: ActionableRef[] = [];

	for (const { notePath, file } of files) {
		if (!pathInScope(notePath, params.scope)) continue;

		for (const comment of file.comments) {
			const include =
				params.status === "resolved"
					? comment.status === "resolved"
					: needsAttention(comment, params.excludeAuthors);
			if (include) {
				refs.push(toActionableRef(comment, notePath));
			}
		}
	}

	refs.sort(
		(a, b) =>
			a.last_activity_at.localeCompare(b.last_activity_at) ||
			a.note_path.localeCompare(b.note_path),
	);
	return refs;
}
