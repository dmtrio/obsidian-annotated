import { describe, it, expect } from "vitest";
import { queryActionableFrontmatter } from "../src/actionableFrontmatter";

describe("queryActionableFrontmatter", () => {
	const testNotes = [
		{ path: "inbox/a.md", frontmatter: { annotated: "review" } },
		{ path: "inbox/b.md", frontmatter: { annotated: "translate/spanish" } },
		{ path: "inbox/c.md", frontmatter: { annotated: "translate/spanish,french" } },
		{ path: "inbox/d.md", frontmatter: { annotated: "reviewed" } },
		{ path: "other/e.md", frontmatter: { annotated: "review" } },
		{ path: "inbox/f.md", frontmatter: { custom: "review" } }, // different field
		{ path: "inbox/g.md", frontmatter: {} }, // no field
	];

	it("plain value with matching trigger", () => {
		const refs = queryActionableFrontmatter(testNotes, { triggers: ["review"] });
		expect(refs).toHaveLength(2);
		expect(refs[0]).toEqual({
			note_path: "inbox/a.md",
			field: "annotated",
			value: "review",
			root: "review",
			arg: null,
		});
		expect(refs[1]).toEqual({
			note_path: "other/e.md",
			field: "annotated",
			value: "review",
			root: "review",
			arg: null,
		});
	});

	it("compound value with separator", () => {
		const refs = queryActionableFrontmatter(testNotes, { triggers: ["translate"] });
		expect(refs).toHaveLength(2);
		expect(refs[0]).toEqual({
			note_path: "inbox/b.md",
			field: "annotated",
			value: "translate/spanish",
			root: "translate",
			arg: "spanish",
		});
		expect(refs[1]).toEqual({
			note_path: "inbox/c.md",
			field: "annotated",
			value: "translate/spanish,french",
			root: "translate",
			arg: "spanish,french",
		});
	});

	it("excludes notes with different root when trigger specified", () => {
		const refs = queryActionableFrontmatter(testNotes, { triggers: ["review"] });
		const paths = refs.map((r) => r.note_path);
		expect(paths).not.toContain("inbox/d.md"); // root "reviewed" !== "review"
	});

	it("scope limits results to folder", () => {
		const refs = queryActionableFrontmatter(testNotes, { scope: "inbox", triggers: ["review"] });
		expect(refs).toHaveLength(1);
		expect(refs[0].note_path).toBe("inbox/a.md");
	});

	it("no triggers returns every note that has the field", () => {
		const refs = queryActionableFrontmatter(testNotes);
		expect(refs).toHaveLength(5); // a, b, c, d, e (not f or g)
		const paths = refs.map((r) => r.note_path);
		expect(paths).toContain("inbox/a.md");
		expect(paths).toContain("inbox/d.md"); // included when no trigger
		expect(paths).not.toContain("inbox/f.md");
		expect(paths).not.toContain("inbox/g.md");
	});

	it("skips notes lacking the field", () => {
		const refs = queryActionableFrontmatter(testNotes);
		expect(refs.map((r) => r.note_path)).not.toContain("inbox/f.md");
		expect(refs.map((r) => r.note_path)).not.toContain("inbox/g.md");
	});

	it("returns results sorted by note_path ascending", () => {
		const refs = queryActionableFrontmatter(testNotes);
		const paths = refs.map((r) => r.note_path);
		const sorted = [...paths].sort();
		expect(paths).toEqual(sorted);
	});

	it("custom field name", () => {
		const refs = queryActionableFrontmatter(testNotes, { field: "custom" });
		expect(refs).toHaveLength(1);
		expect(refs[0].note_path).toBe("inbox/f.md");
		expect(refs[0].field).toBe("custom");
	});

	it("custom separator", () => {
		const notesWithColon = [
			{ path: "a.md", frontmatter: { annotated: "translate:spanish" } },
			{ path: "b.md", frontmatter: { annotated: "translate/spanish" } },
		];
		const refs = queryActionableFrontmatter(notesWithColon, { sep: ":" });
		expect(refs).toHaveLength(2);
		expect(refs[0].root).toBe("translate");
		expect(refs[0].arg).toBe("spanish");
		expect(refs[1].root).toBe("translate/spanish");
		expect(refs[1].arg).toBeNull();
	});

	it("multiple scopes", () => {
		const refs = queryActionableFrontmatter(testNotes, { scope: ["inbox", "other"] });
		expect(refs).toHaveLength(5);
	});

	it("exact note path scope", () => {
		const refs = queryActionableFrontmatter(testNotes, { scope: "inbox/a.md" });
		expect(refs).toHaveLength(1);
		expect(refs[0].note_path).toBe("inbox/a.md");
	});

	it("empty triggers array behaves as no triggers", () => {
		const withEmpty = queryActionableFrontmatter(testNotes, { triggers: [] });
		const withUndefined = queryActionableFrontmatter(testNotes);
		expect(withEmpty).toEqual(withUndefined);
	});
});
