// The frontmatter watch surface: pure query mirroring actionableQuery patterns.
// Matches notes by a frontmatter field (default "annotated") against optional triggers
// and scopes, returning structured refs for display/monitoring.

import { pathInScope } from "./actionableQuery";

export interface FrontmatterRef {
	note_path: string;
	field: string;       // e.g. "annotated"
	value: string;       // full value, e.g. "translate/spanish,french"
	root: string;        // part before the separator, e.g. "translate"
	arg: string | null;  // part after the first separator, e.g. "spanish,french"; null if no separator
}

export interface FrontmatterQueryParams {
	field?: string;        // default "annotated"
	triggers?: string[];   // if non-empty, only values whose ROOT is in this list match; if empty/undefined, every note that has the field set matches
	scope?: string | string[]; // folder/exact path(s); empty = all
	sep?: string;          // default "/"
}

export function queryActionableFrontmatter(
	notes: Array<{ path: string; frontmatter: Record<string, string> }>,
	params: FrontmatterQueryParams = {},
): FrontmatterRef[] {
	const field = params.field ?? "annotated";
	const sep = params.sep ?? "/";
	const triggers = params.triggers && params.triggers.length > 0 ? new Set(params.triggers) : null;

	// Normalize scope to array
	const scopes = Array.isArray(params.scope)
		? params.scope
		: params.scope
			? [params.scope]
			: [undefined];

	const refs: FrontmatterRef[] = [];

	for (const note of notes) {
		// Check scope first
		if (!scopes.some((scope) => pathInScope(note.path, scope))) continue;

		// Get the field value
		const value = note.frontmatter[field];
		if (!value || value.length === 0) continue;

		// Split into root and arg
		const sepIdx = value.indexOf(sep);
		const root = sepIdx === -1 ? value : value.slice(0, sepIdx);
		const arg = sepIdx === -1 ? null : value.slice(sepIdx + sep.length);

		// Filter by trigger if provided
		if (triggers && !triggers.has(root)) continue;

		refs.push({
			note_path: note.path,
			field,
			value,
			root,
			arg,
		});
	}

	// Sort by note_path ascending (deterministic)
	refs.sort((a, b) => a.note_path.localeCompare(b.note_path));
	return refs;
}
