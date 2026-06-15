import { EditorView } from "@codemirror/view";
import { Comment, PluginSettings } from "../types";
import { formatTimestamp, getCommentActivityTime } from "../utils/FormatUtils";
import { strings } from "../i18n/strings";

export interface CommentPopupCallbacks {
	onReply: (comment: Comment) => void;
	onResolve: (comment: Comment) => void;
	onOpenThread: (comment: Comment) => void;
}

export class CommentPopup {
	private settings: PluginSettings;
	private callbacks: CommentPopupCallbacks;
	private containerEl: HTMLElement | null = null;
	private currentLine: number | null = null;
	private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
	private scrollHandler: (() => void) | null = null;
	private scrollDOM: HTMLElement | null = null;
	private sortMode: "oldest" | "newest" = "oldest";

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
		this.sortMode = "oldest";

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

			// Sort dropdown when multiple comments
			if (comments.length > 1) {
				const sortRow = container.createDiv({ cls: "annotated-popup-sort" });
				const sortSelect = sortRow.createEl("select");
				for (const opt of [
					{ value: "oldest", label: strings.sort.oldestFirst },
					{ value: "newest", label: strings.sort.newestFirst },
				]) {
					const el = sortSelect.createEl("option", { text: opt.label, value: opt.value });
					if (opt.value === this.sortMode) el.selected = true;
				}
				sortSelect.addEventListener("change", () => {
					this.sortMode = sortSelect.value as "oldest" | "newest";
					const sorted = this.sortComments([...comments]);
					const nextVisible = showAll ? sorted : sorted.slice(0, max);
					render(nextVisible);
				});
			}

			for (const comment of toShow) {
				this.renderCommentCard(container, comment);
			}

			if (!showAll && toShow.length < comments.length) {
				const remaining = comments.length - toShow.length;
				const showMoreEl = container.createDiv({ cls: "annotated-popup-show-more" });
				showMoreEl.textContent = strings.popup.showMore(remaining);
				showMoreEl.addEventListener("click", () => {
					const sorted = this.sortComments([...comments]);
					render(sorted);
				});
			}

			// Close button in top-right
			const closeBtn = container.createDiv({ cls: "annotated-popup-btn--close" });
			closeBtn.textContent = "\u00D7";
			closeBtn.addEventListener("click", () => this.close());
		};

		render(visibleComments);
	}

	private sortComments(comments: Comment[]): Comment[] {
		if (this.sortMode === "newest") {
			comments.sort((a, b) => getCommentActivityTime(b) - getCommentActivityTime(a));
		} else {
			comments.sort((a, b) => getCommentActivityTime(a) - getCommentActivityTime(b));
		}
		return comments;
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
				text: strings.popup.staleNotice,
			});
		}

		// Header
		const header = card.createDiv({ cls: "annotated-popup-header" });
		header.createSpan({ cls: "annotated-popup-author", text: comment.author });
		header.createSpan({
			cls: "annotated-popup-timestamp",
			text: formatTimestamp(comment.created_at),
		});

		// Body
		card.createDiv({ cls: "annotated-popup-content", text: comment.content });

		// Replies (collapsible)
		if (comment.replies.length > 0) {
			const replyCount = comment.replies.length;
			const toggleRow = card.createDiv({ cls: "annotated-popup-replies-toggle" });
			const arrow = toggleRow.createSpan({ cls: "annotated-popup-replies-toggle-arrow", text: "\u25B6" });
			toggleRow.createSpan({
				text: ` ${strings.replies.count(replyCount)} \u2014 `,
			});
			const viewLink = toggleRow.createSpan({ cls: "annotated-popup-replies-toggle-link", text: strings.actions.view });
			toggleRow.createSpan({ text: "\u00A0\u2022\u00A0" });
			const openThreadLink = toggleRow.createSpan({ cls: "annotated-popup-open-thread", text: strings.actions.openThread });
			openThreadLink.addEventListener("click", (e) => {
				e.stopPropagation();
				this.callbacks.onOpenThread(comment);
				this.close();
			});

			const repliesContainer = card.createDiv({ cls: "annotated-popup-replies annotated-popup-replies--hidden" });
			for (const reply of comment.replies) {
				const replyEl = repliesContainer.createDiv({ cls: "annotated-popup-comment" });
				const replyHeader = replyEl.createDiv({ cls: "annotated-popup-header" });
				replyHeader.createSpan({ cls: "annotated-popup-author", text: reply.author });
				replyHeader.createSpan({
					cls: "annotated-popup-timestamp",
					text: formatTimestamp(reply.created_at),
				});
				replyEl.createDiv({ cls: "annotated-popup-content", text: reply.content });
			}

			const toggleFn = () => {
				const isHidden = repliesContainer.hasClass("annotated-popup-replies--hidden");
				if (isHidden) {
					repliesContainer.removeClass("annotated-popup-replies--hidden");
					arrow.setText("\u25BC");
					viewLink.setText(strings.actions.hide);
				} else {
					repliesContainer.addClass("annotated-popup-replies--hidden");
					arrow.setText("\u25B6");
					viewLink.setText(strings.actions.view);
				}
			};

			arrow.addEventListener("click", toggleFn);
			viewLink.addEventListener("click", toggleFn);
		}

		// Actions
		const actions = card.createDiv({ cls: "annotated-popup-actions" });

		const replyBtn = actions.createEl("button", {
			cls: "annotated-popup-btn",
			text: strings.actions.reply,
		});
		replyBtn.addEventListener("click", () => this.callbacks.onReply(comment));

		if (comment.status === "open") {
			const resolveBtn = actions.createEl("button", {
				cls: "annotated-popup-btn annotated-popup-btn--resolve",
				text: strings.actions.resolve,
			});
			resolveBtn.addEventListener("click", () => this.callbacks.onResolve(comment));
		}
	}
}
