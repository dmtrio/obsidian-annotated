import { ItemView, MarkdownView, WorkspaceLeaf } from "obsidian";
import { Comment, CommentFile } from "../types";
import type AnnotatedPlugin from "../main";
import { formatTimestamp, formatLocationText, getCommentActivityTime, truncateContent } from "../utils/FormatUtils";
import { strings } from "../i18n/strings";

export const VIEW_TYPE_COMMENT_SIDEBAR = "annotated-sidebar";

type SortMode = "line" | "oldest" | "newest";

export class CommentSidebarView extends ItemView {
  private plugin: AnnotatedPlugin;
  private currentFilePath: string | null = null;
  private sortMode: SortMode = "line";
  private authorFilter: string | null = null;
  private showOpen = true;
  private showResolved = true;
  private rendering = false;
  private viewMode: "list" | "thread" = "list";
  private threadCommentId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AnnotatedPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.sortMode = plugin.settings.defaultSortMode;
  }

  getViewType(): string {
    return VIEW_TYPE_COMMENT_SIDEBAR;
  }

  getDisplayText(): string {
    return "Comments";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("annotated-sidebar-container");

    const mdView = this.findMarkdownView();
    if (mdView?.file) {
      this.currentFilePath = mdView.file.path;
    }

    this.rendering = true;
    try {
      await this.renderAll(container);
    } finally {
      this.rendering = false;
    }
  }

  async onClose(): Promise<void> {
    // cleanup
  }

  openThread(commentId: string): void {
    this.viewMode = "thread";
    this.threadCommentId = commentId;
    this.refresh();
  }

  async refresh(filePath?: string): Promise<void> {
    if (this.rendering) return;
    if (filePath !== undefined && filePath !== this.currentFilePath) {
      this.currentFilePath = filePath;
      this.sortMode = this.plugin.settings.defaultSortMode;
      this.authorFilter = null;
      this.showOpen = true;
      this.showResolved = true;
      this.viewMode = "list";
      this.threadCommentId = null;
    }
    this.rendering = true;
    try {
      const container = this.containerEl.children[1] as HTMLElement;
      container.empty();
      await this.renderAll(container);
    } finally {
      this.rendering = false;
    }
  }

  private findMarkdownView(): MarkdownView | null {
    let result: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (result) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        if (this.currentFilePath && view.file.path === this.currentFilePath) {
          result = view;
        } else if (!result) {
          result = view;
        }
      }
    });
    return result;
  }

  private findMarkdownViewForFile(filePath: string): MarkdownView | null {
    let result: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (result) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === filePath) {
        result = view;
      }
    });
    return result;
  }

  private async renderAll(container: HTMLElement): Promise<void> {
    if (this.viewMode === "thread" && this.threadCommentId) {
      await this.renderThreadView(container);
      return;
    }

    // Header
    const header = container.createDiv({ cls: "annotated-sidebar-header" });
    if (this.currentFilePath) {
      const parts = this.currentFilePath.split("/");
      header.setText(parts[parts.length - 1]);
    } else {
      header.setText(strings.sidebar.noActiveNote);
    }

    if (!this.currentFilePath) {
      container.createDiv({
        cls: "annotated-sidebar-empty",
        text: strings.sidebar.openNoteToSee,
      });
      return;
    }

    const commentFile = await this.plugin.commentManager.getComments(
      this.currentFilePath,
    );
    const allAuthors = commentFile?.metadata?.authors ?? [];

    // Dropdowns row: Author first, then Sort
    const filters = container.createDiv({ cls: "annotated-sidebar-filters" });

    // Author filter
    const authorSelect = filters.createEl("select", {
      cls: "annotated-sidebar-filter",
    });
    const allOpt = authorSelect.createEl("option", {
      text: strings.sidebar.allAuthors,
      value: "",
    });
    if (!this.authorFilter) allOpt.selected = true;
    for (const author of allAuthors) {
      const el = authorSelect.createEl("option", {
        text: author,
        value: author,
      });
      if (author === this.authorFilter) el.selected = true;
    }
    authorSelect.addEventListener("change", () => {
      this.authorFilter = authorSelect.value || null;
      this.refresh();
    });

    // Sort dropdown
    const sortSelect = filters.createEl("select", {
      cls: "annotated-sidebar-filter",
    });
    for (const opt of [
      { value: "line", label: strings.sort.line },
      { value: "oldest", label: strings.sort.oldest },
      { value: "newest", label: strings.sort.newest },
    ]) {
      const el = sortSelect.createEl("option", {
        text: opt.label,
        value: opt.value,
      });
      if (opt.value === this.sortMode) el.selected = true;
    }
    sortSelect.addEventListener("change", () => {
      this.sortMode = sortSelect.value as SortMode;
      this.refresh();
    });

    // Render comment list
    await this.renderComments(container, commentFile);
  }

  private async renderThreadView(container: HTMLElement): Promise<void> {
    if (!this.currentFilePath || !this.threadCommentId) {
      this.viewMode = "list";
      await this.renderAll(container);
      return;
    }

    const commentFile = await this.plugin.commentManager.getComments(
      this.currentFilePath,
    );
    const comment = commentFile?.comments.find(
      (c) => c.id === this.threadCommentId,
    );

    if (!comment) {
      this.viewMode = "list";
      this.threadCommentId = null;
      await this.renderAll(container);
      return;
    }

    // Header with back button
    const header = container.createDiv({ cls: "annotated-thread-header" });
    const backBtn = header.createEl("button", {
      cls: "annotated-thread-back",
      text: strings.sidebar.backToComments,
    });
    backBtn.addEventListener("click", () => {
      this.viewMode = "list";
      this.threadCommentId = null;
      this.refresh();
    });

    const body = container.createDiv({ cls: "annotated-thread-body" });

    // Location
    body.createDiv({ cls: "annotated-sidebar-card-location", text: formatLocationText(comment.location) });

    // Stale notice
    if (comment.is_stale) {
      body.createDiv({
        cls: "annotated-popup-stale-notice",
        text: strings.sidebar.staleNotice,
      });
    }

    // Author + timestamp
    const headerEl = body.createDiv({ cls: "annotated-popup-header" });
    headerEl.createSpan({
      cls: "annotated-popup-author",
      text: comment.author,
    });
    headerEl.createSpan({
      cls: "annotated-popup-timestamp",
      text: formatTimestamp(comment.created_at),
    });

    // Full content (not truncated)
    body.createDiv({ cls: "annotated-thread-content", text: comment.content });

    // Replies (all expanded)
    if (comment.replies.length > 0) {
      const repliesContainer = body.createDiv({
        cls: "annotated-thread-replies",
      });
      for (const reply of comment.replies) {
        const replyEl = repliesContainer.createDiv({
          cls: "annotated-thread-reply",
        });
        const replyHeader = replyEl.createDiv({
          cls: "annotated-popup-header",
        });
        replyHeader.createSpan({
          cls: "annotated-popup-author",
          text: reply.author,
        });
        replyHeader.createSpan({
          cls: "annotated-popup-timestamp",
          text: formatTimestamp(reply.created_at),
        });
        replyEl.createDiv({
          cls: "annotated-thread-content",
          text: reply.content,
        });
      }
    }

    // Actions
    const actions = body.createDiv({ cls: "annotated-thread-actions" });
    const filePath = this.currentFilePath;

    const replyBtn = actions.createEl("button", {
      cls: "annotated-popup-btn",
      text: strings.actions.reply,
    });
    replyBtn.addEventListener("click", () => {
      this.plugin.handleReply(comment, filePath ?? undefined);
    });

    if (comment.status === "open") {
      const resolveBtn = actions.createEl("button", {
        cls: "annotated-popup-btn annotated-popup-btn--resolve",
        text: strings.actions.resolve,
      });
      resolveBtn.addEventListener("click", () => {
        this.plugin.handleResolve(comment, filePath ?? undefined);
      });
    }
  }

  private async renderComments(
    container: HTMLElement,
    commentFile: CommentFile | null,
  ): Promise<void> {
    if (!commentFile || commentFile.comments.length === 0) {
      container.createDiv({
        cls: "annotated-sidebar-empty",
        text: strings.sidebar.noComments,
      });
      return;
    }

    // Filter by author
    const filtered = commentFile.comments.filter((c) => {
      if (this.authorFilter && c.author !== this.authorFilter) return false;
      return true;
    });

    if (filtered.length === 0) {
      container.createDiv({
        cls: "annotated-sidebar-empty",
        text: strings.sidebar.noMatching,
      });
      return;
    }

    // Sort
    const sorted = [...filtered];
    switch (this.sortMode) {
      case "line":
        sorted.sort((a, b) => a.location.start_line - b.location.start_line);
        break;
      case "oldest":
        sorted.sort(
          (a, b) => getCommentActivityTime(a) - getCommentActivityTime(b),
        );
        break;
      case "newest":
        sorted.sort(
          (a, b) => getCommentActivityTime(b) - getCommentActivityTime(a),
        );
        break;
    }

    const open = sorted.filter((c) => c.status === "open");
    const resolved = sorted.filter((c) => c.status === "resolved");

    // Always render both accordions (even if empty, to show the header with count 0)
    this.renderAccordion(container, strings.sidebar.open, open, this.showOpen, (val) => {
      this.showOpen = val;
    });
    this.renderAccordion(
      container,
      strings.sidebar.resolved,
      resolved,
      this.showResolved,
      (val) => {
        this.showResolved = val;
      },
    );
  }

  private renderAccordion(
    container: HTMLElement,
    title: string,
    comments: Comment[],
    expanded: boolean,
    onToggle: (val: boolean) => void,
  ): void {
    const group = container.createDiv({ cls: "annotated-sidebar-group" });

    const header = group.createDiv({
      cls: "annotated-sidebar-accordion-header",
    });
    const caret = header.createSpan({
      cls: "annotated-sidebar-accordion-caret",
      text: expanded ? "\u25BC" : "\u25B6",
    });
    header.createSpan({
      cls: "annotated-sidebar-accordion-title",
      text: `${title}`,
    });
    header.createSpan({
      cls: "annotated-sidebar-accordion-count",
      text: `${comments.length}`,
    });

    const body = group.createDiv({ cls: "annotated-sidebar-accordion-body" });
    if (!expanded) body.addClass("annotated-sidebar-accordion-body--collapsed");

    if (comments.length === 0) {
      body.createDiv({
        cls: "annotated-sidebar-empty",
        text: strings.sidebar.noSection(title),
      });
    } else {
      for (const comment of comments) {
        this.renderCard(body, comment);
      }
    }

    header.addEventListener("click", () => {
      const isCollapsed = body.hasClass(
        "annotated-sidebar-accordion-body--collapsed",
      );
      if (isCollapsed) {
        body.removeClass("annotated-sidebar-accordion-body--collapsed");
        caret.setText("\u25BC");
        onToggle(true);
      } else {
        body.addClass("annotated-sidebar-accordion-body--collapsed");
        caret.setText("\u25B6");
        onToggle(false);
      }
    });
  }

  private renderCard(parent: HTMLElement, comment: Comment): void {
    const card = parent.createDiv({ cls: "annotated-sidebar-card" });
    if (comment.is_stale) card.addClass("annotated-sidebar-card--stale");

    // Click to scroll (on the card itself, not buttons/replies)
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (
        target.closest(".annotated-popup-btn") ||
        target.closest(".annotated-sidebar-replies-toggle") ||
        target.closest(".annotated-sidebar-replies")
      )
        return;
      this.scrollToComment(comment);
    });

    // Location
    card.createDiv({ cls: "annotated-sidebar-card-location", text: formatLocationText(comment.location) });

    // Header: author + timestamp
    const headerEl = card.createDiv({ cls: "annotated-popup-header" });
    headerEl.createSpan({
      cls: "annotated-popup-author",
      text: comment.author,
    });
    headerEl.createSpan({
      cls: "annotated-popup-timestamp",
      text: formatTimestamp(comment.created_at),
    });

    if (comment.is_stale) {
      card.createDiv({
        cls: "annotated-popup-stale-notice",
        text: strings.sidebar.staleNotice,
      });
    }

    // Content preview (truncated)
    card.createDiv({ cls: "annotated-sidebar-card-content", text: truncateContent(comment.content) });

    // Collapsible reply chain with open thread link
    if (comment.replies.length > 0) {
      const replyCount = comment.replies.length;
      const toggleEl = card.createDiv({
        cls: "annotated-sidebar-replies-toggle",
      });
      const arrow = toggleEl.createSpan({
        cls: "annotated-sidebar-replies-arrow",
        text: "\u25B6",
      });
      toggleEl.createSpan({
        text: ` ${strings.replies.count(replyCount)} \u2014 `,
      });
      const viewLink = toggleEl.createSpan({
        cls: "annotated-sidebar-replies-link",
        text: strings.actions.view,
      });
      toggleEl.createSpan({ text: "\u00A0\u2022\u00A0" });
      const openThreadLink = toggleEl.createSpan({
        cls: "annotated-popup-open-thread",
        text: strings.actions.openThread,
      });
      openThreadLink.addEventListener("click", (e) => {
        e.stopPropagation();
        this.viewMode = "thread";
        this.threadCommentId = comment.id;
        this.refresh();
      });

      const repliesContainer = card.createDiv({
        cls: "annotated-sidebar-replies annotated-sidebar-replies--hidden",
      });

      for (const reply of comment.replies) {
        const replyEl = repliesContainer.createDiv({
          cls: "annotated-sidebar-reply",
        });
        const replyHeader = replyEl.createDiv({
          cls: "annotated-popup-header",
        });
        replyHeader.createSpan({
          cls: "annotated-popup-author",
          text: reply.author,
        });
        replyHeader.createSpan({
          cls: "annotated-popup-timestamp",
          text: formatTimestamp(reply.created_at),
        });
        replyEl.createDiv({
          cls: "annotated-sidebar-card-content",
          text: truncateContent(reply.content),
        });
      }

      const toggle = () => {
        const isHidden = repliesContainer.hasClass(
          "annotated-sidebar-replies--hidden",
        );
        if (isHidden) {
          repliesContainer.removeClass("annotated-sidebar-replies--hidden");
          arrow.setText("\u25BC");
          viewLink.setText(strings.actions.hide);
        } else {
          repliesContainer.addClass("annotated-sidebar-replies--hidden");
          arrow.setText("\u25B6");
          viewLink.setText(strings.actions.view);
        }
      };

      arrow.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle();
      });
      viewLink.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle();
      });
    }

    // Actions
    const actions = card.createDiv({ cls: "annotated-popup-actions" });
    const filePath = this.currentFilePath;

    const replyBtn = actions.createEl("button", {
      cls: "annotated-popup-btn",
      text: strings.actions.reply,
    });
    replyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.handleReply(comment, filePath ?? undefined);
    });

    if (comment.status === "open") {
      const resolveBtn = actions.createEl("button", {
        cls: "annotated-popup-btn annotated-popup-btn--resolve",
        text: strings.actions.resolve,
      });
      resolveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.handleResolve(comment, filePath ?? undefined);
      });
    }
  }

  private scrollToComment(comment: Comment): void {
    if (!this.currentFilePath) return;

    const mdView = this.findMarkdownViewForFile(this.currentFilePath);
    if (!mdView?.editor) return;

    const editor = mdView.editor;
    const line = comment.location.start_line - 1;
    editor.setCursor({ line, ch: 0 });
    editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
  }
}
