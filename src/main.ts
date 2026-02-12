import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings } from "./types";

export default class AnnotatedPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AnnotatedSettingTab(this.app, this));
		console.log("Annotated plugin loaded");
	}

	onunload() {
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
