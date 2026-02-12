import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";

/** line (1-indexed) → comment count */
export type CommentLineMap = Map<number, number>;

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
			for (const [line, count] of prev) {
				// Convert 1-indexed line to a document position
				if (line < 1 || line > tr.startState.doc.lines) continue;
				const pos = tr.startState.doc.line(line).from;
				// Map position through changes
				const newPos = tr.changes.mapPos(pos, 1);
				// Convert back to line number
				if (newPos < 0 || newPos > doc.length) continue;
				const newLine = doc.lineAt(newPos).number;
				// Sum counts if multiple old lines collapse into one
				newMap.set(newLine, (newMap.get(newLine) ?? 0) + count);
			}
			return newMap;
		}

		return prev;
	},
});

class CommentGutterMarker extends GutterMarker {
	constructor(readonly count: number) {
		super();
	}

	eq(other: CommentGutterMarker): boolean {
		return this.count === other.count;
	}

	toDOM(): Node {
		const wrapper = document.createElement("div");
		wrapper.className = "cm-annotated-gutter-marker";
		wrapper.textContent = "\u{1F4AC}";
		if (this.count > 1) {
			const badge = wrapper.createSpan({ cls: "cm-annotated-gutter-badge" });
			badge.textContent = String(this.count);
		}
		return wrapper;
	}
}

// Cache markers by count to avoid re-creating DOM for same counts
const markerCache = new Map<number, CommentGutterMarker>();
function getMarker(count: number): CommentGutterMarker {
	let m = markerCache.get(count);
	if (!m) {
		m = new CommentGutterMarker(count);
		markerCache.set(count, m);
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
				const count = map.get(lineNum);
				if (!count) return null;
				return getMarker(count);
			},
			domEventHandlers: {
				click(view, line) {
					const map = view.state.field(commentLineField);
					const lineNum = view.state.doc.lineAt(line.from).number;
					const count = map.get(lineNum);
					if (count) {
						onClick(view, lineNum, count);
					}
					return true;
				},
			},
			initialSpacer: () => getMarker(1),
		}),
	];
}
