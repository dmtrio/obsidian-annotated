import { describe, it, expect, beforeEach } from "vitest";
import { CommentStore } from "../src/CommentStore";
import { InMemoryStorageAdapter } from "../src/storage";
import { Comment, CommentFile, CommentReply } from "../src/types";

function makeComment(overrides: Partial<Comment> = {}): Comment {
	const now = new Date().toISOString();
	return {
		id: "c_test1",
		author: "alice",
		created_at: now,
		updated_at: now,
		location: { type: "range", start_line: 1, start_char: 0, end_line: 1, end_char: 0 },
		content: "test comment",
		status: "open",
		replies: [],
		last_activity_at: now,
		...overrides,
	};
}

function makeReply(overrides: Partial<CommentReply> = {}): CommentReply {
	const now = new Date().toISOString();
	return {
		id: "r_test1",
		author: "bob",
		created_at: now,
		updated_at: now,
		content: "a reply",
		status: "open",
		...overrides,
	};
}

describe("CommentStore", () => {
	let storage: InMemoryStorageAdapter;
	let store: CommentStore;

	beforeEach(() => {
		storage = new InMemoryStorageAdapter();
		store = new CommentStore(storage, { createdBy: "obsidian-annotated@0.0.0-test" });
	});

	describe("round-trip preservation (no field loss through mutating ops)", () => {
		/**
		 * Seed a sidecar that a *richer future version* might have written:
		 * unknown fields at file, comment, and reply level. Every mutating
		 * operation must preserve them — this is the contract that lets the
		 * plugin's model evolve ahead of other consumers.
		 */
		const seedWithUnknownFields = async () => {
			const file = {
				version: 1,
				createdBy: "obsidian-annotated@9.9.9",
				note_path: "note.md",
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				x_file_extension: { future: true },
				comments: [
					{
						...makeComment({ id: "c_existing", author: "alice" }),
						x_comment_extension: "keep me",
						replies: [
							{ ...makeReply({ id: "r_existing", author: "bob" }), x_reply_extension: 42 },
						],
					},
				],
				metadata: { total_comments: 1, open_count: 1, resolved_count: 0, authors: ["alice", "bob"] },
			};
			await storage.write("note.md.comments.json", JSON.stringify(file, null, 2));
		};

		const readBack = async (): Promise<any> =>
			JSON.parse(await storage.read("note.md.comments.json"));

		it("addComment preserves unknown fields at every level", async () => {
			await seedWithUnknownFields();
			await store.addComment("note.md", makeComment({ id: "c_new" }));

			const file = await readBack();
			expect(file.x_file_extension).toEqual({ future: true });
			expect(file.comments[0].x_comment_extension).toBe("keep me");
			expect(file.comments[0].replies[0].x_reply_extension).toBe(42);
			expect(file.comments).toHaveLength(2);
		});

		it("addReply preserves unknown fields at every level", async () => {
			await seedWithUnknownFields();
			await store.addReply("note.md", "c_existing", makeReply({ id: "r_new" }));

			const file = await readBack();
			expect(file.x_file_extension).toEqual({ future: true });
			expect(file.comments[0].x_comment_extension).toBe("keep me");
			expect(file.comments[0].replies[0].x_reply_extension).toBe(42);
			expect(file.comments[0].replies).toHaveLength(2);
		});

		it("resolveComment preserves unknown fields at every level", async () => {
			await seedWithUnknownFields();
			await store.resolveComment("note.md", "c_existing", "alice");

			const file = await readBack();
			expect(file.x_file_extension).toEqual({ future: true });
			expect(file.comments[0].x_comment_extension).toBe("keep me");
			expect(file.comments[0].replies[0].x_reply_extension).toBe(42);
			expect(file.comments[0].status).toBe("resolved");
			expect(file.comments[0].resolved_by).toBe("alice");
		});

		it("preserves createdBy from the original writer", async () => {
			await seedWithUnknownFields();
			await store.addComment("note.md", makeComment({ id: "c_new" }));
			const file = await readBack();
			expect(file.createdBy).toBe("obsidian-annotated@9.9.9");
		});
	});

	describe("audit fields", () => {
		it("resolveComment writes resolved_by and resolved_at", async () => {
			await store.addComment("note.md", makeComment({ id: "c_1" }));
			await store.resolveComment("note.md", "c_1", "Claude");

			const file = JSON.parse(await storage.read("note.md.comments.json")) as CommentFile;
			expect(file.comments[0].status).toBe("resolved");
			expect(file.comments[0].resolved_by).toBe("Claude");
			expect(file.comments[0].resolved_at).toBeDefined();
		});

		it("addReply to a resolved comment reopens it and clears audit fields", async () => {
			await store.addComment(
				"note.md",
				makeComment({ id: "c_1", status: "resolved", resolved_at: "2024-03-01T00:00:00Z", resolved_by: "alice" }),
			);
			await store.addReply("note.md", "c_1", makeReply({ created_at: "2024-06-01T00:00:00Z" }));

			const file = JSON.parse(await storage.read("note.md.comments.json")) as CommentFile;
			expect(file.comments[0].status).toBe("open");
			expect(file.comments[0].resolved_at).toBeUndefined();
			expect(file.comments[0].resolved_by).toBeUndefined();
			expect(file.comments[0].last_activity_at).toBe("2024-06-01T00:00:00Z");
		});
	});

	describe("error handling", () => {
		it("returns null and reports via onError on corrupt JSON", async () => {
			const errors: string[] = [];
			store = new CommentStore(storage, {
				createdBy: "test",
				onError: (msg) => errors.push(msg),
			});
			await storage.write("note.md.comments.json", "{not json");

			const result = await store.getComments("note.md");
			expect(result).toBeNull();
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("note.md.comments.json");
		});
	});
});
