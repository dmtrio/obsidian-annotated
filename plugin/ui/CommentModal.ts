import { App, Modal } from "obsidian";
import { RangeLocation } from "../types";
import { formatLocationText } from "../utils/FormatUtils";
import { strings } from "../i18n/strings";

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
			contentEl.createEl("h3", { text: strings.modal.replyTo(opts.replyingTo) });
		} else {
			contentEl.createEl("h3", { text: strings.modal.addComment });
		}

		// Author field
		const authorContainer = contentEl.createDiv({ cls: "annotated-modal-author" });
		authorContainer.createEl("label", { text: strings.modal.authorLabel });
		const authorInput = authorContainer.createEl("input", {
			type: "text",
			value: opts.author,
		});
		authorInput.value = opts.author;

		// Location bar (create mode only)
		if (opts.mode === "create" && opts.location) {
			const locBar = contentEl.createDiv({ cls: "annotated-modal-location" });
			locBar.createSpan({ text: formatLocationText(opts.location) });

			if (opts.onReselect) {
				const reselectBtn = locBar.createEl("button", {
					text: strings.modal.reselect,
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
			attr: { placeholder: strings.modal.placeholder, rows: "5" },
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

		buttonRow.createEl("button", { text: strings.modal.cancel }).addEventListener("click", () => {
			this.close();
		});

		const submitBtn = buttonRow.createEl("button", { text: strings.modal.submit, cls: "mod-cta" });
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
