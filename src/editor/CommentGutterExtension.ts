import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";

/** Per-line info: comment count and whether any are stale */
export type CommentLineInfo = { count: number; hasStale: boolean };

/** line (1-indexed) → comment line info */
export type CommentLineMap = Map<number, CommentLineInfo>;

/** Dispatch channel to push new line→count data into the editor */
export const setCommentLines = StateEffect.define<CommentLineMap>();

/** Callback type for gutter click events */
export type GutterClickCallback = (view: EditorView, line: number, count: number) => void;

/** StateField that stores the current CommentLineMap, remapping on doc changes */
export const commentLineField = StateField.define<CommentLineMap>({
	create() {
		return new Map();
	},
	update(prev, tr) {
		// Check for explicit setCommentLines effect — replaces map entirely
		for (const e of tr.effects) {
			if (e.is(setCommentLines)) {
				return e.value;
			}
		}

		// If the document changed, remap line numbers through the changes
		if (tr.docChanged && prev.size > 0) {
			const newMap: CommentLineMap = new Map();
			const doc = tr.newDoc;
			for (const [line, info] of prev) {
				// Convert 1-indexed line to a document position
				if (line < 1 || line > tr.startState.doc.lines) continue;
				const pos = tr.startState.doc.line(line).from;
				// Map position through changes
				const newPos = tr.changes.mapPos(pos, 1);
				// Convert back to line number
				if (newPos < 0 || newPos > doc.length) continue;
				const newLine = doc.lineAt(newPos).number;
				// Merge: sum counts, OR stale flags
				const existing = newMap.get(newLine);
				if (existing) {
					existing.count += info.count;
					existing.hasStale = existing.hasStale || info.hasStale;
				} else {
					newMap.set(newLine, { count: info.count, hasStale: info.hasStale });
				}
			}
			return newMap;
		}

		return prev;
	},
});

class CommentGutterMarker extends GutterMarker {
	constructor(readonly count: number, readonly hasStale: boolean) {
		super();
	}

	eq(other: CommentGutterMarker): boolean {
		return this.count === other.count && this.hasStale === other.hasStale;
	}

	toDOM(): Node {
		const wrapper = document.createElement("div");
		wrapper.className = "cm-annotated-gutter-marker" +
			(this.hasStale ? " cm-annotated-gutter-marker--stale" : "");
		wrapper.textContent = this.hasStale ? "\u26A0" : "\u{1F4AC}";
		if (this.count > 1) {
			const badge = wrapper.createSpan({ cls: "cm-annotated-gutter-badge" });
			badge.textContent = String(this.count);
		}
		return wrapper;
	}
}

// Cache markers by count+stale to avoid re-creating DOM
const markerCache = new Map<string, CommentGutterMarker>();
function getMarker(count: number, hasStale = false): CommentGutterMarker {
	const key = `${count}:${hasStale ? 1 : 0}`;
	let m = markerCache.get(key);
	if (!m) {
		m = new CommentGutterMarker(count, hasStale);
		markerCache.set(key, m);
	}
	return m;
}

/**
 * Factory that returns a CM6 Extension array: [stateField, gutter].
 * The onClick callback fires when the user clicks a gutter marker.
 */
export function createCommentGutterExtension(onClick: GutterClickCallback): Extension {
	return [
		commentLineField,
		gutter({
			class: "cm-annotated-comment-gutter",
			lineMarker(view, line) {
				const map = view.state.field(commentLineField);
				const lineNum = view.state.doc.lineAt(line.from).number;
				const info = map.get(lineNum);
				if (!info) return null;
				return getMarker(info.count, info.hasStale);
			},
			domEventHandlers: {
				click(view, line) {
					const map = view.state.field(commentLineField);
					const lineNum = view.state.doc.lineAt(line.from).number;
					const info = map.get(lineNum);
					if (info) {
						onClick(view, lineNum, info.count);
					}
					return true;
				},
			},
			initialSpacer: () => getMarker(1),
		}),
	];
}
