import { describe, it, expect } from "vitest";
import { readFrontmatter, applyFrontmatterEdit, FrontmatterEdit, FrontmatterRead } from "../src/frontmatter";

describe("readFrontmatter", () => {
	it("returns hasBlock: false for content without frontmatter block", () => {
		const content = "This is just a body\nwith no frontmatter";
		const result = readFrontmatter(content);
		expect(result.hasBlock).toBe(false);
		expect(result.scalars).toEqual({});
		expect(result.lists).toEqual({});
	});

	it("reads scalars from frontmatter block", () => {
		const content = `---
title: My Note
author: Alice
---
Body content`;
		const result = readFrontmatter(content);
		expect(result.hasBlock).toBe(true);
		expect(result.scalars).toEqual({ title: "My Note", author: "Alice" });
		expect(result.lists).toEqual({});
	});

	it("strips quotes from quoted scalar values", () => {
		const content = `---
title: "My Note"
author: 'Alice'
unquoted: value
---
Body`;
		const result = readFrontmatter(content);
		expect(result.scalars).toEqual({
			title: "My Note",
			author: "Alice",
			unquoted: "value",
		});
	});

	it("reads inline list format", () => {
		const content = `---
tags: [a, b, c]
authors: [Alice, Bob]
---
Body`;
		const result = readFrontmatter(content);
		expect(result.lists).toEqual({
			tags: ["a", "b", "c"],
			authors: ["Alice", "Bob"],
		});
	});

	it("reads block list format", () => {
		const content = `---
tags:
  - a
  - b
  - c
---
Body`;
		const result = readFrontmatter(content);
		expect(result.lists).toEqual({
			tags: ["a", "b", "c"],
		});
	});

	it("reads mixed scalars and lists", () => {
		const content = `---
title: My Note
tags: [x, y]
description: A note
categories:
  - work
  - review
---
Body`;
		const result = readFrontmatter(content);
		expect(result.scalars).toEqual({
			title: "My Note",
			description: "A note",
		});
		expect(result.lists).toEqual({
			tags: ["x", "y"],
			categories: ["work", "review"],
		});
	});

	it("strips quotes from list items", () => {
		const content = `---
tags: ["a", 'b', c]
---
Body`;
		const result = readFrontmatter(content);
		expect(result.lists).toEqual({
			tags: ["a", "b", "c"],
		});
	});

	it("reads empty inline list", () => {
		const content = `---
tags: []
---
Body`;
		const result = readFrontmatter(content);
		expect(result.lists).toEqual({
			tags: [],
		});
	});
});

describe("applyFrontmatterEdit - set", () => {
	it("creates frontmatter block if none exists", () => {
		const content = "Just a body";
		const edit: FrontmatterEdit = { set: { title: "New Note" } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toBe("---\ntitle: New Note\n---\nJust a body");
	});

	it("creates frontmatter block with multiple fields", () => {
		const content = "Body";
		const edit: FrontmatterEdit = { set: { title: "Note", author: "Alice" } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result.startsWith("---\n")).toBe(true);
		expect(result.includes("title: Note")).toBe(true);
		expect(result.includes("author: Alice")).toBe(true);
		expect(result.endsWith("---\nBody")).toBe(true);
	});

	it("preserves body exactly when creating frontmatter", () => {
		const body = "Line 1\nLine 2\n\nLine 4 with special: chars!";
		const content = body;
		const edit: FrontmatterEdit = { set: { title: "Test" } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result.endsWith(`---\n${body}`)).toBe(true);
	});

	it("replaces existing scalar field", () => {
		const content = `---
title: Old
author: Alice
---
Body`;
		const edit: FrontmatterEdit = { set: { title: "New" } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: New");
		expect(result).toContain("author: Alice");
		expect(result).toContain("Body");
		expect(result).not.toContain("title: Old");
	});

	it("appends new scalar field to existing block", () => {
		const content = `---
title: Note
---
Body`;
		const edit: FrontmatterEdit = { set: { author: "Alice" } };
		const result = applyFrontmatterEdit(content, edit);
		const lines = result.split("\n");
		expect(lines).toContain("title: Note");
		expect(lines).toContain("author: Alice");
	});

	it("preserves other fields and body when setting one field", () => {
		const content = `---
title: Note
author: Alice
tags: [a, b]
---
Line 1
Line 2`;
		const edit: FrontmatterEdit = { set: { title: "Updated" } };
		const result = applyFrontmatterEdit(content, edit);

		// Check the edit took effect
		expect(result).toContain("title: Updated");

		// Check other fields are unchanged
		expect(result).toContain("author: Alice");
		expect(result).toContain("tags: [a, b]");

		// Check body is byte-for-byte identical
		expect(result.endsWith("---\nLine 1\nLine 2")).toBe(true);
	});
});

describe("applyFrontmatterEdit - unset", () => {
	it("removes a scalar field", () => {
		const content = `---
title: Note
author: Alice
---
Body`;
		const edit: FrontmatterEdit = { unset: ["author"] };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: Note");
		expect(result).not.toContain("author:");
		expect(result).toContain("Body");
	});

	it("removes a block list field", () => {
		const content = `---
title: Note
tags:
  - a
  - b
author: Alice
---
Body`;
		const edit: FrontmatterEdit = { unset: ["tags"] };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: Note");
		expect(result).toContain("author: Alice");
		expect(result).not.toContain("tags:");
		expect(result).not.toContain("  - a");
		expect(result).not.toContain("  - b");
	});

	it("preserves other fields when unsetting one", () => {
		const content = `---
title: Note
author: Alice
description: A test
---
Body line 1
Body line 2`;
		const edit: FrontmatterEdit = { unset: ["author"] };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: Note");
		expect(result).toContain("description: A test");
		expect(result.endsWith("---\nBody line 1\nBody line 2")).toBe(true);
	});

	it("handles unsetting non-existent field gracefully", () => {
		const content = `---
title: Note
---
Body`;
		const edit: FrontmatterEdit = { unset: ["nonexistent"] };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: Note");
		expect(result).toContain("Body");
	});
});

describe("applyFrontmatterEdit - listAdd", () => {
	it("creates inline list for new field", () => {
		const content = `---
title: Note
---
Body`;
		const edit: FrontmatterEdit = { listAdd: { field: "tags", items: ["a"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("tags: [a]");
	});

	it("creates inline list with multiple items", () => {
		const content = `---
title: Note
---
Body`;
		const edit: FrontmatterEdit = { listAdd: { field: "tags", items: ["a", "b", "c"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("tags: [a, b, c]");
	});

	it("adds to existing inline list without duplicates", () => {
		const content = `---
tags: [a, b]
---
Body`;
		const edit: FrontmatterEdit = { listAdd: { field: "tags", items: ["b", "c"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("tags: [a, b, c]");
	});

	it("appends to block list and preserves block form", () => {
		const content = `---
tags:
  - a
  - b
---
Body`;
		const edit: FrontmatterEdit = { listAdd: { field: "tags", items: ["c"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("  - a");
		expect(result).toContain("  - b");
		expect(result).toContain("  - c");
		expect(result).not.toContain("tags: [");
	});

	it("creates frontmatter block if needed for listAdd", () => {
		const content = "Just body";
		const edit: FrontmatterEdit = { listAdd: { field: "tags", items: ["x"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result.startsWith("---\n")).toBe(true);
		expect(result).toContain("tags: [x]");
		expect(result).toContain("Just body");
	});

	it("does not add duplicate items to inline list", () => {
		const content = `---
tags: [a, b]
---
Body`;
		const edit: FrontmatterEdit = { listAdd: { field: "tags", items: ["a"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("tags: [a, b]");
	});
});

describe("applyFrontmatterEdit - listRemove", () => {
	it("removes items from inline list", () => {
		const content = `---
tags: [a, b, c]
---
Body`;
		const edit: FrontmatterEdit = { listRemove: { field: "tags", items: ["b"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("tags: [a, c]");
	});

	it("removes items from block list", () => {
		const content = `---
tags:
  - a
  - b
  - c
---
Body`;
		const edit: FrontmatterEdit = { listRemove: { field: "tags", items: ["b"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("  - a");
		expect(result).toContain("  - c");
		expect(result).not.toContain("  - b");
	});

	it("leaves empty list as empty inline list", () => {
		const content = `---
tags: [a]
---
Body`;
		const edit: FrontmatterEdit = { listRemove: { field: "tags", items: ["a"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("tags: []");
	});

	it("handles removing non-existent items gracefully", () => {
		const content = `---
tags: [a, b]
---
Body`;
		const edit: FrontmatterEdit = { listRemove: { field: "tags", items: ["x"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("tags: [a, b]");
	});

	it("handles removing from non-existent field gracefully", () => {
		const content = `---
title: Note
---
Body`;
		const edit: FrontmatterEdit = { listRemove: { field: "tags", items: ["a"] } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: Note");
		expect(result).toContain("Body");
	});
});

describe("applyFrontmatterEdit - combined operations", () => {
	it("applies set, unset, listAdd in order", () => {
		const content = `---
title: Old
author: Alice
---
Body`;
		const edit: FrontmatterEdit = {
			set: { title: "New" },
			unset: ["author"],
			listAdd: { field: "tags", items: ["x"] },
		};
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: New");
		expect(result).not.toContain("author:");
		expect(result).toContain("tags: [x]");
	});

	it("applies all four operations in correct order", () => {
		const content = `---
title: Note
category: work
tags: [a]
remove_me: yes
---
Body`;
		const edit: FrontmatterEdit = {
			set: { title: "Updated" },
			unset: ["remove_me"],
			listAdd: { field: "tags", items: ["b"] },
			listRemove: { field: "tags", items: ["a"] },
		};
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: Updated");
		expect(result).toContain("category: work");
		expect(result).not.toContain("remove_me:");
		expect(result).toContain("tags: [b]");
	});
});

describe("round-trip invariants", () => {
	it("preserves untouched fields and body byte-for-byte", () => {
		const content = `---
title: My Note
author: Alice
description: Multi-line description here
tags:
  - work
  - important
status: active
---
This is the body.
With multiple lines.

And blank lines in between.
Special chars: !@#$%^&*()`;

		const edit: FrontmatterEdit = { set: { title: "Changed Only" } };
		const result = applyFrontmatterEdit(content, edit);

		// The body should be identical
		const expectedBody = `This is the body.
With multiple lines.

And blank lines in between.
Special chars: !@#$%^&*()`;
		expect(result.endsWith(`---\n${expectedBody}`)).toBe(true);

		// Other fields should be unchanged
		expect(result).toContain("author: Alice");
		expect(result).toContain("description: Multi-line description here");
		expect(result).toContain("  - work");
		expect(result).toContain("  - important");
		expect(result).toContain("status: active");

		// Only the set field should change
		expect(result).toContain("title: Changed Only");
		expect(result).not.toContain("title: My Note");
	});

	it("preserves fields not mentioned in edit", () => {
		const content = `---
field1: value1
field2: value2
field3: value3
field4: value4
---
Body`;

		const edit: FrontmatterEdit = { set: { field2: "new_value" } };
		const result = applyFrontmatterEdit(content, edit);

		expect(result).toContain("field1: value1");
		expect(result).toContain("field2: new_value");
		expect(result).toContain("field3: value3");
		expect(result).toContain("field4: value4");
	});

	it("preserves unknown YAML structures", () => {
		const content = `---
title: Note
# This is a comment
blank_line_above: true

nested:
  inner: value
tags: [a, b]
---
Body`;

		const edit: FrontmatterEdit = { set: { title: "Updated" } };
		const result = applyFrontmatterEdit(content, edit);

		// Comment and structure should survive
		expect(result).toContain("# This is a comment");
		expect(result).toContain("blank_line_above: true");
		// Note: nested structures are not parsed, so they stay as-is
		expect(result).toContain("nested:");
	});
});

describe("edge cases", () => {
	it("handles empty body correctly", () => {
		const content = "---\ntitle: Note\n---\n";
		const edit: FrontmatterEdit = { set: { author: "Alice" } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toBe("---\ntitle: Note\nauthor: Alice\n---\n");
	});

	it("handles content with no trailing newline", () => {
		const content = "Body without newline";
		const edit: FrontmatterEdit = { set: { title: "Note" } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("title: Note");
		expect(result).toContain("Body without newline");
	});

	it("handles fields with colons in values", () => {
		const content = `---
title: Note
---
Body`;
		const edit: FrontmatterEdit = { set: { url: "https://example.com:8080" } };
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toContain("url: https://example.com:8080");
	});

	it("handles whitespace-only lines in block lists", () => {
		const content = `---
tags:
  - a

  - b
---
Body`;
		const result = readFrontmatter(content);
		// Should handle gracefully (may or may not include blank lines)
		expect(result.lists.tags).toContain("a");
		expect(result.lists.tags).toContain("b");
	});

	it("does not create frontmatter block for empty edits", () => {
		const content = "Just body";
		const edit: FrontmatterEdit = {};
		const result = applyFrontmatterEdit(content, edit);
		expect(result).toBe("Just body");
	});

	it("handles list items with internal spaces", () => {
		const content = `---
tags: [item one, item two]
---
Body`;
		const result = readFrontmatter(content);
		expect(result.lists.tags).toEqual(["item one", "item two"]);
	});
});
