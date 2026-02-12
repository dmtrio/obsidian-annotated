import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { Comment, DEFAULT_SETTINGS, PluginSettings, RangeLocation } from "./types";
import { CommentManager } from "./managers/CommentManager";
import { CommentModal } from "./ui/CommentModal";

export default class AnnotatedPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	commentManager: CommentManager;

	async onload() {
		await this.loadSettings();
		this.commentManager = new CommentManager(this.app.vault);
		this.addSettingTab(new AnnotatedSettingTab(this.app, this));

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
					new Notice("Comment added");
				}).open();
			},
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path.endsWith(".comments")) {
					const notePath = file.path.slice(0, -".comments".length);
					this.commentManager.invalidateCache(notePath);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file.path.endsWith(".comments")) {
					const notePath = file.path.slice(0, -".comments".length);
					this.commentManager.invalidateCache(notePath);
				}
			})
		);

		console.log("Annotated plugin loaded");
	}

	onunload() {
		this.commentManager.clearCache();
		console.log("Annotated plugin unloaded");
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
