import { describe, it, expect } from "vitest";
import { pathInScope, queryActionable, toActionableRef } from "../src/actionableQuery";
import { Comment, CommentFile, CommentReply } from "../src/types";

function makeComment(overrides: Partial<Comment> = {}): Comment {
	const now = "2024-01-01T00:00:00Z";
	return {
		id: "c_root",
		author: "human",
		created_at: now,
		updated_at: now,
		location: { type: "range", start_line: 1, start_char: 0, end_line: 1, end_char: 0 },
		content: "root content",
		status: "open",
		replies: [],
		last_activity_at: now,
		...overrides,
	};
}

function makeReply(id: string, author: string, content = "reply content"): CommentReply {
	const now = "2024-01-02T00:00:00Z";
	return { id, author, created_at: now, updated_at: now, content, status: "open" };
}

function makeFile(notePath: string, comments: Comment[]): { notePath: string; file: CommentFile } {
	return {
		notePath,
		file: {
			version: 1,
			createdBy: "test",
			note_path: notePath,
			created_at: "2024-01-01T00:00:00Z",
			updated_at: "2024-01-01T00:00:00Z",
			comments,
			metadata: { total_comments: comments.length, open_count: 0, resolved_count: 0, authors: [] },
		},
	};
}

describe("pathInScope", () => {
	it("empty/undefined/root scope matches everything", () => {
		expect(pathInScope("a/b.md", undefined)).toBe(true);
		expect(pathInScope("a/b.md", "")).toBe(true);
		expect(pathInScope("a/b.md", "/")).toBe(true);
	});

	it("folder scope matches contents, not name-prefix siblings", () => {
		expect(pathInScope("Projects/note.md", "Projects")).toBe(true);
		expect(pathInScope("Projects/sub/note.md", "Projects")).toBe(true);
		expect(pathInScope("ProjectsArchive/note.md", "Projects")).toBe(false);
	});

	it("exact note path matches itself only", () => {
		expect(pathInScope("a/b.md", "a/b.md")).toBe(true);
		expect(pathInScope("a/b2.md", "a/b.md")).toBe(false);
	});

	it("leading/trailing slashes in scope are tolerated", () => {
		expect(pathInScope("Projects/note.md", "/Projects/")).toBe(true);
	});
});

describe("toActionableRef — id is the LATEST message id", () => {
	it("uses the root comment id when there are no replies", () => {
		const ref = toActionableRef(makeComment(), "note.md");
		expect(ref.id).toBe("c_root");
		expect(ref.thread_id).toBe("c_root");
	});

	it("uses the newest reply id when replies exist (re-announce semantics)", () => {
		const comment = makeComment({
			replies: [makeReply("c_r1", "Claude"), makeReply("c_r2", "human")],
		});
		const ref = toActionableRef(comment, "note.md");
		expect(ref.id).toBe("c_r2");
		expect(ref.thread_id).toBe("c_root");
	});

	it("snippet is the latest message content, trimmed, max 50 chars", () => {
		const long = "  " + "x".repeat(80);
		const ref = toActionableRef(makeComment({ content: long }), "note.md");
		expect(ref.snippet).toBe("x".repeat(50));
	});
});

describe("queryActionable", () => {
	const files = [
		makeFile("inbox/a.md", [
			makeComment({ id: "c_a1", author: "human", last_activity_at: "2024-02-02T00:00:00Z" }),
			makeComment({ id: "c_a2", author: "Claude" }), // agent had the last word
			makeComment({ id: "c_a3", author: "human", status: "resolved" }),
		]),
		makeFile("other/b.md", [
			makeComment({ id: "c_b1", author: "human", last_activity_at: "2024-02-01T00:00:00Z" }),
		]),
	];

	it("returns actionable refs across files, oldest activity first", () => {
		const refs = queryActionable(files, { excludeAuthors: ["Claude"] });
		expect(refs.map((r) => r.thread_id)).toEqual(["c_b1", "c_a1"]);
	});

	it("scope narrows the result", () => {
		const refs = queryActionable(files, { scope: "inbox", excludeAuthors: ["Claude"] });
		expect(refs.map((r) => r.thread_id)).toEqual(["c_a1"]);
	});

	it("status: 'resolved' returns resolved threads instead (inspection mode)", () => {
		const refs = queryActionable(files, { excludeAuthors: ["Claude"], status: "resolved" });
		expect(refs.map((r) => r.thread_id)).toEqual(["c_a3"]);
	});

	it("status: 'open' behaves like the default actionable semantics", () => {
		const defaults = queryActionable(files, { excludeAuthors: ["Claude"] });
		const open = queryActionable(files, { excludeAuthors: ["Claude"], status: "open" });
		expect(open).toEqual(defaults);
	});
});
