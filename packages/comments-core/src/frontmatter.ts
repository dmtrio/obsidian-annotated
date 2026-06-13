// Frontmatter editing helper for markdown notes with YAML blocks
//
// Supported YAML subset (must be round-trip-safe):
// - Scalars: single-line "key: value" (quoted values have quotes stripped on read)
// - Lists in two forms:
//   - Inline: tags: [a, b, c]
//   - Block:
//       tags:
//         - a
//         - b
// - Unknown lines (nested maps, comments, blank lines) are preserved as-is
//
// A frontmatter block must begin with "---\n" and end with exactly "---\n"
// followed by the document body. The body is NEVER modified by these functions.

export interface FrontmatterEdit {
	set?: Record<string, string>;                     // set/replace scalar fields
	unset?: string[];                                 // remove these fields entirely
	listAdd?: { field: string; items: string[] };     // add items to a list field (no duplicates)
	listRemove?: { field: string; items: string[] };  // remove items from a list field
}

export interface FrontmatterRead {
	hasBlock: boolean;
	scalars: Record<string, string>;   // single-line "key: value" fields (value trimmed, surrounding quotes stripped)
	lists: Record<string, string[]>;   // list fields, from inline [a, b] OR block "- a" form
}

// Helper: split content into [frontmatter lines, closing ---, body]
function splitFrontmatter(content: string): { lines: string[]; hasBlock: boolean; bodyStartIdx: number } {
	if (!content.startsWith("---\n")) {
		return { lines: [], hasBlock: false, bodyStartIdx: 0 };
	}

	const parts = content.slice(4).split("\n");
	let closingIdx = -1;

	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "---") {
			closingIdx = i;
			break;
		}
	}

	if (closingIdx === -1) {
		// No closing ---, treat entire file as body
		return { lines: [], hasBlock: false, bodyStartIdx: 0 };
	}

	const fmLines = parts.slice(0, closingIdx);
	// bodyStartIdx is the byte position after the closing "---\n"
	const bodyStartIdx = 4 + parts.slice(0, closingIdx + 1).join("\n").length + 1; // +1 for final \n

	return { lines: fmLines, hasBlock: true, bodyStartIdx };
}

// Helper: parse a YAML scalar value, stripping surrounding quotes
function parseScalarValue(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

// Helper: parse inline list [a, b, c]
function parseInlineList(value: string): string[] | null {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
		return null;
	}
	const inner = trimmed.slice(1, -1).trim();
	if (inner === "") {
		return [];
	}
	return inner.split(",").map((item) => parseScalarValue(item));
}

// Helper: format inline list
function formatInlineList(items: string[]): string {
	return `[${items.join(", ")}]`;
}

export function readFrontmatter(content: string): FrontmatterRead {
	const { lines, hasBlock } = splitFrontmatter(content);

	const scalars: Record<string, string> = {};
	const lists: Record<string, string[]> = {};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		// Skip blank lines and lines that don't look like key: value
		if (!line.trim() || !line.includes(":")) {
			i++;
			continue;
		}

		const colonIdx = line.indexOf(":");
		const key = line.slice(0, colonIdx).trim();
		const rest = line.slice(colonIdx + 1).trim();

		// Try to parse as inline list
		const inlineList = parseInlineList(rest);
		if (inlineList !== null) {
			lists[key] = inlineList;
			i++;
			continue;
		}

		// Check if this is a block list (next lines start with "  - ")
		if (rest === "" && i + 1 < lines.length) {
			const blockItems: string[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const nextLine = lines[j];
				if (nextLine.match(/^\s{0,4}-\s/)) {
					const item = nextLine.replace(/^\s{0,4}-\s/, "").trim();
					blockItems.push(parseScalarValue(item));
					j++;
				} else if (nextLine.trim() === "") {
					j++;
				} else {
					break;
				}
			}
			if (blockItems.length > 0) {
				lists[key] = blockItems;
				i = j;
				continue;
			}
		}

		// Regular scalar
		scalars[key] = parseScalarValue(rest);
		i++;
	}

	return { hasBlock, scalars, lists };
}

export function applyFrontmatterEdit(content: string, edit: FrontmatterEdit): string {
	const { lines: fmLines, hasBlock, bodyStartIdx } = splitFrontmatter(content);
	const body = content.slice(bodyStartIdx);

	let lines = [...fmLines];

	// 1. Set fields
	if (edit.set) {
		for (const [field, value] of Object.entries(edit.set)) {
			const existingIdx = lines.findIndex((line) => line.match(new RegExp(`^${escapeRegex(field)}:`)));
			const newLine = `${field}: ${value}`;

			if (existingIdx !== -1) {
				// Replace existing line
				lines[existingIdx] = newLine;
			} else {
				// Append before closing ---
				lines.push(newLine);
			}
		}
	}

	// 2. Unset fields
	if (edit.unset) {
		const fieldsToRemove = new Set(edit.unset);
		const cleaned: string[] = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			if (!line.trim()) {
				cleaned.push(line);
				i++;
				continue;
			}

			const colonIdx = line.indexOf(":");
			if (colonIdx === -1) {
				cleaned.push(line);
				i++;
				continue;
			}

			const key = line.slice(0, colonIdx).trim();
			if (fieldsToRemove.has(key)) {
				// Skip this line and any following "  - " items (for block lists)
				i++;
				while (i < lines.length && lines[i].match(/^\s{0,4}-\s/)) {
					i++;
				}
				continue;
			}

			cleaned.push(line);
			i++;
		}
		lines = cleaned;
	}

	// 3. List add
	if (edit.listAdd) {
		const { field, items } = edit.listAdd;
		const existingIdx = lines.findIndex((line) => line.match(new RegExp(`^${escapeRegex(field)}:`)));

		if (existingIdx === -1) {
			// Field doesn't exist, create as inline list
			lines.push(`${field}: ${formatInlineList(items)}`);
		} else {
			// Parse current list
			const line = lines[existingIdx];
			const colonIdx = line.indexOf(":");
			const rest = line.slice(colonIdx + 1).trim();

			const inlineList = parseInlineList(rest);
			if (inlineList !== null) {
				// Inline form
				const current = new Set(inlineList);
				for (const item of items) {
					current.add(item);
				}
				lines[existingIdx] = `${field}: ${formatInlineList(Array.from(current))}`;
			} else if (rest === "") {
				// Block form
				const blockItems: string[] = [];
				let j = existingIdx + 1;
				const blockItemIndices: number[] = [];
				while (j < lines.length && (lines[j].match(/^\s{0,4}-\s/) || lines[j].trim() === "")) {
					if (lines[j].match(/^\s{0,4}-\s/)) {
						const item = lines[j].replace(/^\s{0,4}-\s/, "").trim();
						blockItems.push(parseScalarValue(item));
						blockItemIndices.push(j);
					}
					j++;
				}

				const current = new Set(blockItems);
				const newItems = [];
				for (const item of items) {
					if (!current.has(item)) {
						newItems.push(item);
						current.add(item);
					}
				}

				// Append new items to block list
				for (const item of newItems) {
					lines.splice(j, 0, `  - ${item}`);
					j++;
				}
			}
		}
	}

	// 4. List remove
	if (edit.listRemove) {
		const { field, items } = edit.listRemove;
		const existingIdx = lines.findIndex((line) => line.match(new RegExp(`^${escapeRegex(field)}:`)));

		if (existingIdx !== -1) {
			const line = lines[existingIdx];
			const colonIdx = line.indexOf(":");
			const rest = line.slice(colonIdx + 1).trim();

			const inlineList = parseInlineList(rest);
			if (inlineList !== null) {
				// Inline form
				const removeSet = new Set(items);
				const filtered = inlineList.filter((item) => !removeSet.has(item));
				lines[existingIdx] = `${field}: ${formatInlineList(filtered)}`;
			} else if (rest === "") {
				// Block form
				const removeSet = new Set(items);
				let j = existingIdx + 1;
				while (j < lines.length && (lines[j].match(/^\s{0,4}-\s/) || lines[j].trim() === "")) {
					if (lines[j].match(/^\s{0,4}-\s/)) {
						const item = lines[j].replace(/^\s{0,4}-\s/, "").trim();
						const parsed = parseScalarValue(item);
						if (removeSet.has(parsed)) {
							lines.splice(j, 1);
						} else {
							j++;
						}
					} else {
						j++;
					}
				}
			}
		}
	}

	// Reconstruct the file
	if (!hasBlock && lines.length === 0) {
		// No frontmatter was created
		return content;
	}

	if (lines.length === 0) {
		// Had a block, now empty
		return body;
	}

	// Reconstruct with frontmatter
	return `---\n${lines.join("\n")}\n---\n${body}`;
}

// Helper: escape special regex characters
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
