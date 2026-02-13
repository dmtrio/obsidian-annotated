import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import { Comment, CommentFile, CommentReply, DEFAULT_SETTINGS, PluginSettings, RangeLocation } from "./types";
import { CommentManager } from "./managers/CommentManager";
import { CommentModal, CommentModalOptions } from "./ui/CommentModal";
import { CommentPopup } from "./ui/CommentPopup";
import { createCommentGutterExtension, setCommentLines, CommentLineMap } from "./editor/CommentGutterExtension";
import { captureSnippet, findLineBySnippet } from "./utils/SnippetMatcher";
import {
	commentTrackerField,
	commentPositionTrackerPlugin,
	setCommentTrackerPositions,
	trackerCallbacks,
} from "./editor/CommentPositionTracker";

export default class AnnotatedPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	commentManager: CommentManager;
	private commentPopup: CommentPopup;
	private _isSelfSave = false;

	async onload() {
		await this.loadSettings();
		this.commentManager = new CommentManager(this.app.vault);
		this.addSettingTab(new AnnotatedSettingTab(this.app, this));

		// Create popup before gutter extension
		this.commentPopup = new CommentPopup(this.settings, {
			onReply: (comment) => this.handleReply(comment),
			onResolve: (comment) => this.handleResolve(comment),
		});

		// Register CM6 gutter extension
		const gutterExt = createCommentGutterExtension((view, line, _count) => {
			this.openCommentPopup(view, line);
		});
		this.registerEditorExtension(gutterExt);

		// Register tracker extension with facet callbacks
		this.registerEditorExtension([
			commentTrackerField,
			trackerCallbacks.of({
				saveTrackedPositions: (filePath, updates) => this.saveTrackedPositions(filePath, updates),
				getFilePath: () => {
					const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
					return mdView?.file?.path ?? null;
				},
			}),
			commentPositionTrackerPlugin,
		]);

		this.addCommand({
			id: "add-comment",
			name: "Add Comment",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file) {
					new Notice("No active file");
					return;
				}

				const from = editor.getCursor("from");
				const to = editor.getCursor("to");

				const location: RangeLocation = {
					type: "range",
					start_line: from.line + 1,
					start_char: from.ch,
					end_line: to.line + 1,
					end_char: to.ch,
				};

				const makeOnSubmit = (loc: RangeLocation) => async (content: string, author: string) => {
					const now = new Date().toISOString();
					const comment: Comment = {
						id: this.commentManager.generateId(),
						author,
						created_at: now,
						updated_at: now,
						location: loc,
						content,
						status: "open",
						replies: [],
						content_snippet: captureSnippet(editor.getLine(loc.start_line - 1)),
					};
					await this.commentManager.addComment(file.path, comment);
					await this.refreshGutterForFile(file.path);
					new Notice("Comment added");
				};

				this.openCommentModal(
					{
						mode: "create",
						author: this.settings.defaultAuthor,
						location,
						snippet: captureSnippet(editor.getLine(from.line)),
						onSubmit: makeOnSubmit(location),
					},
					{ onSubmitFactory: makeOnSubmit },
				);
			},
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path.endsWith(".comments")) {
					if (this._isSelfSave) return;
					const notePath = file.path.slice(0, -".comments".length);
					this.commentManager.invalidateCache(notePath);
					this.refreshGutterForFile(notePath);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file.path.endsWith(".comments")) {
					const notePath = file.path.slice(0, -".comments".length);
					this.commentManager.invalidateCache(notePath);
					this.refreshGutterForFile(notePath);
				}
			})
		);

		// Refresh gutter when switching between notes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", async (leaf) => {
				this.commentPopup.close();
				if (!leaf) return;
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file) {
					const filePath = view.file.path;
					await this.verifyAndRelocateComments(filePath);
					await this.refreshGutterForFile(filePath);
				}
			})
		);

		// Refresh all open files on startup
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves(async (leaf) => {
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file) {
					const filePath = view.file.path;
					await this.verifyAndRelocateComments(filePath);
					await this.refreshGutterForFile(filePath);
				}
			});
		});

		console.log("Annotated plugin loaded");
	}

	onunload() {
		this.commentPopup.destroy();
		this.commentManager.clearCache();
		console.log("Annotated plugin unloaded");
	}

	async refreshGutterForFile(filePath: string): Promise<void> {
		const commentFile = await this.commentManager.getComments(filePath);
		const lineMap: CommentLineMap = new Map();

		if (commentFile) {
			for (const c of commentFile.comments) {
				// Respect hide settings
				if (this.settings.hideResolvedByDefault && c.status === "resolved") continue;
				if (this.settings.hideArchivedByDefault && c.status === "archived") continue;

				const line = c.location.start_line;
				const existing = lineMap.get(line);
				if (existing) {
					existing.count += 1;
					existing.hasStale = existing.hasStale || (c.is_stale === true);
				} else {
					lineMap.set(line, { count: 1, hasStale: c.is_stale === true });
				}
			}
		}

		// Dispatch to all editor views showing this file
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === filePath) {
				const cmEditor = (view.editor as any).cm as EditorView | undefined;
				if (cmEditor) {
					cmEditor.dispatch({ effects: setCommentLines.of(lineMap) });
				}
			}
		});

		// Also init tracker positions
		if (commentFile) {
			this.initTrackerPositions(filePath, commentFile);
		}
	}

	private async verifyAndRelocateComments(filePath: string): Promise<void> {
		const commentFile = await this.commentManager.getComments(filePath);
		if (!commentFile || commentFile.comments.length === 0) return;

		const noteContent = await this.app.vault.adapter.read(filePath).catch(() => null);
		if (!noteContent) return;

		const docLines = noteContent.split("\n");
		let changed = false;

		for (const comment of commentFile.comments) {
			const storedLine = comment.location.start_line - 1; // 0-indexed
			const snippet = comment.content_snippet;

			if (!snippet) {
				// Legacy comment: backfill snippet
				if (storedLine >= 0 && storedLine < docLines.length) {
					comment.content_snippet = captureSnippet(docLines[storedLine]);
					changed = true;
				}
				continue;
			}

			// Check if current line still matches
			if (storedLine >= 0 && storedLine < docLines.length && docLines[storedLine].startsWith(snippet)) {
				// Still matches, clear stale flag if set
				if (comment.is_stale) {
					comment.is_stale = false;
					changed = true;
				}
				continue;
			}

			// Mismatch — try to relocate
			const result = findLineBySnippet(docLines, snippet, storedLine);
			if (result) {
				const newLine1 = result.line + 1; // back to 1-indexed
				const lineDelta = newLine1 - comment.location.start_line;
				comment.location.start_line = newLine1;
				comment.location.end_line += lineDelta;
				comment.content_snippet = captureSnippet(docLines[result.line]);
				if (comment.is_stale) comment.is_stale = false;
				changed = true;
			} else {
				// Cannot find — mark stale
				if (!comment.is_stale) {
					comment.is_stale = true;
					changed = true;
				}
			}
		}

		if (changed) {
			this._isSelfSave = true;
			await this.commentManager.saveComments(commentFile);
			setTimeout(() => { this._isSelfSave = false; }, 500);
		}
	}

	private async saveTrackedPositions(filePath: string, lineUpdates: Map<string, number>): Promise<void> {
		const commentFile = await this.commentManager.getComments(filePath);
		if (!commentFile) return;

		const noteContent = await this.app.vault.adapter.read(filePath).catch(() => null);
		const docLines = noteContent ? noteContent.split("\n") : [];

		let changed = false;
		for (const comment of commentFile.comments) {
			const newLine = lineUpdates.get(comment.id);
			if (newLine === undefined) continue;
			if (comment.location.start_line !== newLine) {
				const lineDelta = newLine - comment.location.start_line;
				comment.location.start_line = newLine;
				comment.location.end_line += lineDelta;
				// Recapture snippet at new position
				const idx = newLine - 1;
				if (idx >= 0 && idx < docLines.length) {
					comment.content_snippet = captureSnippet(docLines[idx]);
				}
				changed = true;
			}
		}

		if (changed) {
			this._isSelfSave = true;
			await this.commentManager.saveComments(commentFile);
			setTimeout(() => { this._isSelfSave = false; }, 500);
		}
	}

	private initTrackerPositions(filePath: string, commentFile: CommentFile): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === filePath) {
				const cmEditor = (view.editor as any).cm as EditorView | undefined;
				if (cmEditor) {
					const doc = cmEditor.state.doc;
					const positions = new Map<string, number>();
					for (const c of commentFile.comments) {
						const line = c.location.start_line;
						if (line >= 1 && line <= doc.lines) {
							positions.set(c.id, doc.line(line).from);
						}
					}
					cmEditor.dispatch({ effects: setCommentTrackerPositions.of(positions) });
				}
			}
		});
	}

	private getEditorViewForFile(filePath: string): EditorView | null {
		let result: EditorView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (result) return;
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === filePath) {
				result = (view.editor as any).cm as EditorView ?? null;
			}
		});
		return result;
	}

	private async openCommentPopup(view: EditorView, line: number): Promise<void> {
		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!mdView?.file) return;

		const filePath = mdView.file.path;
		const commentFile = await this.commentManager.getComments(filePath);
		if (!commentFile) return;

		const comments = commentFile.comments.filter((c) => {
			if (this.settings.hideResolvedByDefault && c.status === "resolved") return false;
			if (this.settings.hideArchivedByDefault && c.status === "archived") return false;
			return c.location.start_line === line;
		});

		if (comments.length === 0) return;
		this.commentPopup.open(view, line, comments);
	}

	private openCommentModal(
		opts: CommentModalOptions,
		extra?: { draftContent?: string; onSubmitFactory?: (loc: RangeLocation) => CommentModalOptions["onSubmit"] },
	): void {
		const finalOpts: CommentModalOptions = { ...opts, draftContent: extra?.draftContent };

		if (opts.mode === "create" && opts.location) {
			finalOpts.onReselect = () => {
				const draft = modal.getDraftContent();
				modal.close();

				new Notice("Select new location in the editor");

				const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const editorDom = mdView
					? ((mdView.editor as any).cm as EditorView | undefined)?.dom
					: null;

				if (!editorDom) return;

				let settled: ReturnType<typeof setTimeout> | null = null;
				const cleanup = () => {
					clearTimeout(timeout);
					if (settled) clearTimeout(settled);
					editorDom.removeEventListener("mouseup", onMouseUp);
				};

				const timeout = window.setTimeout(() => {
					cleanup();
					new Notice("Re-select cancelled");
				}, 10000);

				const onMouseUp = () => {
					// Clear any pending settle — user may still be adjusting selection
					if (settled) clearTimeout(settled);

					// Wait 300ms to let the user finish dragging or just click
					settled = setTimeout(() => {
						const editor = mdView!.editor;
						const from = editor.getCursor("from");
						const to = editor.getCursor("to");

						cleanup();

						const hasSelection = from.line !== to.line || from.ch !== to.ch;
						const newLocation: RangeLocation = {
							type: "range",
							start_line: from.line + 1,
							start_char: hasSelection ? from.ch : 0,
							end_line: to.line + 1,
							end_char: hasSelection ? to.ch : 0,
						};

						const newSnippet = captureSnippet(editor.getLine(from.line));

						const newOpts: CommentModalOptions = {
							...opts,
							location: newLocation,
							snippet: newSnippet,
							onSubmit: extra?.onSubmitFactory
								? extra.onSubmitFactory(newLocation)
								: opts.onSubmit,
						};
						this.openCommentModal(newOpts, { draftContent: draft, onSubmitFactory: extra?.onSubmitFactory });
					}, 300);
				};

				editorDom.addEventListener("mouseup", onMouseUp);
			};
		}

		const modal = new CommentModal(this.app, finalOpts);
		modal.open();
	}

	private handleReply(comment: Comment): void {
		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!mdView?.file) return;

		const filePath = mdView.file.path;
		const cmEditor = (mdView.editor as any).cm as EditorView | undefined;

		this.openCommentModal({
			mode: "reply",
			author: this.settings.defaultAuthor,
			replyingTo: comment.author,
			onSubmit: async (content: string, author: string) => {
				const now = new Date().toISOString();
				const reply: CommentReply = {
					id: this.commentManager.generateId(),
					author,
					created_at: now,
					updated_at: now,
					content,
					status: "open",
				};
				await this.commentManager.addReply(filePath, comment.id, reply);
				await this.refreshGutterForFile(filePath);

				// Re-open popup to show new reply
				if (cmEditor) {
					this.openCommentPopup(cmEditor, comment.location.start_line);
				}
			},
		});
	}

	private handleResolve(comment: Comment): void {
		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!mdView?.file) return;

		const filePath = mdView.file.path;
		const cmEditor = (mdView.editor as any).cm as EditorView | undefined;

		this.commentManager.resolveComment(filePath, comment.id, this.settings.defaultAuthor).then(async () => {
			await this.refreshGutterForFile(filePath);
			this.commentPopup.close();

			// Re-open if there are still visible comments on that line
			if (cmEditor) {
				this.openCommentPopup(cmEditor, comment.location.start_line);
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AnnotatedSettingTab extends PluginSettingTab {
	plugin: AnnotatedPlugin;

	constructor(app: App, plugin: AnnotatedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Annotated Settings" });

		new Setting(containerEl)
			.setName("Default author")
			.setDesc("Author name used when creating comments")
			.addText((text) =>
				text
					.setPlaceholder("author")
					.setValue(this.plugin.settings.defaultAuthor)
					.onChange(async (value) => {
						this.plugin.settings.defaultAuthor = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
