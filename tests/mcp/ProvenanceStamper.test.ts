/**
 * Tests for ProvenanceStamper: loop guard, idempotency, no-op conditions.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ProvenanceStamper } from "../../src/mcp/ProvenanceStamper";

describe("ProvenanceStamper", () => {
	let store: Map<string, string>;
	let writeCount: number;

	const deps = {
		read: async (path: string) => {
			const content = store.get(path);
			if (content === undefined) throw new Error(`ENOENT: ${path}`);
			return content;
		},
		write: async (path: string, content: string) => {
			writeCount++;
			store.set(path, content);
		},
		now: () => "2026-06-13",
		getAuthor: () => "Claude <i_claude>",
	};

	beforeEach(() => {
		store = new Map();
		writeCount = 0;
	});

	it("onCreate on a.md with no frontmatter adds created/createdBy/updated/updatedBy", async () => {
		store.set("a.md", "# Title\n\nContent here.\n");
		const stamper = new ProvenanceStamper(deps);

		await stamper.onCreate("a.md");

		const result = store.get("a.md")!;
		expect(result).toContain("created: 2026-06-13");
		expect(result).toContain("createdBy: Claude <i_claude>");
		expect(result).toContain("updated: 2026-06-13");
		expect(result).toContain("updatedBy: Claude <i_claude>");
		expect(result).toContain("# Title");
	});

	it("onModify on a note with created: 2000-01-01 keeps created unchanged and updates updated", async () => {
		store.set("b.md", "---\ncreated: 2000-01-01\ncreatedBy: Alice <i_alice>\n---\n\n# Title\n");
		const stamper = new ProvenanceStamper(deps);

		await stamper.onModify("b.md");

		const result = store.get("b.md")!;
		expect(result).toContain("created: 2000-01-01");
		expect(result).toContain("createdBy: Alice <i_alice>");
		expect(result).toContain("updated: 2026-06-13");
		expect(result).toContain("updatedBy: Claude <i_claude>");
	});

	it("getAuthor returning null means onCreate/onModify write nothing", async () => {
		store.set("c.md", "# Title\n");
		const stamper = new ProvenanceStamper({
			...deps,
			getAuthor: () => null,
		});

		await stamper.onCreate("c.md");
		expect(writeCount).toBe(0);
		expect(store.get("c.md")).toBe("# Title\n");

		await stamper.onModify("c.md");
		expect(writeCount).toBe(0);
	});

	it("non-.md path is ignored", async () => {
		store.set("d.txt", "Some text");
		const stamper = new ProvenanceStamper(deps);

		await stamper.onCreate("d.txt");
		expect(writeCount).toBe(0);

		await stamper.onModify("d.txt");
		expect(writeCount).toBe(0);
	});

	it(".comments.json path is ignored", async () => {
		store.set("e.comments.json", '{"comments":[]}');
		const stamper = new ProvenanceStamper(deps);

		await stamper.onCreate("e.comments.json");
		expect(writeCount).toBe(0);

		await stamper.onModify("e.comments.json");
		expect(writeCount).toBe(0);
	});

	it("loop guard: onModify(path) then onModify(path) again only writes once", async () => {
		store.set("f.md", "# Title\n");
		const stamper = new ProvenanceStamper(deps);

		// First call writes
		await stamper.onModify("f.md");
		expect(writeCount).toBe(1);

		// Second call immediately after should hit the guard
		await stamper.onModify("f.md");
		expect(writeCount).toBe(1); // Still 1, no new write
	});

	it("idempotency: calling onModify twice without guard (e.g. separate edits same day/author) stays stable", async () => {
		store.set("g.md", "# Title\n");
		const stamper = new ProvenanceStamper(deps);

		// First modify
		await stamper.onModify("g.md");
		const afterFirst = store.get("g.md")!;
		expect(writeCount).toBe(1);

		// Simulate a new edit event on the same file from a different stamper instance
		// (In real usage, the guard would have cleared after the first modify.)
		const stamper2 = new ProvenanceStamper(deps);
		await stamper2.onModify("g.md");
		const afterSecond = store.get("g.md")!;

		// The result should be identical (stampProvenance is idempotent)
		expect(afterFirst).toEqual(afterSecond);
		// The second stamper doesn't write because the content is already stamped correctly
		// (same author/date), so the idempotency backstop prevents a write
		expect(writeCount).toBe(1);
	});

	it("does not loop infinitely when guard fails to catch the echo", async () => {
		// This test verifies the idempotency backstop: even if the loop guard
		// somehow misses a write, the idempotency check (stamped !== content) prevents a loop.
		store.set("h.md", "# Title\n");

		let callCount = 0;
		const trackedDeps = {
			...deps,
			write: async (path: string, content: string) => {
				callCount++;
				// Simulate the echo-back: reading the file again immediately returns what we just wrote.
				store.set(path, content);
				// This is where a real modify event would fire in Obsidian.
				// But we won't call onModify again here to avoid infinite recursion in the test.
				// Instead, we rely on the idempotency check: on the next onModify call,
				// stampProvenance will detect that the content is already stamped correctly.
			},
		};

		const stamper = new ProvenanceStamper(trackedDeps);
		await stamper.onCreate("h.md");
		expect(callCount).toBe(1);

		// Now try to modify the same file. The content is already stamped,
		// so stampProvenance should return identical content.
		await stamper.onModify("h.md");
		// The guard was cleared by onCreate, but the loop guard in onModify
		// would not be set (only onCreate sets it). So we hit the idempotency check.
		// stampProvenance returns the same content (already stamped), so no write.
		expect(callCount).toBe(1); // Still 1, no new write due to idempotency
	});
});
