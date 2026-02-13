import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import { Comment, CommentReply, DEFAULT_SETTINGS, PluginSettings, RangeLocation } from "./types";
import { CommentManager } from "./managers/CommentManager";
import { CommentModal } from "./ui/CommentModal";
import { CommentPopup } from "./ui/CommentPopup";
import { createCommentGutterExtension, setCommentLines, CommentLineMap } from "./editor/CommentGutterExtension";

export default class AnnotatedPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	commentManager: CommentManager;
	private commentPopup: CommentPopup;

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

		this.addCommand({
			id: "add-comment",
			name: "Add Comment",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file) {
					new Notice("No active file");
					return;
				}

				const from = editor.getCursor("from");
				const to = editor.getCursor("to");

				new CommentModal(this.app, async (content: string) => {
					const now = new Date().toISOString();
					const location: RangeLocation = {
						type: "range",
						start_line: from.line + 1,
						start_char: from.ch,
						end_line: to.line + 1,
						end_char: to.ch,
					};
					const comment: Comment = {
						id: this.commentManager.generateId(),
						author: this.settings.defaultAuthor,
						created_at: now,
						updated_at: now,
						location,
						content,
						status: "open",
						replies: [],
					};
					await this.commentManager.addComment(file.path, comment);
					await this.refreshGutterForFile(file.path);
					new Notice("Comment added");
				}).open();
			},
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path.endsWith(".comments")) {
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
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.commentPopup.close();
				if (!leaf) return;
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file) {
					this.refreshGutterForFile(view.file.path);
				}
			})
		);

		// Refresh all open files on startup
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves((leaf) => {
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file) {
					this.refreshGutterForFile(view.file.path);
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
				lineMap.set(line, (lineMap.get(line) ?? 0) + 1);
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

	private handleReply(comment: Comment): void {
		const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!mdView?.file) return;

		const filePath = mdView.file.path;
		const cmEditor = (mdView.editor as any).cm as EditorView | undefined;

		new CommentModal(this.app, async (content: string) => {
			const now = new Date().toISOString();
			const reply: CommentReply = {
				id: this.commentManager.generateId(),
				author: this.settings.defaultAuthor,
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
		}).open();
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
