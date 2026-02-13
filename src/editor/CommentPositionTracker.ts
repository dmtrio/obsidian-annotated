import { Facet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from "@codemirror/view";

/** Effect to seed/replace the tracker map (comment ID → document offset) */
export const setCommentTrackerPositions = StateEffect.define<Map<string, number>>();

/** StateField: comment ID → document offset, remapped on doc changes */
export const commentTrackerField = StateField.define<Map<string, number>>({
	create() {
		return new Map();
	},
	update(prev, tr) {
		for (const e of tr.effects) {
			if (e.is(setCommentTrackerPositions)) {
				return e.value;
			}
		}
		if (tr.docChanged && prev.size > 0) {
			const next = new Map<string, number>();
			for (const [id, offset] of prev) {
				const newOffset = tr.changes.mapPos(offset, 1);
				next.set(id, newOffset);
			}
			return next;
		}
		return prev;
	},
});

/** Callbacks passed into the ViewPlugin via facet */
export interface TrackerCallbacks {
	saveTrackedPositions(filePath: string, updates: Map<string, number>): void;
	getFilePath(): string | null;
}

export const trackerCallbacks = Facet.define<TrackerCallbacks, TrackerCallbacks>({
	combine(values) {
		return values[values.length - 1];
	},
});

/** ViewPlugin: debounced save of tracked positions after edits */
class CommentPositionTrackerPluginValue implements PluginValue {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private lastSnapshot: Map<string, number> = new Map();

	constructor(private view: EditorView) {}

	update(update: ViewUpdate) {
		if (update.docChanged) {
			this.scheduleSave();
		}
	}

	private scheduleSave() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.savePositions(), 2000);
	}

	private savePositions() {
		const callbacks = this.view.state.facet(trackerCallbacks);
		if (!callbacks) return;
		const filePath = callbacks.getFilePath();
		if (!filePath) return;

		const offsets = this.view.state.field(commentTrackerField);
		if (offsets.size === 0) return;

		// Convert offsets to 1-indexed line numbers
		const lineUpdates = new Map<string, number>();
		const doc = this.view.state.doc;
		for (const [id, offset] of offsets) {
			const clampedOffset = Math.min(offset, doc.length);
			const lineNum = doc.lineAt(clampedOffset).number;
			lineUpdates.set(id, lineNum);
		}

		// Compare with last snapshot to avoid unnecessary saves
		let changed = lineUpdates.size !== this.lastSnapshot.size;
		if (!changed) {
			for (const [id, line] of lineUpdates) {
				if (this.lastSnapshot.get(id) !== line) {
					changed = true;
					break;
				}
			}
		}

		if (changed) {
			this.lastSnapshot = new Map(lineUpdates);
			callbacks.saveTrackedPositions(filePath, lineUpdates);
		}
	}

	destroy() {
		if (this.timer) clearTimeout(this.timer);
	}
}

export const commentPositionTrackerPlugin = ViewPlugin.fromClass(CommentPositionTrackerPluginValue);
