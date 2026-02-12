import { App, Modal } from "obsidian";

export class CommentModal extends Modal {
	private onSubmit: (content: string) => void;

	constructor(app: App, onSubmit: (content: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Add Comment" });

		const textarea = contentEl.createEl("textarea", {
			attr: { placeholder: "Enter your comment...", rows: "5" },
		});
		textarea.style.width = "100%";
		textarea.focus();

		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				submit();
			}
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
		});

		const submitBtn = buttonRow.createEl("button", { text: "Submit", cls: "mod-cta" });
		submitBtn.addEventListener("click", () => submit());

		const submit = () => {
			const value = textarea.value.trim();
			if (!value) return;
			this.onSubmit(value);
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}
