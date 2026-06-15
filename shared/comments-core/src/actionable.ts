import { Comment, CommentFile } from "./types";

/**
 * Actionable-by-construction (PLN Decision 3): a comment thread needs
 * attention iff it is open AND the last message in the thread is not from an
 * excluded author. Replying or resolving is what clears it — there is no
 * cursor and no read-tracking. Author matching is case-insensitive.
 */
export function needsAttention(comment: Comment, excludeAuthors: string[]): boolean {
	if (comment.status === "resolved") return false;

	const lastMessage =
		comment.replies.length > 0
			? comment.replies[comment.replies.length - 1]
			: comment;

	const authorLower = lastMessage.author.toLowerCase();
	return !excludeAuthors.some((a) => a.toLowerCase() === authorLower);
}

/** All comments in one sidecar file that currently need attention. */
export function getActionableComments(
	commentFile: CommentFile,
	excludeAuthors: string[],
): Comment[] {
	return commentFile.comments.filter((c) => needsAttention(c, excludeAuthors));
}
