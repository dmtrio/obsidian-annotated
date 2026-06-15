/**
 * Pure utility functions for formatting display text.
 * No dependencies on Obsidian or CodeMirror.
 */

import { Comment } from "../types";

declare const moment: typeof import("moment");

export function formatTimestamp(iso: string): string {
	const m = moment(iso);
	if (m.isSame(moment(), "day")) {
		return m.format("h:mm A");
	}
	return m.format("MMM D, h:mm A");
}

export function formatLocationText(location: { start_line: number; end_line: number }): string {
	if (location.start_line === location.end_line) {
		return `Line ${location.start_line}`;
	}
	return `Lines ${location.start_line}\u2013${location.end_line}`;
}

export function getCommentActivityTime(comment: Comment): number {
	if (comment.last_activity_at) {
		return new Date(comment.last_activity_at).getTime();
	}
	if (comment.replies.length > 0) {
		const lastReply = comment.replies[comment.replies.length - 1];
		return new Date(lastReply.created_at).getTime();
	}
	return new Date(comment.created_at).getTime();
}

export function truncateContent(text: string, max = 120): string {
	if (text.length > max) {
		return text.slice(0, max) + "\u2026";
	}
	return text;
}
