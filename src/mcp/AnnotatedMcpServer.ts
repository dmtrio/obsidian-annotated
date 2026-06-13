/**
 * Step-4 server (PLN — Event-Driven Comment Watch): MCP over Streamable HTTP
 * plus GET /comments/actionable, hosted inside the plugin.
 *
 * No "obsidian" imports — vault access, identities, and keys are injected, so
 * the whole server is testable in plain node (tests/mcp/). The plugin binding
 * lives in PluginMcpHost.ts.
 *
 * Auth (PLN Decisions 4/4b): every surface requires a bearer key; the key's
 * identity stamps author/author_id on writes and defaults excludeAuthors on
 * watch queries. Full scope → all MCP tools; watch scope → actionable GET only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
// Static imports on purpose — see LOG 2026-06-12: dynamic import("http") does
// not survive Obsidian's renderer; require("http") does.
import { createServer } from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import {
	authenticate,
	authHttpStatus,
	bearerToken,
	effectiveExcludeAuthors,
	keyAllowsPath,
	pathInScope,
	queryActionable,
	queryActionableFrontmatter,
	resolveQueryScope,
	applyFrontmatterEdit,
	stampProvenance,
	tierAllows,
} from "@annotated/comments-core";
import type {
	Comment,
	CommentFile,
	CommentReply,
	CommentStatus,
	CommentStore,
	Identity,
	KeyRecord,
	Tier,
} from "@annotated/comments-core";

export interface NoteAccess {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	/** Create a folder (and intermediates) so create_note can target new subfolders. */
	mkdir?(path: string): Promise<void>;
	/** Vault-relative paths of notes that have a comment sidecar. */
	listCommentedNotePaths(): Promise<string[]>;
	/** Vault-relative paths of all markdown notes (for list_notes). */
	listPaths(): Promise<string[]>;
	/** All notes' frontmatter (scalars only) for the frontmatter watch surface. Optional — absent ⇒ the surface returns []. */
	listFrontmatter?(): Promise<Array<{ path: string; frontmatter: Record<string, string> }>>;
}

export interface AuthProvider {
	getIdentities(): Identity[];
	getKeys(): KeyRecord[];
}

export interface AnnotatedMcpServerDeps {
	store: CommentStore;
	notes: NoteAccess;
	auth: AuthProvider;
	info: { vaultName: string; pluginVersion: string };
	/** Optional sink for lifecycle/diagnostic lines (the plugin writes a log file). */
	onLog?: (message: string) => void;
	/**
	 * Optional OAuth gate (PLN — MCP OAuth Shim). When present, the SDK auth
	 * router handles its paths and 401s advertise discovery via
	 * WWW-Authenticate. When absent there is no OAuth surface at all.
	 */
	oauth?: {
		handler: (req: IncomingMessage, res: ServerResponse) => void;
		wwwAuthenticate: string;
	};
	/** When present, write tools stamp created/createdBy/updated/updatedBy. now() returns a date like "2026-06-13". */
	provenance?: { now: () => string };
	/** Returns the synced tag prefix (e.g. "bot/") for agent-written tags. */
	getTagPrefix?: () => string;
}

export interface AnnotatedMcpServerConfig {
	port: number;
	host: string;
}

const SNIPPET_MAX = 50;

/**
 * Fold visually-identical punctuation to one canonical form so patch_note can
 * recover from dash/quote/space lookalikes (em-dash vs hyphen in titles is the
 * recurring offender). STRICTLY length-preserving — every replacement is one
 * code unit for one — so an index into the folded string is the same index into
 * the original, which is what lets the patch rewrite the real bytes at a folded
 * match. (Ellipsis … → ... is deliberately omitted: it changes length.)
 */
function foldPunct(s: string): string {
	return s
		.replace(/[‐-―−]/g, "-") // hyphen/figure/en/em dash, minus → "-"
		.replace(/[‘’‚‛]/g, "'") // single curly quotes → '
		.replace(/[“”„‟]/g, '"') // double curly quotes → "
		.replace(/ /g, " "); // non-breaking space → space
}

/** Non-overlapping start indices of `needle` in `haystack` ([] if absent/empty). */
function literalIndices(haystack: string, needle: string): number[] {
	const out: number[] = [];
	if (needle.length === 0) return out;
	let from = 0;
	for (;;) {
		const i = haystack.indexOf(needle, from);
		if (i === -1) break;
		out.push(i);
		from = i + needle.length;
	}
	return out;
}

export class AnnotatedMcpServer {
	private httpServer: Server | null = null;

	constructor(
		private readonly deps: AnnotatedMcpServerDeps,
		private readonly config: AnnotatedMcpServerConfig,
	) {}

	get address(): string {
		return `http://${this.config.host}:${this.config.port}`;
	}

	async start(): Promise<void> {
		const server = createServer((req, res) => {
			this.route(req, res).catch((err) => {
				this.deps.onLog?.(`request failed: ${err instanceof Error ? err.message : String(err)}`);
				if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
				if (!res.writableEnded) res.end(JSON.stringify({ error: "internal error" }));
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.config.port, this.config.host, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		this.httpServer = server;
	}

	async stop(): Promise<void> {
		const server = this.httpServer;
		if (!server) return;
		this.httpServer = null;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections?.();
		});
	}

	// ── Routing ─────────────────────────────────────────────────

	private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

		// Unauthenticated liveness probe — no vault data, no secrets.
		if (url.pathname === "/health") {
			return this.json(res, 200, { ok: true, pluginVersion: this.deps.info.pluginVersion });
		}

		// OAuth gate paths (SDK auth router + the paste-key login form).
		// Only routed when the gate is enabled — otherwise these are 404s
		// like any other unknown path, and no OAuth surface exists.
		if (this.deps.oauth) {
			const p = url.pathname;
			if (
				p.startsWith("/.well-known/") ||
				p.startsWith("/oauth/") ||
				p === "/authorize" ||
				p === "/token" ||
				p === "/register" ||
				p === "/revoke"
			) {
				this.deps.oauth.handler(req, res);
				return;
			}
		}

		const auth = await authenticate(
			bearerToken(req.headers.authorization),
			this.deps.auth.getKeys(),
			this.deps.auth.getIdentities(),
		);

		if (url.pathname === "/comments/actionable" && req.method === "GET") {
			const status = authHttpStatus(auth, "actionable");
			if (status !== 200 || !auth.ok) return this.deny(res, status);
			return this.handleActionable(url, auth.identity, auth.key, res);
		}

		if (url.pathname === "/frontmatter/actionable" && req.method === "GET") {
			const status = authHttpStatus(auth, "actionable");
			if (status !== 200 || !auth.ok) return this.deny(res, status);
			return this.handleFrontmatterActionable(url, auth.identity, auth.key, res);
		}

		if (url.pathname === "/mcp") {
			const status = authHttpStatus(auth, "mcp");
			if (status !== 200 || !auth.ok) return this.deny(res, status);
			return this.handleMcp(req, res, auth.identity, auth.key);
		}

		return this.json(res, 404, { error: "not found" });
	}

	private deny(res: ServerResponse, status: 401 | 403): void {
		// With the OAuth gate enabled, 401s advertise discovery (RFC 9728) so
		// OAuth-only clients (claude.ai) can find the authorize flow.
		if (status === 401 && this.deps.oauth) {
			res.setHeader("WWW-Authenticate", this.deps.oauth.wwwAuthenticate);
		}
		this.json(res, status, { error: status === 401 ? "unauthorized" : "forbidden" });
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	}

	// ── Watch surface ───────────────────────────────────────────

	private async handleActionable(
		url: URL,
		identity: Identity,
		key: KeyRecord,
		res: ServerResponse,
	): Promise<void> {
		const scope = resolveQueryScope(url.searchParams.get("scope") ?? undefined, key);
		if (!scope.ok) {
			return this.json(res, 403, { error: "scope outside this key's folder fence" });
		}
		const requested = url.searchParams.getAll("excludeAuthor");
		const statusParam = url.searchParams.get("status");
		const refs = await this.runActionableQuery({
			scope: scope.scopes,
			excludeAuthors: effectiveExcludeAuthors(requested, identity),
			status: statusParam === "resolved" || statusParam === "open" ? statusParam : undefined,
		});
		this.json(res, 200, refs);
	}

	private async runActionableQuery(params: {
		scope?: string | string[];
		excludeAuthors: string[];
		status?: CommentStatus;
	}) {
		const files = await this.loadCommentFiles();
		return queryActionable(files, params);
	}

	private async loadCommentFiles(): Promise<{ notePath: string; file: CommentFile }[]> {
		const paths = await this.deps.notes.listCommentedNotePaths();
		const files: { notePath: string; file: CommentFile }[] = [];
		for (const notePath of paths) {
			const file = await this.deps.store.getComments(notePath);
			if (file) files.push({ notePath, file });
		}
		return files;
	}

	private async handleFrontmatterActionable(
		url: URL,
		identity: Identity,
		key: KeyRecord,
		res: ServerResponse,
	): Promise<void> {
		// If listFrontmatter is not implemented, return empty
		if (!this.deps.notes.listFrontmatter) {
			return this.json(res, 200, []);
		}

		// Resolve scope against the key's fence
		const scope = resolveQueryScope(url.searchParams.get("scope") ?? undefined, key);
		if (!scope.ok) {
			return this.json(res, 403, { error: "scope outside this key's folder fence" });
		}

		// Parse params from query string
		const field = url.searchParams.get("field") ?? undefined;
		const triggersParam = url.searchParams.get("triggers");
		const triggers = triggersParam
			? triggersParam.split(",").filter((t) => t.length > 0)
			: undefined;
		const sep = url.searchParams.get("sep") ?? undefined;

		// Load notes and filter to allowed paths
		const allNotes = await this.deps.notes.listFrontmatter();
		const filteredNotes = allNotes.filter((note) => keyAllowsPath(key, note.path));

		// Run the query
		const refs = queryActionableFrontmatter(filteredNotes, {
			field,
			triggers,
			scope: scope.scopes,
			sep,
		});

		this.json(res, 200, refs);
	}

	// ── MCP surface ─────────────────────────────────────────────

	private async handleMcp(
		req: IncomingMessage,
		res: ServerResponse,
		identity: Identity,
		key: KeyRecord,
	): Promise<void> {
		// Stateless: fresh server+transport per request, bound to the
		// authenticated identity. No session bookkeeping to leak.
		const mcp = this.buildMcpServer(identity, key);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on("close", () => {
			transport.close();
			mcp.close();
		});
		await mcp.connect(transport);
		await transport.handleRequest(req, res);
	}

	private buildMcpServer(identity: Identity, key: KeyRecord): McpServer {
		const mcp = new McpServer({
			name: "obsidian-annotated",
			version: this.deps.info.pluginVersion,
		});
		const { store, notes, provenance } = this.deps;
		const text = (value: unknown) => ({
			content: [{ type: "text" as const, text: JSON.stringify(value) }],
		});
		const assertPath = (path: string) => {
			if (!keyAllowsPath(key, path)) {
				throw new Error(`Path is outside this key's folder fence: ${path}`);
			}
		};
		const allow = (minTier: Tier) => tierAllows(key.scope, minTier);

		if (allow("poll")) {
			mcp.registerTool(
				"get_config",
				{
					title: "Get plugin config",
					description:
						"Read plugin configuration the agent needs — currently the reserved tag prefix (default 'bot/') for agent-written tags. Add/remove only tags under this prefix; never touch the user's other tags.",
					inputSchema: {},
				},
				async () => {
					return text({ tagPrefix: this.deps.getTagPrefix?.() ?? "bot/" });
				},
			);
		}

		if (allow("poll")) {
			mcp.registerTool(
				"check_comments",
				{
					title: "Check for actionable comments",
					description:
						"Non-blocking scan for comment threads that need attention (open, last message not from an excluded author). Returns id-level refs {id, note_path, thread_id, last_activity_at, snippet}; use read_comments for full bodies. excludeAuthors defaults to your own identity.",
					inputSchema: {
						path: z.string().optional().describe("Folder or note path scope (default: whole vault)"),
						excludeAuthors: z.array(z.string()).optional(),
						status: z.enum(["open", "resolved"]).optional(),
					},
				},
				async ({ path, excludeAuthors, status }) => {
					const scope = resolveQueryScope(path, key);
					if (!scope.ok) throw new Error(`Scope is outside this key's folder fence: ${path}`);
					return text(
						await this.runActionableQuery({
							scope: scope.scopes,
							excludeAuthors: effectiveExcludeAuthors(excludeAuthors, identity),
							status,
						}),
					);
				},
			);
		}

		if (allow("poll")) {
			mcp.registerTool(
				"check_frontmatter",
				{
					title: "Check for actionable frontmatter",
					description:
						"Non-blocking scan for notes whose frontmatter field (default 'annotated') holds a trigger value — the note-level analog of check_comments. Returns {note_path, field, value, root, arg}.",
					inputSchema: {
						field: z.string().optional(),
						triggers: z.array(z.string()).optional(),
						path: z.string().optional().describe("Folder or note path scope (default: whole vault)"),
						sep: z.string().optional(),
					},
				},
				async ({ field, triggers, path, sep }) => {
					if (!notes.listFrontmatter) return text([]);
					const scope = resolveQueryScope(path, key);
					if (!scope.ok) throw new Error(`Scope is outside this key's folder fence: ${path}`);
					const allNotes = await notes.listFrontmatter();
					const filteredNotes = allNotes.filter((note) => keyAllowsPath(key, note.path));
					const refs = queryActionableFrontmatter(filteredNotes, {
						field,
						triggers,
						scope: scope.scopes,
						sep,
					});
					return text(refs);
				},
			);
		}

		if (allow("poll")) {
			mcp.registerTool(
				"read_comments",
				{
					title: "Read comments on a note",
					description:
						"All comment threads on a note (replies nested), optionally filtered by status or author. Empty result if the note has no comments.",
					inputSchema: {
						path: z.string(),
						status: z.enum(["open", "resolved"]).optional(),
						author: z.string().optional(),
					},
				},
				async ({ path, status, author }) => {
					assertPath(path);
					const file = await store.getComments(path);
					if (!file) return text({ path, comments: [] });
					let comments = file.comments;
					if (status) comments = comments.filter((c) => c.status === status);
					if (author) comments = comments.filter((c) => c.author === author);
					return text({ path, comments });
				},
			);
		}

		if (allow("additive")) {
			mcp.registerTool(
				"add_comment",
				{
					title: "Add a comment",
					description:
						"Add a new comment thread to a note. Author is your authenticated identity — it cannot be overridden.",
					inputSchema: {
						path: z.string(),
						content: z.string().min(1),
						startLine: z.number().int().min(1),
						endLine: z.number().int().min(1),
						startChar: z.number().int().min(0).optional(),
						endChar: z.number().int().min(0).optional(),
					},
				},
				async ({ path, content, startLine, endLine, startChar, endChar }) => {
					assertPath(path);
					if (!(await notes.exists(path))) throw new Error(`Note not found: ${path}`);
					const now = new Date().toISOString();
					const comment: Comment = {
						id: store.generateId(),
						author: identity.name,
						author_id: identity.id,
						created_at: now,
						updated_at: now,
						location: {
							type: "range",
							start_line: startLine,
							start_char: startChar ?? 0,
							end_line: endLine,
							end_char: endChar ?? 0,
						},
						content,
						status: "open",
						replies: [],
						last_activity_at: now,
						content_snippet: await this.captureSnippet(path, startLine),
					};
					await store.addComment(path, comment);
					return text({ ok: true, id: comment.id });
				},
			);
		}

		if (allow("additive")) {
			mcp.registerTool(
				"reply_to_comment",
				{
					title: "Reply to a comment",
					description:
						"Reply to an existing thread (reopens it if resolved). Author is your authenticated identity.",
					inputSchema: {
						path: z.string(),
						commentId: z.string(),
						content: z.string().min(1),
					},
				},
				async ({ path, commentId, content }) => {
					assertPath(path);
					await this.requireThread(path, commentId);
					const now = new Date().toISOString();
					const reply: CommentReply = {
						id: store.generateId(),
						author: identity.name,
						author_id: identity.id,
						created_at: now,
						updated_at: now,
						content,
						status: "open",
					};
					await store.addReply(path, commentId, reply);
					return text({ ok: true, id: reply.id });
				},
			);
		}

		if (allow("additive")) {
			mcp.registerTool(
				"resolve_comment",
				{
					title: "Resolve or reopen a comment",
					description:
						"Mark a thread resolved (default) or reopen it. resolved_by is your authenticated identity. Idempotent.",
					inputSchema: {
						path: z.string(),
						commentId: z.string(),
						status: z.enum(["resolved", "open"]).optional(),
					},
				},
				async ({ path, commentId, status }) => {
					assertPath(path);
					const { file, comment } = await this.requireThread(path, commentId);
					if ((status ?? "resolved") === "resolved") {
						comment.status = "resolved";
						comment.resolved_at = new Date().toISOString();
						comment.resolved_by = identity.name;
						comment.resolved_by_id = identity.id;
						comment.updated_at = comment.resolved_at;
					} else {
						comment.status = "open";
						comment.resolved_at = undefined;
						comment.resolved_by = undefined;
						comment.resolved_by_id = undefined;
						comment.updated_at = new Date().toISOString();
					}
					await store.saveComments(file);
					return text({ ok: true, id: commentId, status: comment.status });
				},
			);
		}

		if (allow("poll")) {
			mcp.registerTool(
				"list_commented_notes",
				{
					title: "List notes that have comments",
					description:
						"Which notes have comments, sorted by open count descending (most actionable first).",
					inputSchema: {
						path: z.string().optional().describe("Folder scope (default: whole vault)"),
						status: z.enum(["open", "resolved"]).optional(),
					},
				},
				async ({ path, status }) => {
					const files = await this.loadCommentFiles();
					const notes = files
						.filter(
							({ notePath }) =>
								keyAllowsPath(key, notePath) && (!path || pathInScope(notePath, path)),
						)
						.map(({ notePath, file }) => ({
							path: notePath,
							open: file.metadata.open_count,
							resolved: file.metadata.resolved_count,
							lastActivity: file.updated_at,
						}))
						.filter((n) =>
							status === "open" ? n.open > 0 : status === "resolved" ? n.resolved > 0 : true,
						)
						.sort((a, b) => b.open - a.open);
					return text({ notes });
				},
			);
		}

		if (allow("poll")) {
			mcp.registerTool(
				"read_note",
				{
					title: "Read a note",
					description: "Raw markdown content of a note (frontmatter included).",
					inputSchema: { path: z.string() },
				},
				async ({ path }) => {
					assertPath(path);
					if (!(await notes.exists(path))) throw new Error(`Note not found: ${path}`);
					return text({ path, content: await notes.read(path) });
				},
			);
		}

		if (allow("poll")) {
			mcp.registerTool(
				"list_notes",
				{
					title: "List notes",
					description:
						"Vault-relative paths of notes in scope, each flagged with whether it has comments. Fenced to the key's folder scope.",
					inputSchema: {
						path: z.string().optional().describe("Folder or note path scope (default: whole vault)"),
					},
				},
				async ({ path }) => {
					const scope = resolveQueryScope(path, key);
					if (!scope.ok) throw new Error(`Scope is outside this key's folder fence: ${path}`);
					const all = await notes.listPaths();
					const commented = new Set(await notes.listCommentedNotePaths());
					const inScope = (p: string) =>
						scope.scopes === undefined ? true : scope.scopes.some((s) => pathInScope(p, s));
					const notesOut = all
						.filter((p) => keyAllowsPath(key, p) && inScope(p))
						.map((p) => ({ path: p, hasComments: commented.has(p) }));
					return text({ notes: notesOut });
				},
			);
		}

		if (allow("poll")) {
			mcp.registerTool(
				"read_multiple_notes",
				{
					title: "Read multiple notes",
					description:
						"Read up to 10 notes in one call. Partial success: unreadable or out-of-fence paths land in `err`, the rest in `ok`.",
					inputSchema: {
						paths: z
							.array(z.string())
							.max(10)
							.describe("Up to 10 vault-relative note paths"),
					},
				},
				async ({ paths }) => {
					const ok: Array<{ path: string; content: string }> = [];
					const err: Array<{ path: string; error: string }> = [];
					for (const p of paths) {
						if (!keyAllowsPath(key, p)) {
							err.push({ path: p, error: "outside this key's folder fence" });
							continue;
						}
						if (!(await notes.exists(p))) {
							err.push({ path: p, error: "not found" });
							continue;
						}
						ok.push({ path: p, content: await notes.read(p) });
					}
					return text({ ok, err });
				},
			);
		}

		if (allow("additive")) {
			mcp.registerTool(
				"patch_note",
				{
					title: "Patch a note",
					description:
						"Replace an exact string in a note. Fails if oldString matches multiple times unless replaceAll is true, and fails if it matches nothing.",
					inputSchema: {
						path: z.string(),
						oldString: z.string().min(1),
						newString: z.string(),
						replaceAll: z.boolean().optional(),
					},
				},
				async ({ path, oldString, newString, replaceAll }) => {
					assertPath(path);
					if (typeof newString !== "string") {
						// zod already enforces this; belt-and-suspenders against the
						// "undefined written into the note" bug class (LOG 2026-06-11).
						throw new Error("newString is required");
					}
					if (!(await notes.exists(path))) throw new Error(`Note not found: ${path}`);
					const content = await notes.read(path);

					// Exact match wins. Only when the literal substring is absent do we
					// retry with punctuation folding — the fold is length-preserving, so
					// indices into the folded text address the original bytes directly,
					// and we always rewrite the real bytes at the matched span. An
					// ambiguous folded match errors exactly like an ambiguous exact one,
					// so the fallback never silently hits the wrong target.
					let indices = literalIndices(content, oldString);
					let viaNormalization = false;
					if (indices.length === 0) {
						indices = literalIndices(foldPunct(content), foldPunct(oldString));
						if (indices.length === 0) throw new Error("oldString not found in note");
						viaNormalization = true;
					}
					if (indices.length > 1 && !replaceAll) {
						throw new Error(
							`oldString matches ${indices.length} times${
								viaNormalization ? " (via punctuation normalization)" : ""
							}; pass replaceAll or a more specific string`,
						);
					}
					const targets = replaceAll ? indices : indices.slice(0, 1);
					const matchLen = oldString.length; // fold preserves length
					let updated = "";
					let prev = 0;
					for (const idx of targets) {
						updated += content.slice(prev, idx) + newString;
						prev = idx + matchLen;
					}
					updated += content.slice(prev);
					const toWrite = provenance
						? stampProvenance(updated, {
								author: `${identity.name} <${identity.id}>`,
								date: provenance.now(),
								isCreate: false,
							})
						: updated;
					await notes.write(path, toWrite);
					return text({
						ok: true,
						replacements: targets.length,
						...(viaNormalization ? { viaNormalization: true } : {}),
					});
				},
			);
		}

		if (allow("additive")) {
			mcp.registerTool(
				"create_note",
				{
					title: "Create a note",
					description:
						"Create a new markdown note with the given content. Fails if the note already exists — use patch_note to modify existing notes.",
					inputSchema: {
						path: z.string().describe("Vault-relative path ending in .md"),
						content: z.string(),
					},
				},
				async ({ path, content }) => {
					assertPath(path);
					// Creation is the only tool that can conjure arbitrary files; keep it
					// to in-vault markdown (no sidecars, no .obsidian, no traversal).
					if (!path.endsWith(".md")) throw new Error("path must end in .md");
					if (path.startsWith("/") || path.split("/").some((s) => s === "..")) {
						throw new Error(`Invalid path: ${path}`);
					}
					if (await notes.exists(path)) {
						throw new Error(`Note already exists: ${path} — use patch_note to modify it`);
					}
					const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
					if (parent && notes.mkdir && !(await notes.exists(parent))) await notes.mkdir(parent);
					const toWrite = provenance
						? stampProvenance(content, {
								author: `${identity.name} <${identity.id}>`,
								date: provenance.now(),
								isCreate: true,
							})
						: content;
					await notes.write(path, toWrite);
					return text({ ok: true, path });
				},
			);
		}

		if (allow("additive")) {
			mcp.registerTool(
				"update_frontmatter",
				{
					title: "Update note frontmatter",
					description:
						"Set or clear frontmatter fields, or add/remove items from a list field (e.g. tags), without touching other fields or the note body. Field-addressed and non-clobbering — unlike patch_note it needs no match string.",
					inputSchema: {
						path: z.string(),
						set: z.record(z.string()).optional(),
						unset: z.array(z.string()).optional(),
						listAdd: z.object({ field: z.string(), items: z.array(z.string()) }).optional(),
						listRemove: z.object({ field: z.string(), items: z.array(z.string()) }).optional(),
					},
				},
				async ({ path, set, unset, listAdd, listRemove }) => {
					assertPath(path);
					if (!(await notes.exists(path))) throw new Error(`Note not found: ${path}`);
					if (!set && !unset && !listAdd && !listRemove) {
						throw new Error("update_frontmatter needs at least one of set/unset/listAdd/listRemove");
					}
					const content = await notes.read(path);
					const updated = applyFrontmatterEdit(content, { set, unset, listAdd, listRemove });
					const toWrite = provenance
						? stampProvenance(updated, {
								author: `${identity.name} <${identity.id}>`,
								date: provenance.now(),
								isCreate: false,
							})
						: updated;
					await notes.write(path, toWrite);
					return text({ ok: true, path });
				},
			);
		}

		if (allow("additive")) {
			mcp.registerTool(
				"append_note",
				{
					title: "Append to a note",
					description:
						"Add text to the end of an existing note without touching any existing content. The safe way to add LOG-style entries — unlike patch_note it needs no match string, and it can never overwrite. Inserts a blank line before the appended text unless the note already ends with one.",
					inputSchema: {
						path: z.string(),
						content: z.string().min(1),
					},
				},
				async ({ path, content }) => {
					assertPath(path);
					if (!(await notes.exists(path))) throw new Error(`Note not found: ${path}`);
					const existing = await notes.read(path);
					// Normalize the seam: end the existing body with exactly one newline,
					// then a blank line, so appended sections don't run into prior text.
					const base = existing.length === 0 ? "" : existing.replace(/\n*$/, "\n");
					const sep = base === "" ? "" : "\n";
					const updated = base + sep + content;
					const toWrite = provenance
						? stampProvenance(updated, {
								author: `${identity.name} <${identity.id}>`,
								date: provenance.now(),
								isCreate: false,
							})
						: updated;
					await notes.write(path, toWrite);
					return text({ ok: true, path, appended: content.length });
				},
			);
		}

		return mcp;
	}

	// ── Helpers ─────────────────────────────────────────────────

	private async requireThread(
		path: string,
		commentId: string,
	): Promise<{ file: CommentFile; comment: Comment }> {
		const file = await this.deps.store.getComments(path);
		const comment = file?.comments.find((c) => c.id === commentId);
		if (!file || !comment) throw new Error(`Comment not found: ${commentId} on ${path}`);
		return { file, comment };
	}

	private async captureSnippet(path: string, startLine: number): Promise<string | undefined> {
		try {
			const lines = (await this.deps.notes.read(path)).split("\n");
			const line = lines[startLine - 1];
			return line === undefined ? undefined : line.trim().slice(0, SNIPPET_MAX);
		} catch {
			return undefined;
		}
	}
}
