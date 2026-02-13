import { App, Modal } from "obsidian";
import { RangeLocation } from "../types";

export interface CommentModalOptions {
	mode: "create" | "reply";
	author: string;
	location?: RangeLocation;
	snippet?: string;
	replyingTo?: string;
	draftContent?: string;
	onSubmit: (content: string, author: string) => void;
	onReselect?: () => void;
}

export class CommentModal extends Modal {
	private opts: CommentModalOptions;
	private textarea: HTMLTextAreaElement | null = null;

	constructor(app: App, opts: CommentModalOptions) {
		super(app);
		this.opts = opts;
	}

	/** Returns the current draft text (used by reselect to preserve content). */
	getDraftContent(): string {
		return this.textarea?.value ?? "";
	}

	onOpen() {
		const { contentEl } = this;
		const { opts } = this;

		// Header
		if (opts.mode === "reply" && opts.replyingTo) {
			contentEl.createEl("h3", { text: `Reply to ${opts.replyingTo}` });
		} else {
			contentEl.createEl("h3", { text: "Add Comment" });
		}

		// Author field
		const authorContainer = contentEl.createDiv({ cls: "annotated-modal-author" });
		authorContainer.createEl("label", { text: "Author" });
		const authorInput = authorContainer.createEl("input", {
			type: "text",
			value: opts.author,
		});
		authorInput.value = opts.author;

		// Location bar (create mode only)
		if (opts.mode === "create" && opts.location) {
			const locBar = contentEl.createDiv({ cls: "annotated-modal-location" });
			const loc = opts.location;
			const locText = loc.start_line === loc.end_line
				? `Line ${loc.start_line}`
				: `Lines ${loc.start_line}\u2013${loc.end_line}`;
			locBar.createSpan({ text: locText });

			if (opts.onReselect) {
				const reselectBtn = locBar.createEl("button", {
					text: "Re-select",
					cls: "annotated-modal-reselect-btn",
				});
				reselectBtn.addEventListener("click", () => {
					opts.onReselect!();
				});
			}
		}

		// Snippet quote (create mode only)
		if (opts.mode === "create" && opts.snippet) {
			const snippetText = opts.snippet.length >= 50
				? opts.snippet + "\u2026"
				: opts.snippet;
			contentEl.createEl("blockquote", {
				text: snippetText,
				cls: "annotated-modal-snippet",
			});
		}

		// Textarea
		const textarea = contentEl.createEl("textarea", {
			attr: { placeholder: "Enter your comment...", rows: "5" },
		});
		textarea.style.width = "100%";
		this.textarea = textarea;

		if (opts.draftContent) {
			textarea.value = opts.draftContent;
		}

		// Delay focus so it wins over Obsidian's auto-focus on the first input
		setTimeout(() => textarea.focus(), 0);

		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				submit();
			}
		});

		// Button row
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
		});

		const submitBtn = buttonRow.createEl("button", { text: "Submit", cls: "mod-cta" });
		submitBtn.addEventListener("click", () => submit());

		const submit = () => {
			const value = textarea.value.trim();
			if (!value) return;
			this.opts.onSubmit(value, authorInput.value.trim() || opts.author);
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
		this.textarea = null;
	}
}
