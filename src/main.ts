import {
  App,
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
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
import { formatLocationText } from "./utils/FormatUtils";
import { strings } from "./i18n/strings";
import {
  commentTrackerField,
  commentPositionTrackerPlugin,
  setCommentTrackerPositions,
  trackerCallbacks,
} from "./editor/CommentPositionTracker";
import { generateIdentityId, type Identity } from "@annotated/comments-core";
import {
  buildAuthProvider,
  buildNoteAccess,
  DeviceLocalStore,
  loadEnvKeys,
  resolveBindConfig,
} from "./mcp/PluginMcpHost";

export default class AnnotatedPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  commentManager: CommentManager;
  private commentPopup: CommentPopup;
  private _selfSaveCount = 0;
  private mcpServer: { stop(): Promise<void>; address: string } | null = null;
  deviceStore: DeviceLocalStore;

  async onload() {
    await this.loadSettings();
    this.commentManager = new CommentManager(this.app.vault, this.manifest.version);
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
      name: strings.commands.toggleSidebar,
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "/" }],
      callback: () => this.toggleSidebar(),
    });

    this.addCommand({
      id: "add-comment",
      name: strings.commands.addComment,
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const file = view.file;
        if (!file) {
          new Notice(strings.notices.noActiveFile);
          return;
        }
        this.addCommentAtCursor(editor, file);
      },
    });

    this.addCommand({
      id: "export-comments",
      name: strings.commands.exportComments,
      checkCallback: (checking: boolean) => {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView?.file) return false;
        if (checking) return true;
        this.exportComments(mdView.file.path);
      },
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path.endsWith(".comments.json")) {
          if (this._selfSaveCount > 0) return;
          const notePath = file.path.slice(0, -".comments.json".length);
          this.commentManager.invalidateCache(notePath);
          this.refreshGutterForFile(notePath);
          this.refreshSidebar();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file.path.endsWith(".comments.json")) {
          const notePath = file.path.slice(0, -".comments.json".length);
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
          if (oldPath.endsWith(".comments.json")) {
            const oldNotePath = oldPath.slice(0, -".comments.json".length);
            this.commentManager.invalidateCache(oldNotePath);
            return;
          }

          if (!(file instanceof TFile) || !file.path.endsWith(".md")) return;

          const oldCommentsPath = oldPath + ".comments.json";
          const newCommentsPath = file.path + ".comments.json";

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
            .setTitle(strings.commands.addComment)
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

    this.deviceStore = new DeviceLocalStore(this.app);
    if (Platform.isDesktop) {
      this.startMcpServer();
    }

    console.log("Annotated plugin loaded");
  }

  // In-plugin MCP server (PLN step 4). Dynamic import keeps the MCP SDK and
  // node builtins out of the mobile load path; outcome is appended to mcp.log
  // in the plugin dir so it can be read without devtools.
  private async startMcpServer(): Promise<void> {
    const log = (msg: string) =>
      this.app.vault.adapter
        .append(
          `${this.manifest.dir}/mcp.log`,
          `${new Date().toISOString()} [v${this.manifest.version}] ${msg}\n`,
        )
        .catch(() => {});
    try {
      const device = this.deviceStore.load();
      if (!device.enabled) {
        await log("server disabled on this device");
        return;
      }
      const { AnnotatedMcpServer } = await import("./mcp/AnnotatedMcpServer");
      const getIdentities = () => this.settings.identities;
      const getEnvKeys = await loadEnvKeys(getIdentities, (warning) => {
        console.warn(`Annotated: ${warning}`);
        log(`warn: ${warning}`);
      });
      const server = new AnnotatedMcpServer(
        {
          store: this.commentManager.store,
          notes: buildNoteAccess(this.app.vault),
          auth: buildAuthProvider(getIdentities, this.deviceStore, getEnvKeys),
          info: {
            vaultName: this.app.vault.getName(),
            pluginVersion: this.manifest.version,
          },
          onLog: (msg) => log(msg),
        },
        resolveBindConfig(device),
      );
      await server.start();
      this.mcpServer = server;
      console.log(`Annotated: MCP server listening at ${server.address}/mcp`);
      await log(`listening at ${server.address}/mcp`);
    } catch (err) {
      console.error("Annotated: MCP server failed to start", err);
      await log(
        `failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  /**
   * The identity this device's human writes as (PLN step 6). Selection is
   * device-local; the identity itself lives in the synced registry.
   * First call migrates a legacy defaultAuthor (unless it's the colliding
   * "claude" default) or seeds an identity from the OS username.
   */
  getUiAuthor(): Identity {
    const device = this.deviceStore.load();
    const selected = device.uiIdentityId
      ? this.settings.identities.find((i) => i.id === device.uiIdentityId)
      : undefined;
    if (selected) return selected;

    const legacy = this.settings.defaultAuthor?.trim();
    const wantName =
      legacy && legacy.toLowerCase() !== "claude"
        ? legacy
        : (typeof process !== "undefined" && process.env?.USER) || "Me";

    let identity = this.settings.identities.find((i) => i.name === wantName);
    if (!identity) {
      identity = { id: generateIdentityId(), name: wantName };
      this.settings.identities.push(identity);
      void this.saveSettings();
    }
    device.uiIdentityId = identity.id;
    this.deviceStore.save(device);
    return identity;
  }

  async restartMcpServer(): Promise<void> {
    await this.mcpServer?.stop().catch(() => {});
    this.mcpServer = null;
    if (Platform.isDesktop) {
      await this.startMcpServer();
    }
  }

  onunload() {
    this.mcpServer?.stop().catch((err) => {
      console.error("Annotated: MCP server failed to stop", err);
    });
    this.mcpServer = null;
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

        new Notice(strings.notices.reselectLocation);

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
          new Notice(strings.notices.reselectCancelled);
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

    const uiAuthor = this.getUiAuthor();
    const makeOnSubmit =
      (loc: RangeLocation) => async (content: string, author: string) => {
        const now = new Date().toISOString();
        const comment: Comment = {
          id: this.commentManager.generateId(),
          author,
          // Free-text author edits in the modal are allowed; the identity id
          // only applies when the name is the selected identity's.
          author_id: author === uiAuthor.name ? uiAuthor.id : undefined,
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
        new Notice(strings.notices.commentAdded);
      };

    this.openCommentModal(
      {
        mode: "create",
        author: uiAuthor.name,
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
      new Notice(strings.notices.noCommentsToExport);
      return;
    }

    const filename = filePath.split("/").pop() ?? filePath;
    const open = commentFile.comments.filter((c) => c.status === "open");
    const resolved = commentFile.comments.filter(
      (c) => c.status === "resolved",
    );

    const formatDate = (iso: string) => iso.slice(0, 10);

    const formatComment = (c: Comment): string => {
      const loc = formatLocationText(c.location);
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
      new Notice(strings.notices.exportSuccess(total));
    } catch {
      new Notice(strings.notices.exportFailed);
    }
  }

  handleReply(comment: Comment, targetFilePath?: string): void {
    const mdView = targetFilePath
      ? this.getMarkdownViewForFile(targetFilePath)
      : this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView?.file) return;

    const filePath = mdView.file.path;
    const cmEditor = (mdView.editor as any).cm as EditorView | undefined;

    const uiAuthor = this.getUiAuthor();
    this.openCommentModal({
      mode: "reply",
      author: uiAuthor.name,
      replyingTo: comment.author,
      onSubmit: async (content: string, author: string) => {
        const now = new Date().toISOString();
        const reply: CommentReply = {
          id: this.commentManager.generateId(),
          author,
          author_id: author === uiAuthor.name ? uiAuthor.id : undefined,
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

    const uiAuthor = this.getUiAuthor();
    this.commentManager
      .resolveComment(filePath, comment.id, uiAuthor.name, uiAuthor.id)
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
    containerEl.createEl("h2", { text: strings.settings.heading });

    // ── Author ──
    containerEl.createEl("h3", { text: strings.settings.sections.author });

    const uiAuthor = this.plugin.getUiAuthor();
    new Setting(containerEl)
      .setName(strings.settings.defaultAuthor.name)
      .setDesc(strings.settings.defaultAuthor.desc)
      .addDropdown((dropdown) => {
        for (const identity of this.plugin.settings.identities) {
          dropdown.addOption(identity.id, identity.name);
        }
        dropdown.setValue(uiAuthor.id).onChange((value) => {
          const device = this.plugin.deviceStore.load();
          device.uiIdentityId = value;
          this.plugin.deviceStore.save(device);
        });
      });

    // ── Display ──
    containerEl.createEl("h3", { text: strings.settings.sections.display });

    new Setting(containerEl)
      .setName(strings.settings.showGutter.name)
      .setDesc(strings.settings.showGutter.desc)
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
      .setName(strings.settings.indicatorStyle.name)
      .setDesc(strings.settings.indicatorStyle.desc)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("icon", strings.settings.indicatorOptions.icon)
          .addOption("badge", strings.settings.indicatorOptions.badge)
          .addOption("highlight", strings.settings.indicatorOptions.highlight)
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
      .setName(strings.settings.gutterEmoji.name)
      .setDesc(strings.settings.gutterEmoji.desc)
      .addText((text) => {
        text
          .setPlaceholder(strings.settings.gutterEmoji.placeholder)
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
      .setName(strings.settings.maxPopup.name)
      .setDesc(strings.settings.maxPopup.desc)
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
      .setName(strings.settings.defaultSort.name)
      .setDesc(strings.settings.defaultSort.desc)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("line", strings.sort.line)
          .addOption("oldest", strings.sort.oldest)
          .addOption("newest", strings.sort.newest)
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
    containerEl.createEl("h3", { text: strings.settings.sections.filtering });

    new Setting(containerEl)
      .setName(strings.settings.hideResolved.name)
      .setDesc(strings.settings.hideResolved.desc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideResolvedByDefault)
          .onChange(async (value) => {
            this.plugin.settings.hideResolvedByDefault = value;
            await this.plugin.saveSettings();
            this.refreshActiveGutter();
          }),
      );

    this.displayIdentitySection(containerEl);
    if (Platform.isDesktop) {
      this.displayMcpSection(containerEl);
    }
  }

  // ── Identities (synced via data.json — PLN Decision 4b) ──────

  private displayIdentitySection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: strings.settings.sections.identities });
    containerEl.createEl("p", {
      text: strings.settings.identities.desc,
      cls: "setting-item-description",
    });

    if (this.plugin.settings.identities.length === 0) {
      containerEl.createEl("p", {
        text: strings.settings.identities.empty,
        cls: "setting-item-description",
      });
    }

    for (const identity of this.plugin.settings.identities) {
      new Setting(containerEl)
        .setName(identity.name)
        .setDesc(identity.id)
        .addText((text) =>
          text.setValue(identity.name).onChange(async (value) => {
            if (!value.trim()) return;
            identity.name = value.trim();
            await this.plugin.saveSettings();
          }),
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip(strings.settings.identities.deleteTooltip)
            .onClick(async () => {
              this.plugin.settings.identities = this.plugin.settings.identities.filter(
                (i) => i.id !== identity.id,
              );
              await this.plugin.saveSettings();
              new Notice(strings.settings.identities.deleted(identity.name));
              this.display();
            }),
        );
    }

    let newName = "";
    new Setting(containerEl)
      .addText((text) =>
        text
          .setPlaceholder(strings.settings.identities.addPlaceholder)
          .onChange((value) => (newName = value)),
      )
      .addButton((btn) =>
        btn.setButtonText(strings.settings.identities.addButton).onClick(async () => {
          const name = newName.trim();
          if (!name) return;
          this.plugin.settings.identities.push({ id: generateIdentityId(), name });
          await this.plugin.saveSettings();
          this.display();
        }),
      );
  }

  // ── MCP server + keys (device-local — PLN Decision 4b) ───────

  private displayMcpSection(containerEl: HTMLElement): void {
    const device = this.plugin.deviceStore.load();
    containerEl.createEl("h3", { text: strings.settings.sections.mcp });

    new Setting(containerEl)
      .setName(strings.settings.mcp.enabled.name)
      .setDesc(strings.settings.mcp.enabled.desc)
      .addToggle((toggle) =>
        toggle.setValue(device.enabled).onChange(async (value) => {
          const config = this.plugin.deviceStore.load();
          config.enabled = value;
          this.plugin.deviceStore.save(config);
          await this.plugin.restartMcpServer();
        }),
      );

    new Setting(containerEl)
      .setName(strings.settings.mcp.port.name)
      .setDesc(strings.settings.mcp.port.desc)
      .addText((text) =>
        text.setValue(String(device.port)).onChange(async (value) => {
          const port = Number(value);
          if (!Number.isInteger(port) || port < 1 || port > 65535) return;
          const config = this.plugin.deviceStore.load();
          config.port = port;
          this.plugin.deviceStore.save(config);
          await this.plugin.restartMcpServer();
        }),
      );

    new Setting(containerEl)
      .setName(strings.settings.mcp.host.name)
      .setDesc(strings.settings.mcp.host.desc)
      .addText((text) =>
        text.setValue(device.host).onChange(async (value) => {
          if (!value.trim()) return;
          const config = this.plugin.deviceStore.load();
          config.host = value.trim();
          this.plugin.deviceStore.save(config);
          await this.plugin.restartMcpServer();
        }),
      );

    containerEl.createEl("h4", { text: strings.settings.mcp.keysHeading });
    containerEl.createEl("p", {
      text: strings.settings.mcp.keysDesc,
      cls: "setting-item-description",
    });

    if (device.keys.length === 0) {
      containerEl.createEl("p", {
        text: strings.settings.mcp.noKeys,
        cls: "setting-item-description",
      });
    }

    // One row per pair; legacy unpaired keys get their own row.
    const groups = new Map<string, typeof device.keys>();
    for (const key of device.keys) {
      const groupId = key.pairId ?? key.tokenHash;
      const group = groups.get(groupId);
      if (group) group.push(key);
      else groups.set(groupId, [key]);
    }

    for (const [groupId, keys] of groups) {
      const first = keys[0];
      const identity = this.plugin.settings.identities.find((i) => i.id === first.identityId);
      const fence = first.pathScope?.length
        ? first.pathScope.map((f) => f + "/").join(", ")
        : strings.settings.mcp.wholeVault;
      const name = identity
        ? `${identity.name}${first.label ? " — " + first.label : ""}`
        : strings.settings.mcp.orphanedKey;
      const setting = new Setting(containerEl).setName(name).setDesc(fence);

      const addCopy = (label: string, scope: "full" | "watch") => {
        const record = keys.find((k) => k.scope === scope);
        if (!record) return;
        setting.addButton((btn) =>
          btn
            .setButtonText(label)
            .setTooltip(strings.settings.mcp.copyTooltip(label))
            .onClick(async () => {
              if (!record.token) {
                new Notice(strings.settings.mcp.legacyNoToken);
                return;
              }
              await navigator.clipboard.writeText(record.token);
              new Notice(strings.settings.mcp.copied(label));
            }),
        );
      };
      addCopy(strings.settings.mcp.pollName, "watch");
      addCopy(strings.settings.mcp.writeName, "full");

      setting.addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip(strings.settings.mcp.revokeTooltip)
          .onClick(() => {
            this.plugin.deviceStore.revokePair(groupId);
            new Notice(strings.settings.mcp.revoked);
            this.display();
          }),
      );
    }

    let mintIdentityId = this.plugin.settings.identities[0]?.id ?? "";
    let mintLabel = "";
    const mintFence = new Set<string>();

    const mintGroup = containerEl.createDiv({ cls: "annotated-mint-group" });

    new Setting(mintGroup)
      .setName(strings.settings.mcp.newKey)
      .addDropdown((dropdown) => {
        for (const identity of this.plugin.settings.identities) {
          dropdown.addOption(identity.id, identity.name);
        }
        dropdown.setValue(mintIdentityId).onChange((value) => (mintIdentityId = value));
      })
      .addText((text) =>
        text
          .setPlaceholder(strings.settings.mcp.labelPlaceholder)
          .onChange((value) => (mintLabel = value)),
      );

    const rootFolders = this.app.vault
      .getRoot()
      .children.filter((f): f is TFolder => f instanceof TFolder)
      .map((f) => f.name)
      .sort((a, b) => a.localeCompare(b));

    const fenceSetting = new Setting(mintGroup)
      .setName(strings.settings.mcp.fenceName)
      .setDesc(strings.settings.mcp.fenceDesc);
    const fenceOptions = fenceSetting.controlEl.createDiv({ cls: "annotated-fence-options" });
    for (const folder of rootFolders) {
      const label = fenceOptions.createEl("label");
      const checkbox = label.createEl("input", { type: "checkbox" });
      label.appendText(folder + "/");
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) mintFence.add(folder);
        else mintFence.delete(folder);
      });
    }

    new Setting(mintGroup).addButton((btn) =>
      btn
        .setButtonText(strings.settings.mcp.mintButton)
        .setCta()
        .onClick(async () => {
          if (!mintIdentityId) {
            new Notice(strings.settings.mcp.mintNeedsIdentity);
            return;
          }
          // Always a pair: the agent acts with full (read/write), its monitor
          // polls with watch. Standalone keys have no use case (LOG 2026-06-12).
          await this.plugin.deviceStore.mintPair(
            mintIdentityId,
            mintLabel.trim() || undefined,
            [...mintFence],
          );
          new Notice(strings.settings.mcp.mintedPair);
          this.display();
        }),
    );

    this.displayEnvKeysNote(containerEl);
  }

  private displayEnvKeysNote(containerEl: HTMLElement): void {
    const envCount = (process?.env?.ANNOTATED_MCP_KEYS && (() => {
      try {
        const parsed = JSON.parse(process.env.ANNOTATED_MCP_KEYS!);
        return Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        return 0;
      }
    })()) || 0;
    if (envCount > 0) {
      containerEl.createEl("p", {
        text: strings.settings.mcp.envKeys(envCount),
        cls: "setting-item-description",
      });
    }
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
