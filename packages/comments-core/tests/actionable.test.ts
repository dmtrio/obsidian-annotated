import { describe, it, expect } from "vitest";
import { needsAttention, getActionableComments } from "../src/actionable";
import { Comment, CommentFile, CommentReply } from "../src/types";

function makeComment(overrides: Partial<Comment> = {}): Comment {
	const now = "2024-01-01T00:00:00Z";
	return {
		id: "c_1",
		author: "human",
		created_at: now,
		updated_at: now,
		location: { type: "range", start_line: 1, start_char: 0, end_line: 1, end_char: 0 },
		content: "hello",
		status: "open",
		replies: [],
		last_activity_at: now,
		...overrides,
	};
}

function makeReply(author: string, overrides: Partial<CommentReply> = {}): CommentReply {
	const now = "2024-01-02T00:00:00Z";
	return { id: "r_1", author, created_at: now, updated_at: now, content: "re", status: "open", ...overrides };
}

describe("needsAttention", () => {
	it("resolved comments never need attention", () => {
		expect(needsAttention(makeComment({ status: "resolved" }), [])).toBe(false);
	});

	it("open comment with no replies: actionable unless the author is excluded", () => {
		expect(needsAttention(makeComment({ author: "human" }), ["Claude"])).toBe(true);
		expect(needsAttention(makeComment({ author: "Claude" }), ["Claude"])).toBe(false);
	});

	it("the LAST message decides, not the thread starter", () => {
		// Agent replied last → handled, not actionable
		expect(
			needsAttention(makeComment({ author: "human", replies: [makeReply("Claude")] }), ["Claude"]),
		).toBe(false);
		// Human replied after the agent → actionable again
		expect(
			needsAttention(
				makeComment({ author: "human", replies: [makeReply("Claude"), makeReply("human", { id: "r_2" })] }),
				["Claude"],
			),
		).toBe(true);
	});

	it("author exclusion is case-insensitive", () => {
		expect(needsAttention(makeComment({ author: "claude" }), ["Claude"])).toBe(false);
		expect(needsAttention(makeComment({ author: "CLAUDE" }), ["claude"])).toBe(false);
	});

	it("no exclusions means every open thread is actionable", () => {
		expect(needsAttention(makeComment({ author: "anyone" }), [])).toBe(true);
	});
});

describe("getActionableComments", () => {
	it("filters a file down to actionable threads only", () => {
		const file: CommentFile = {
			version: 1,
			createdBy: "test",
			note_path: "note.md",
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-01-01T00:00:00Z",
			comments: [
				makeComment({ id: "c_open_human", author: "human" }),
				makeComment({ id: "c_resolved", author: "human", status: "resolved" }),
				makeComment({ id: "c_agent_last", author: "human", replies: [makeReply("Claude")] }),
				makeComment({ id: "c_agent_started", author: "Claude" }),
			],
			metadata: { total_comments: 4, open_count: 3, resolved_count: 1, authors: ["human", "Claude"] },
		};

		const actionable = getActionableComments(file, ["Claude"]);
		expect(actionable.map((c) => c.id)).toEqual(["c_open_human"]);
	});
});
