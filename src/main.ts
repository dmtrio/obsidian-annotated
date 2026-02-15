import {
  App,
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  Comment,
  CommentFile,
  CommentReply,
  DEFAULT_SETTINGS,
  PluginSettings,
  RangeLocation,
} from "./types";
import { CommentManager } from "./managers/CommentManager";
import { CommentModal, CommentModalOptions } from "./ui/CommentModal";
import { CommentPopup } from "./ui/CommentPopup";
import {
  CommentSidebarView,
  VIEW_TYPE_COMMENT_SIDEBAR,
} from "./ui/CommentSidebar";
import {
  createCommentGutterExtension,
  setCommentLines,
  setGutterConfig,
  CommentLineMap,
} from "./editor/CommentGutterExtension";
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
  private _selfSaveCount = 0;

  async onload() {
    await this.loadSettings();
    this.commentManager = new CommentManager(this.app.vault);
    this.addSettingTab(new AnnotatedSettingTab(this.app, this));

    // Create popup before gutter extension
    this.commentPopup = new CommentPopup(this.settings, {
      onReply: (comment) => this.handleReply(comment),
      onResolve: (comment) => this.handleResolve(comment),
      onOpenThread: (comment) => this.openThreadInSidebar(comment),
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
        saveTrackedPositions: (filePath, updates) =>
          this.saveTrackedPositions(filePath, updates),
        getFilePath: () => {
          const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
          return mdView?.file?.path ?? null;
        },
      }),
      commentPositionTrackerPlugin,
    ]);

    // Register sidebar view
    this.registerView(VIEW_TYPE_COMMENT_SIDEBAR, (leaf) => {
      return new CommentSidebarView(leaf, this);
    });

    this.addCommand({
      id: "toggle-comment-sidebar",
      name: "Toggle Comment Sidebar",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "/" }],
      callback: () => this.toggleSidebar(),
    });

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
        this.addCommentAtCursor(editor, file);
      },
    });

    this.addCommand({
      id: "export-comments",
      name: "Export Comments to Clipboard",
      checkCallback: (checking: boolean) => {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView?.file) return false;
        if (checking) return true;
        this.exportComments(mdView.file.path);
      },
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path.endsWith(".comments")) {
          if (this._selfSaveCount > 0) return;
          const notePath = file.path.slice(0, -".comments".length);
          this.commentManager.invalidateCache(notePath);
          this.refreshGutterForFile(notePath);
          this.refreshSidebar();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file.path.endsWith(".comments")) {
          const notePath = file.path.slice(0, -".comments".length);
          this.commentManager.invalidateCache(notePath);
          this.refreshGutterForFile(notePath);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on(
        "rename",
        async (file: TAbstractFile, oldPath: string) => {
          // If the .comments file itself was renamed directly, just invalidate
          if (oldPath.endsWith(".comments")) {
            const oldNotePath = oldPath.slice(0, -".comments".length);
            this.commentManager.invalidateCache(oldNotePath);
            return;
          }

          if (!(file instanceof TFile) || !file.path.endsWith(".md")) return;

          const oldCommentsPath = oldPath + ".comments";
          const newCommentsPath = file.path + ".comments";

          if (!(await this.app.vault.adapter.exists(oldCommentsPath))) return;

          this._selfSaveCount++;
          try {
            await this.app.vault.adapter.rename(
              oldCommentsPath,
              newCommentsPath,
            );

            const raw = await this.app.vault.adapter.read(newCommentsPath);
            const commentFile = JSON.parse(raw) as CommentFile;
            commentFile.note_path = file.path;
            await this.app.vault.adapter.write(
              newCommentsPath,
              JSON.stringify(commentFile, null, 2),
            );

            this.commentManager.invalidateCache(oldPath);
            this.commentManager.invalidateCache(file.path);

            await this.refreshGutterForFile(file.path);
            this.refreshSidebar(file.path);
          } finally {
            setTimeout(() => {
              this._selfSaveCount--;
            }, 500);
          }
        },
      ),
    );

    // Editor context menu — "Add Comment"
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView?.file) return;
        const file = mdView.file;
        menu.addItem((item) => {
          item
            .setTitle("Add Comment")
            .setIcon("message-square")
            .onClick(() => this.addCommentAtCursor(editor, file));
        });
      }),
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
          this.refreshSidebar(filePath);
        }
      }),
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
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_COMMENT_SIDEBAR);
    console.log("Annotated plugin unloaded");
  }

  private async toggleSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_COMMENT_SIDEBAR,
    );
    if (existing.length > 0) {
      existing.forEach((leaf) => leaf.detach());
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_COMMENT_SIDEBAR, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async openThreadInSidebar(comment: Comment): Promise<void> {
    // Ensure sidebar is open
    let leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENT_SIDEBAR);
    if (leaves.length === 0) {
      const leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE_COMMENT_SIDEBAR, active: true });
      this.app.workspace.revealLeaf(leaf);
      leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENT_SIDEBAR);
    }
    if (leaves.length === 0) return;
    const sidebarView = leaves[0].view as CommentSidebarView;
    sidebarView.openThread(comment.id);
  }

  private refreshSidebar(filePath?: string): void {
    const leaves = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_COMMENT_SIDEBAR,
    );
    if (leaves.length === 0) return;
    const view = leaves[0].view as CommentSidebarView;
    view.refresh(filePath);
  }

  async refreshGutterForFile(filePath: string): Promise<void> {
    const commentFile = await this.commentManager.getComments(filePath);
    const lineMap: CommentLineMap = new Map();

    if (commentFile && this.settings.showGutterIndicators) {
      for (const c of commentFile.comments) {
        // Respect hide settings
        if (this.settings.hideResolvedByDefault && c.status === "resolved")
          continue;

        const line = c.location.start_line;
        const isResolved = c.status === "resolved";
        const existing = lineMap.get(line);
        if (existing) {
          existing.count += 1;
          existing.hasStale = existing.hasStale || c.is_stale === true;
          existing.allResolved = existing.allResolved && isResolved;
        } else {
          lineMap.set(line, { count: 1, hasStale: c.is_stale === true, allResolved: isResolved });
        }
      }
    }

    const rawEmoji = this.settings.customGutterEmoji || "\u{1F4AC}";
    const config = {
      style: this.settings.commentIndicatorStyle,
      emoji: [...rawEmoji][0] ?? "\u{1F4AC}",
    };

    // Dispatch to all editor views showing this file
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === filePath) {
        const cmEditor = (view.editor as any).cm as EditorView | undefined;
        if (cmEditor) {
          cmEditor.dispatch({
            effects: [setCommentLines.of(lineMap), setGutterConfig.of(config)],
          });
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

    const noteContent = await this.app.vault.adapter
      .read(filePath)
      .catch(() => null);
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
      if (
        storedLine >= 0 &&
        storedLine < docLines.length &&
        docLines[storedLine].startsWith(snippet)
      ) {
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
      this._selfSaveCount++;
      await this.commentManager.saveComments(commentFile);
      setTimeout(() => {
        this._selfSaveCount--;
      }, 500);
    }
  }

  private async saveTrackedPositions(
    filePath: string,
    lineUpdates: Map<string, number>,
  ): Promise<void> {
    const commentFile = await this.commentManager.getComments(filePath);
    if (!commentFile) return;

    const noteContent = await this.app.vault.adapter
      .read(filePath)
      .catch(() => null);
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
      this._selfSaveCount++;
      await this.commentManager.saveComments(commentFile);
      setTimeout(() => {
        this._selfSaveCount--;
      }, 500);
    }
  }

  private initTrackerPositions(
    filePath: string,
    commentFile: CommentFile,
  ): void {
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
          cmEditor.dispatch({
            effects: setCommentTrackerPositions.of(positions),
          });
        }
      }
    });
  }

  private getMarkdownViewForFile(filePath: string): MarkdownView | null {
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

  private async openCommentPopup(
    view: EditorView,
    line: number,
  ): Promise<void> {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView?.file) return;

    const filePath = mdView.file.path;
    const commentFile = await this.commentManager.getComments(filePath);
    if (!commentFile) return;

    const comments = commentFile.comments.filter((c) => {
      if (this.settings.hideResolvedByDefault && c.status === "resolved")
        return false;
      return c.location.start_line === line;
    });

    if (comments.length === 0) return;
    const max = this.settings.maxCommentsInPopup;
    this.commentPopup.open(view, line, comments.slice(0, max));
  }

  private openCommentModal(
    opts: CommentModalOptions,
    extra?: {
      draftContent?: string;
      onSubmitFactory?: (loc: RangeLocation) => CommentModalOptions["onSubmit"];
    },
  ): void {
    const finalOpts: CommentModalOptions = {
      ...opts,
      draftContent: extra?.draftContent,
    };

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
            this.openCommentModal(newOpts, {
              draftContent: draft,
              onSubmitFactory: extra?.onSubmitFactory,
            });
          }, 300);
        };

        editorDom.addEventListener("mouseup", onMouseUp);
      };
    }

    const modal = new CommentModal(this.app, finalOpts);
    modal.open();
  }

  private addCommentAtCursor(editor: Editor, file: TFile): void {
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");

    const location: RangeLocation = {
      type: "range",
      start_line: from.line + 1,
      start_char: from.ch,
      end_line: to.line + 1,
      end_char: to.ch,
    };

    const makeOnSubmit =
      (loc: RangeLocation) => async (content: string, author: string) => {
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
          last_activity_at: now,
          content_snippet: captureSnippet(editor.getLine(loc.start_line - 1)),
        };
        await this.commentManager.addComment(file.path, comment);
        await this.refreshGutterForFile(file.path);
        this.refreshSidebar();
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
  }

  private async exportComments(filePath: string): Promise<void> {
    const commentFile = await this.commentManager.getComments(filePath);
    if (!commentFile || commentFile.comments.length === 0) {
      new Notice("No comments to export");
      return;
    }

    const filename = filePath.split("/").pop() ?? filePath;
    const open = commentFile.comments.filter((c) => c.status === "open");
    const resolved = commentFile.comments.filter(
      (c) => c.status === "resolved",
    );

    const formatDate = (iso: string) => iso.slice(0, 10);

    const formatComment = (c: Comment): string => {
      const loc =
        c.location.start_line === c.location.end_line
          ? `Line ${c.location.start_line}`
          : `Lines ${c.location.start_line}–${c.location.end_line}`;
      let text = `### ${loc} — ${c.author} (${formatDate(c.created_at)})\n${c.content}`;
      for (const r of c.replies) {
        text += `\n  > **${r.author}** (${formatDate(r.created_at)}): ${r.content}`;
      }
      return text;
    };

    let md = `# Comments: ${filename}\n\n`;
    md += `## Open (${open.length})\n\n`;
    if (open.length > 0) {
      md += open.map(formatComment).join("\n\n") + "\n\n";
    }
    md += `## Resolved (${resolved.length})\n\n`;
    if (resolved.length > 0) {
      md += resolved.map(formatComment).join("\n\n") + "\n\n";
    }

    try {
      await navigator.clipboard.writeText(md.trimEnd());
      const total = commentFile.comments.length;
      new Notice(
        `Exported ${total} comment${total === 1 ? "" : "s"} to clipboard`,
      );
    } catch {
      new Notice(
        "Failed to copy to clipboard — your browser may have blocked access",
      );
    }
  }

  handleReply(comment: Comment, targetFilePath?: string): void {
    const mdView = targetFilePath
      ? this.getMarkdownViewForFile(targetFilePath)
      : this.app.workspace.getActiveViewOfType(MarkdownView);
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
        this.refreshSidebar();

        // Re-open popup to show new reply
        if (cmEditor) {
          this.openCommentPopup(cmEditor, comment.location.start_line);
        }
      },
    });
  }

  handleResolve(comment: Comment, targetFilePath?: string): void {
    const mdView = targetFilePath
      ? this.getMarkdownViewForFile(targetFilePath)
      : this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView?.file) return;

    const filePath = mdView.file.path;
    const cmEditor = (mdView.editor as any).cm as EditorView | undefined;

    this.commentManager
      .resolveComment(filePath, comment.id, this.settings.defaultAuthor)
      .then(async () => {
        await this.refreshGutterForFile(filePath);
        this.refreshSidebar();
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

    // ── Author ──
    containerEl.createEl("h3", { text: "Author" });

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
          }),
      );

    // ── Display ──
    containerEl.createEl("h3", { text: "Display" });

    new Setting(containerEl)
      .setName("Show gutter indicators")
      .setDesc("Show comment markers in the editor gutter")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showGutterIndicators)
          .onChange(async (value) => {
            this.plugin.settings.showGutterIndicators = value;
            await this.plugin.saveSettings();
            this.refreshActiveGutter();
          }),
      );

    new Setting(containerEl)
      .setName("Comment indicator style")
      .setDesc("How comments are indicated in the gutter")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("icon", "Icon")
          .addOption("badge", "Badge")
          .addOption("highlight", "Highlight")
          .setValue(this.plugin.settings.commentIndicatorStyle)
          .onChange(async (value) => {
            this.plugin.settings.commentIndicatorStyle = value as
              | "icon"
              | "badge"
              | "highlight";
            await this.plugin.saveSettings();
            this.refreshActiveGutter();
          }),
      );

    new Setting(containerEl)
      .setName("Gutter emoji")
      .setDesc("Emoji shown in the gutter when using icon style")
      .addText((text) => {
        text
          .setPlaceholder("Enter emoji")
          .setValue(
            this.plugin.settings.customGutterEmoji === "\u{1F4AC}"
              ? ""
              : this.plugin.settings.customGutterEmoji,
          )
          .onChange(async (value) => {
            const chars = [...value];
            if (chars.length > 1) {
              // Truncate to first character
              text.inputEl.value = chars[0];
            }
            this.plugin.settings.customGutterEmoji =
              chars.length > 0 ? chars[0] : "\u{1F4AC}";
            await this.plugin.saveSettings();
            this.refreshActiveGutter();
          });
      });

    new Setting(containerEl)
      .setName("Max comments in popup")
      .setDesc("Maximum number of comments shown in the gutter popup")
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.maxCommentsInPopup)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxCommentsInPopup = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default sort order")
      .setDesc("How comments are sorted in the sidebar by default")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("line", "Line number")
          .addOption("oldest", "Oldest")
          .addOption("newest", "Newest")
          .setValue(this.plugin.settings.defaultSortMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultSortMode = value as
              | "line"
              | "oldest"
              | "newest";
            await this.plugin.saveSettings();
          }),
      );

    // ── Filtering ──
    containerEl.createEl("h3", { text: "Filtering" });

    new Setting(containerEl)
      .setName("Hide resolved by default")
      .setDesc("Hide resolved comments in the gutter and sidebar")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideResolvedByDefault)
          .onChange(async (value) => {
            this.plugin.settings.hideResolvedByDefault = value;
            await this.plugin.saveSettings();
            this.refreshActiveGutter();
          }),
      );
  }

  private refreshActiveGutter(): void {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView?.file) {
      this.plugin.refreshGutterForFile(mdView.file.path);
      // Also refresh sidebar
      const leaves = this.app.workspace.getLeavesOfType(
        VIEW_TYPE_COMMENT_SIDEBAR,
      );
      if (leaves.length > 0) {
        (leaves[0].view as CommentSidebarView).refresh(mdView.file.path);
      }
    }
  }
}
