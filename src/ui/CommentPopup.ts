import { EditorView } from "@codemirror/view";
import { Comment, PluginSettings } from "../types";

declare const moment: typeof import("moment");

export interface CommentPopupCallbacks {
	onReply: (comment: Comment) => void;
	onResolve: (comment: Comment) => void;
}

export class CommentPopup {
	private settings: PluginSettings;
	private callbacks: CommentPopupCallbacks;
	private containerEl: HTMLElement | null = null;
	private currentLine: number | null = null;
	private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
	private scrollHandler: (() => void) | null = null;
	private scrollDOM: HTMLElement | null = null;

	constructor(settings: PluginSettings, callbacks: CommentPopupCallbacks) {
		this.settings = settings;
		this.callbacks = callbacks;
	}

	open(view: EditorView, line: number, comments: Comment[]): void {
		// Toggle behavior: close if already open for same line
		if (this.containerEl && this.currentLine === line) {
			this.close();
			return;
		}

		this.close();
		this.currentLine = line;

		const container = document.createElement("div");
		container.className = "annotated-comment-popup";
		this.containerEl = container;

		this.renderComments(container, comments);

		document.body.appendChild(container);
		this.positionPopup(view, line, container);

		// Scroll dismissal
		this.scrollDOM = view.scrollDOM;
		this.scrollHandler = () => this.close();
		this.scrollDOM.addEventListener("scroll", this.scrollHandler);

		// Click-outside dismissal (deferred to avoid same-click)
		setTimeout(() => {
			this.outsideClickHandler = (e: MouseEvent) => {
				if (this.containerEl && !this.containerEl.contains(e.target as Node)) {
					this.close();
				}
			};
			document.addEventListener("click", this.outsideClickHandler, true);
		}, 0);
	}

	close(): void {
		if (this.outsideClickHandler) {
			document.removeEventListener("click", this.outsideClickHandler, true);
			this.outsideClickHandler = null;
		}
		if (this.scrollHandler && this.scrollDOM) {
			this.scrollDOM.removeEventListener("scroll", this.scrollHandler);
			this.scrollHandler = null;
			this.scrollDOM = null;
		}
		if (this.containerEl) {
			this.containerEl.remove();
			this.containerEl = null;
		}
		this.currentLine = null;
	}

	destroy(): void {
		this.close();
	}

	private positionPopup(view: EditorView, line: number, container: HTMLElement): void {
		const doc = view.state.doc;
		if (line < 1 || line > doc.lines) return;

		const docLine = doc.line(line);
		// coordsAtPos returns screen coordinates directly
		const coords = view.coordsAtPos(docLine.from);
		if (!coords) return;

		const editorRect = view.dom.getBoundingClientRect();
		const top = coords.bottom;
		const left = editorRect.left;

		container.style.top = `${top}px`;
		container.style.left = `${left}px`;

		// Clamp to viewport after render
		requestAnimationFrame(() => {
			if (!this.containerEl) return;
			const rect = this.containerEl.getBoundingClientRect();
			const margin = 8;

			let adjustedTop = top;
			let adjustedLeft = left;

			if (rect.bottom > window.innerHeight - margin) {
				adjustedTop = coords.top - rect.height;
			}
			if (rect.right > window.innerWidth - margin) {
				adjustedLeft = window.innerWidth - rect.width - margin;
			}
			if (adjustedLeft < margin) {
				adjustedLeft = margin;
			}
			if (adjustedTop < margin) {
				adjustedTop = margin;
			}

			this.containerEl.style.top = `${adjustedTop}px`;
			this.containerEl.style.left = `${adjustedLeft}px`;
		});
	}

	private renderComments(container: HTMLElement, comments: Comment[]): void {
		const max = this.settings.maxCommentsInPopup;
		const showAll = comments.length <= max;
		let visibleComments = showAll ? comments : comments.slice(0, max);

		const render = (toShow: Comment[]) => {
			container.empty();

			for (const comment of toShow) {
				this.renderCommentCard(container, comment);
			}

			if (!showAll && toShow.length < comments.length) {
				const remaining = comments.length - toShow.length;
				const showMoreEl = container.createDiv({ cls: "annotated-popup-show-more" });
				showMoreEl.textContent = `Show ${remaining} more\u2026`;
				showMoreEl.addEventListener("click", () => render(comments));
			}

			// Close button in top-right
			const closeBtn = container.createDiv({ cls: "annotated-popup-btn--close" });
			closeBtn.textContent = "\u00D7";
			closeBtn.addEventListener("click", () => this.close());
		};

		render(visibleComments);
	}

	private renderCommentCard(container: HTMLElement, comment: Comment): void {
		const isResolved = comment.status === "resolved";
		const isStale = comment.is_stale === true;
		const cls = "annotated-popup-comment"
			+ (isResolved ? " annotated-popup-comment--resolved" : "")
			+ (isStale ? " annotated-popup-comment--stale" : "");
		const card = container.createDiv({ cls });

		// Stale notice
		if (isStale) {
			card.createDiv({
				cls: "annotated-popup-stale-notice",
				text: "This comment may have drifted from its original location.",
			});
		}

		// Header
		const header = card.createDiv({ cls: "annotated-popup-header" });
		header.createSpan({ cls: "annotated-popup-author", text: comment.author });
		header.createSpan({
			cls: "annotated-popup-timestamp",
			text: this.formatTimestamp(comment.created_at),
		});

		// Body
		card.createDiv({ cls: "annotated-popup-content", text: comment.content });

		// Replies
		if (comment.replies.length > 0) {
			const repliesContainer = card.createDiv({ cls: "annotated-popup-replies" });
			for (const reply of comment.replies) {
				const replyEl = repliesContainer.createDiv({ cls: "annotated-popup-comment" });
				const replyHeader = replyEl.createDiv({ cls: "annotated-popup-header" });
				replyHeader.createSpan({ cls: "annotated-popup-author", text: reply.author });
				replyHeader.createSpan({
					cls: "annotated-popup-timestamp",
					text: this.formatTimestamp(reply.created_at),
				});
				replyEl.createDiv({ cls: "annotated-popup-content", text: reply.content });
			}
		}

		// Actions
		const actions = card.createDiv({ cls: "annotated-popup-actions" });

		const replyBtn = actions.createEl("button", {
			cls: "annotated-popup-btn",
			text: "Reply",
		});
		replyBtn.addEventListener("click", () => this.callbacks.onReply(comment));

		if (comment.status === "open") {
			const resolveBtn = actions.createEl("button", {
				cls: "annotated-popup-btn annotated-popup-btn--resolve",
				text: "Resolve",
			});
			resolveBtn.addEventListener("click", () => this.callbacks.onResolve(comment));
		}
	}

	private formatTimestamp(iso: string): string {
		const m = moment(iso);
		if (m.isSame(moment(), "day")) {
			return m.format("h:mm A");
		}
		return m.format("MMM D, h:mm A");
	}
}
