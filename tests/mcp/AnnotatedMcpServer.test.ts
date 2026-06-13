/**
 * Integration tests for the in-plugin MCP server: real HTTP on an ephemeral
 * port, real SDK client, in-memory vault. Covers the auth-rejection matrix
 * over the wire, identity-derived author stamping, the full agent flow
 * (check → read → reply → resolve), and patch_note validation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	CommentStore,
	InMemoryStorageAdapter,
	hashToken,
	readFrontmatter,
	type Identity,
	type KeyRecord,
} from "@annotated/comments-core";
import { AnnotatedMcpServer, type NoteAccess } from "../../src/mcp/AnnotatedMcpServer";

const PORT = 27981;
const BASE = `http://127.0.0.1:${PORT}`;

const deme: Identity = { id: "i_deme", name: "Deme" };
const claude: Identity = { id: "i_claude", name: "Claude" };

let server: AnnotatedMcpServer;
let storage: InMemoryStorageAdapter;
let notesStore: Map<string, string>;

function buildNotes(): NoteAccess {
	notesStore = new Map([
		["inbox/idea.md", "# Idea\n\nLine three has the thing.\n"],
		["inbox/other.md", "# Other\n\nfoo bar foo\n"],
	]);
	return {
		exists: async (p) => notesStore.has(p),
		read: async (p) => {
			const c = notesStore.get(p);
			if (c === undefined) throw new Error(`ENOENT ${p}`);
			return c;
		},
		write: async (p, content) => void notesStore.set(p, content),
		mkdir: async () => {},
		listCommentedNotePaths: async () => {
			const suffix = ".comments.json";
			return [...storage.files.keys()]
				.filter((p) => p.endsWith(suffix))
				.map((p) => p.slice(0, -suffix.length));
		},
		listFrontmatter: async () => {
			const result = [];
			for (const [path, content] of notesStore) {
				if (!path.endsWith(".md")) continue;
				const parsed = readFrontmatter(content);
				result.push({
					path,
					frontmatter: parsed.scalars,
				});
			}
			return result;
		},
	};
}

async function mcpClient(token: string): Promise<Client> {
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);
	return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
	const result = await client.callTool({ name, arguments: args });
	const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
	return { result, body: !result.isError && text ? JSON.parse(text) : null };
}

beforeAll(async () => {
	storage = new InMemoryStorageAdapter();
	const store = new CommentStore(storage, { createdBy: "test@0.0.0" });
	const keys: KeyRecord[] = [
		{ tokenHash: await hashToken("claude-full"), identityId: "i_claude", scope: "full" },
		{ tokenHash: await hashToken("claude-watch"), identityId: "i_claude", scope: "watch" },
		{ tokenHash: await hashToken("orphan"), identityId: "i_gone", scope: "full" },
		{
			tokenHash: await hashToken("fenced"),
			identityId: "i_claude",
			scope: "full",
			pathScope: ["fenced-zone"],
		},
	];
	server = new AnnotatedMcpServer(
		{
			store,
			notes: buildNotes(),
			auth: { getIdentities: () => [deme, claude], getKeys: () => keys },
			info: { vaultName: "test-vault", pluginVersion: "0.0.0-test" },
		},
		{ port: PORT, host: "127.0.0.1" },
	);
	await server.start();
});

afterAll(async () => {
	await server.stop();
});

describe("HTTP auth matrix", () => {
	it("/health is open and content-free", async () => {
		const res = await fetch(`${BASE}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, pluginVersion: "0.0.0-test" });
	});

	const cases: Array<[string, string | null, number]> = [
		["/comments/actionable", null, 401],
		["/comments/actionable", "wrong", 401],
		["/comments/actionable", "orphan", 401],
		["/comments/actionable", "claude-watch", 200],
		["/comments/actionable", "claude-full", 200],
		["/mcp", null, 401],
		["/mcp", "claude-watch", 403],
	];
	for (const [path, token, expected] of cases) {
		it(`GET ${path} with ${token ?? "no key"} → ${expected}`, async () => {
			const res = await fetch(`${BASE}${path}`, {
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			});
			expect(res.status).toBe(expected);
		});
	}

	it("unknown routes are 404 (after auth)", async () => {
		const res = await fetch(`${BASE}/anything`, {
			headers: { Authorization: "Bearer claude-full" },
		});
		expect(res.status).toBe(404);
	});
});

describe("full agent flow with identity-derived authorship", () => {
	it("add → check → read → reply → resolve, stamped as the key's identity", async () => {
		const client = await mcpClient("claude-full");

		// Agent adds a comment — author comes from the key, not a param
		const added = await callTool(client, "add_comment", {
			path: "inbox/idea.md",
			content: "What about the third line?",
			startLine: 3,
			endLine: 3,
		});
		expect(added.body.ok).toBe(true);
		const threadId = added.body.id;

		// The agent's own comment is NOT actionable for the agent (self-excluded)
		const check1 = await callTool(client, "check_comments", { path: "inbox" });
		expect(check1.body).toEqual([]);

		// ...but the watch endpoint shows it for a different excludeAuthor
		const res = await fetch(`${BASE}/comments/actionable?scope=inbox&excludeAuthor=Deme`, {
			headers: { Authorization: "Bearer claude-watch" },
		});
		const refs = await res.json();
		expect(refs).toHaveLength(1);
		expect(refs[0].thread_id).toBe(threadId);
		expect(refs[0].note_path).toBe("inbox/idea.md");

		// Simulate the human replying (write directly through the sidecar)
		const sidecar = JSON.parse(storage.files.get("inbox/idea.md.comments.json")!);
		sidecar.comments[0].replies.push({
			id: "c_human_reply",
			author: "Deme",
			created_at: "2030-01-01T00:00:00Z",
			updated_at: "2030-01-01T00:00:00Z",
			content: "Good catch — fix it",
			status: "open",
		});
		sidecar.comments[0].last_activity_at = "2030-01-01T00:00:00Z";
		storage.files.set("inbox/idea.md.comments.json", JSON.stringify(sidecar));
		// (the real plugin invalidates on vault modify events; tests do it directly)
		(server as any).deps.store.invalidateCache("inbox/idea.md");

		// Now the thread is actionable for the agent, and the ref id is the REPLY id
		const check2 = await callTool(client, "check_comments", { path: "inbox" });
		expect(check2.body).toHaveLength(1);
		expect(check2.body[0].id).toBe("c_human_reply");
		expect(check2.body[0].thread_id).toBe(threadId);
		expect(check2.body[0].snippet).toBe("Good catch — fix it");

		// Agent replies — stamped with identity name AND id
		await callTool(client, "reply_to_comment", {
			path: "inbox/idea.md",
			commentId: threadId,
			content: "Done.",
		});
		const afterReply = await callTool(client, "read_comments", { path: "inbox/idea.md" });
		const thread = afterReply.body.comments[0];
		expect(thread.author).toBe("Claude");
		expect(thread.author_id).toBe("i_claude");
		const lastReply = thread.replies[thread.replies.length - 1];
		expect(lastReply.author).toBe("Claude");
		expect(lastReply.author_id).toBe("i_claude");

		// Replying cleared actionability (agent had the last word)
		const check3 = await callTool(client, "check_comments", { path: "inbox" });
		expect(check3.body).toEqual([]);

		// Resolve — audit fields carry the identity
		await callTool(client, "resolve_comment", { path: "inbox/idea.md", commentId: threadId });
		const resolved = await callTool(client, "read_comments", {
			path: "inbox/idea.md",
			status: "resolved",
		});
		expect(resolved.body.comments[0].resolved_by).toBe("Claude");
		expect(resolved.body.comments[0].resolved_by_id).toBe("i_claude");

		await client.close();
	});

	it("list_commented_notes reports counts", async () => {
		const client = await mcpClient("claude-full");
		const { body } = await callTool(client, "list_commented_notes", {});
		expect(body.notes).toHaveLength(1);
		expect(body.notes[0].path).toBe("inbox/idea.md");
		expect(body.notes[0].resolved).toBe(1);
		await client.close();
	});
});

describe("folder fence enforcement", () => {
	it("a fenced key cannot read or write outside its folders", async () => {
		const client = await mcpClient("fenced");

		const read = await callTool(client, "read_note", { path: "inbox/other.md" });
		expect(read.result.isError).toBe(true);

		const patch = await callTool(client, "patch_note", {
			path: "inbox/other.md",
			oldString: "bar",
			newString: "x",
		});
		expect(patch.result.isError).toBe(true);

		const comments = await callTool(client, "read_comments", { path: "inbox/idea.md" });
		expect(comments.result.isError).toBe(true);

		// check_comments with no scope clamps to the fence → sees nothing outside
		const check = await callTool(client, "check_comments", {
			excludeAuthors: ["nobody"],
		});
		expect(check.body).toEqual([]);

		// explicitly requesting outside the fence is a loud error, not empty
		const outside = await callTool(client, "check_comments", { path: "inbox" });
		expect(outside.result.isError).toBe(true);

		// list_commented_notes silently filters to the fence
		const list = await callTool(client, "list_commented_notes", {});
		expect(list.body.notes).toEqual([]);

		await client.close();
	});

	it("the actionable route 403s on a scope outside the key's fence", async () => {
		const res = await fetch(`${BASE}/comments/actionable?scope=inbox`, {
			headers: { Authorization: "Bearer fenced" },
		});
		expect(res.status).toBe(403);
	});
});

describe("frontmatter watch surface", () => {
	it("GET /frontmatter/actionable with watch key returns refs matching trigger", async () => {
		// Seed notes with frontmatter
		notesStore.set("watch/a.md", "---\nannotated: review\n---\n# A\n");
		notesStore.set("watch/b.md", "---\nannotated: reviewed\n---\n# B\n");

		const res = await fetch(`${BASE}/frontmatter/actionable?scope=watch&triggers=review`, {
			headers: { Authorization: "Bearer claude-watch" },
		});
		expect(res.status).toBe(200);
		const refs = await res.json();
		expect(refs).toHaveLength(1);
		expect(refs[0]).toEqual({
			note_path: "watch/a.md",
			field: "annotated",
			value: "review",
			root: "review",
			arg: null,
		});
	});

	it("check_frontmatter MCP tool with triggers and scope", async () => {
		notesStore.set("watch/c.md", "---\nannotated: review\n---\n# C\n");

		const client = await mcpClient("claude-full");
		const { body } = await callTool(client, "check_frontmatter", {
			triggers: ["review"],
			path: "watch",
		});
		expect(body).toHaveLength(2);
		expect(body[0].note_path).toBe("watch/a.md");
		expect(body[1].note_path).toBe("watch/c.md");
		await client.close();
	});

	it("compound frontmatter value with arg", async () => {
		notesStore.set("watch/d.md", "---\nannotated: translate/spanish\n---\n# D\n");

		const res = await fetch(`${BASE}/frontmatter/actionable?scope=watch&triggers=translate`, {
			headers: { Authorization: "Bearer claude-watch" },
		});
		const refs = await res.json();
		expect(refs).toHaveLength(1);
		expect(refs[0]).toEqual({
			note_path: "watch/d.md",
			field: "annotated",
			value: "translate/spanish",
			root: "translate",
			arg: "spanish",
		});
	});

	it("fenced key requesting out-of-fence scope is refused", async () => {
		const res = await fetch(`${BASE}/frontmatter/actionable?scope=watch`, {
			headers: { Authorization: "Bearer fenced" },
		});
		expect(res.status).toBe(403);
	});

	it("watch key accessing mcp surface is forbidden", async () => {
		const client = new Client({ name: "test-client", version: "0.0.0" });
		let err: Error | null = null;
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
					requestInit: { headers: { Authorization: "Bearer claude-watch" } },
				}),
			);
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeTruthy();
		client.close();
	});
});

describe("note tools", () => {
	it("read_note returns raw content", async () => {
		const client = await mcpClient("claude-full");
		const { body } = await callTool(client, "read_note", { path: "inbox/other.md" });
		expect(body.content).toContain("foo bar foo");
		await client.close();
	});

	it("patch_note rejects a call without newString (the 'undefined' bug class)", async () => {
		const client = await mcpClient("claude-full");
		const { result } = await callTool(client, "patch_note", {
			path: "inbox/other.md",
			oldString: "foo",
		});
		expect(result.isError).toBe(true);
		expect(notesStore.get("inbox/other.md")).not.toContain("undefined");
		await client.close();
	});

	it("patch_note refuses ambiguous matches without replaceAll, applies with it", async () => {
		const client = await mcpClient("claude-full");
		const ambiguous = await callTool(client, "patch_note", {
			path: "inbox/other.md",
			oldString: "foo",
			newString: "baz",
		});
		expect(ambiguous.result.isError).toBe(true);

		const all = await callTool(client, "patch_note", {
			path: "inbox/other.md",
			oldString: "foo",
			newString: "baz",
			replaceAll: true,
		});
		expect(all.body).toEqual({ ok: true, replacements: 2 });
		expect(notesStore.get("inbox/other.md")).toContain("baz bar baz");
		await client.close();
	});

	it("patch_note errors when oldString is absent from the note", async () => {
		const client = await mcpClient("claude-full");
		const { result } = await callTool(client, "patch_note", {
			path: "inbox/other.md",
			oldString: "not-in-the-note",
			newString: "x",
		});
		expect(result.isError).toBe(true);
		await client.close();
	});

	it("create_note creates a new markdown note (with parent folder) and nothing else", async () => {
		const client = await mcpClient("claude-full");
		const created = await callTool(client, "create_note", {
			path: "plans/PLN - New Thing.md",
			content: "---\nstatus: draft\n---\n# PLN\n",
		});
		expect(created.body).toEqual({ ok: true, path: "plans/PLN - New Thing.md" });
		expect(notesStore.get("plans/PLN - New Thing.md")).toContain("status: draft");

		// Never overwrites — existing notes are patch_note territory
		const dup = await callTool(client, "create_note", { path: "inbox/idea.md", content: "x" });
		expect(dup.result.isError).toBe(true);
		expect(notesStore.get("inbox/idea.md")).toContain("# Idea");

		// Markdown only — no sidecars, configs, or traversal
		const sidecar = await callTool(client, "create_note", {
			path: "inbox/x.comments.json",
			content: "{}",
		});
		expect(sidecar.result.isError).toBe(true);
		const traversal = await callTool(client, "create_note", {
			path: "../outside.md",
			content: "x",
		});
		expect(traversal.result.isError).toBe(true);

		await client.close();
	});

	it("patch_note falls back to punctuation folding when the exact match misses", async () => {
		const client = await mcpClient("claude-full");
		// Note holds an em-dash title; caller patches with a plain hyphen.
		notesStore.set("inbox/title.md", "# PLN — MCP OAuth Shim\n\nbody\n");
		const r = await callTool(client, "patch_note", {
			path: "inbox/title.md",
			oldString: "# PLN - MCP OAuth Shim",
			newString: "# PLN — MCP OAuth Shim (done)",
		});
		expect(r.body).toEqual({ ok: true, replacements: 1, viaNormalization: true });
		// The replacement landed on the real span — em-dash original is gone,
		// replaced by exactly what we asked for, body untouched.
		expect(notesStore.get("inbox/title.md")).toBe(
			"# PLN — MCP OAuth Shim (done)\n\nbody\n",
		);
		await client.close();
	});

	it("patch_note prefers an exact match over a folded one and stays loud on real misses", async () => {
		const client = await mcpClient("claude-full");
		notesStore.set("inbox/q.md", "straight 'quote' here\n");
		// Exact match present → no normalization flag in the result.
		const exact = await callTool(client, "patch_note", {
			path: "inbox/q.md",
			oldString: "'quote'",
			newString: "'word'",
		});
		expect(exact.body).toEqual({ ok: true, replacements: 1 });
		// Genuinely absent text still errors, fold or no fold.
		const miss = await callTool(client, "patch_note", {
			path: "inbox/q.md",
			oldString: "nowhere",
			newString: "x",
		});
		expect(miss.result.isError).toBe(true);
		await client.close();
	});

	it("append_note adds to the end with a blank-line seam and never overwrites", async () => {
		const client = await mcpClient("claude-full");
		const before = notesStore.get("inbox/idea.md");

		const r1 = await callTool(client, "append_note", {
			path: "inbox/idea.md",
			content: "## LOG\n\nfirst entry\n",
		});
		expect(r1.body.ok).toBe(true);
		const after1 = notesStore.get("inbox/idea.md")!;
		// Original content is byte-preserved as a prefix
		expect(after1.startsWith(before!)).toBe(true);
		expect(after1).toContain("## LOG");
		// Exactly one blank line at the seam (no run-on, no pile-up)
		expect(after1).toContain("the thing.\n\n## LOG");

		// A second append stacks cleanly with one blank line, not three
		await callTool(client, "append_note", {
			path: "inbox/idea.md",
			content: "second entry\n",
		});
		const after2 = notesStore.get("inbox/idea.md")!;
		expect(after2).toContain("first entry\n\nsecond entry");

		// Missing note errors (append modifies, never creates)
		const missing = await callTool(client, "append_note", {
			path: "inbox/nope.md",
			content: "x",
		});
		expect(missing.result.isError).toBe(true);
		await client.close();
	});

	it("append_note respects the folder fence", async () => {
		const client = await mcpClient("fenced");
		const { result } = await callTool(client, "append_note", {
			path: "inbox/other.md",
			content: "x",
		});
		expect(result.isError).toBe(true);
		await client.close();
	});

	it("create_note respects the folder fence", async () => {
		const client = await mcpClient("fenced");
		const { result } = await callTool(client, "create_note", {
			path: "inbox/new.md",
			content: "x",
		});
		expect(result.isError).toBe(true);
		expect(notesStore.has("inbox/new.md")).toBe(false);
		await client.close();
	});

	describe("update_frontmatter", () => {
		it("set adds or updates a scalar field", async () => {
			const client = await mcpClient("claude-full");
			notesStore.set("inbox/idea.md", "---\nstatus: draft\n---\n# Idea\n\nbody\n");

			const r = await callTool(client, "update_frontmatter", {
				path: "inbox/idea.md",
				set: { priority: "high" },
			});
			expect(r.body).toEqual({ ok: true, path: "inbox/idea.md" });

			// Verify the field was added and other fields+body unchanged
			const read = await callTool(client, "read_note", { path: "inbox/idea.md" });
			expect(read.body.content).toContain("priority: high");
			expect(read.body.content).toContain("status: draft");
			expect(read.body.content).toContain("# Idea");
			expect(read.body.content).toContain("body");

			await client.close();
		});

		it("unset removes a field", async () => {
			const client = await mcpClient("claude-full");
			notesStore.set("inbox/idea.md", "---\nstatus: draft\npriority: high\n---\n# Idea\n\nbody\n");

			const r = await callTool(client, "update_frontmatter", {
				path: "inbox/idea.md",
				unset: ["status"],
			});
			expect(r.body).toEqual({ ok: true, path: "inbox/idea.md" });

			// Verify the field was removed but others remain
			const read = await callTool(client, "read_note", { path: "inbox/idea.md" });
			expect(read.body.content).not.toContain("status: draft");
			expect(read.body.content).toContain("priority: high");
			expect(read.body.content).toContain("# Idea");

			await client.close();
		});

		it("listAdd adds a tag without duplication", async () => {
			const client = await mcpClient("claude-full");
			notesStore.set("inbox/idea.md", "---\ntags: [planning]\n---\n# Idea\n\nbody\n");

			// Add a new tag
			const r1 = await callTool(client, "update_frontmatter", {
				path: "inbox/idea.md",
				listAdd: { field: "tags", items: ["review"] },
			});
			expect(r1.body).toEqual({ ok: true, path: "inbox/idea.md" });

			let read = await callTool(client, "read_note", { path: "inbox/idea.md" });
			expect(read.body.content).toContain("tags:");
			expect(read.body.content).toContain("planning");
			expect(read.body.content).toContain("review");

			// Add an existing tag (should not duplicate)
			const r2 = await callTool(client, "update_frontmatter", {
				path: "inbox/idea.md",
				listAdd: { field: "tags", items: ["planning"] },
			});
			expect(r2.body).toEqual({ ok: true, path: "inbox/idea.md" });

			read = await callTool(client, "read_note", { path: "inbox/idea.md" });
			const content = read.body.content;
			// Count occurrences of "planning" in the frontmatter (before the closing ---)
			const fmEnd = content.indexOf("---\n# Idea");
			const fm = content.slice(0, fmEnd);
			const planningCount = (fm.match(/planning/g) || []).length;
			expect(planningCount).toBe(1); // No duplication

			await client.close();
		});

		it("listRemove removes a tag", async () => {
			const client = await mcpClient("claude-full");
			notesStore.set("inbox/idea.md", "---\ntags: [planning, review, done]\n---\n# Idea\n\nbody\n");

			const r = await callTool(client, "update_frontmatter", {
				path: "inbox/idea.md",
				listRemove: { field: "tags", items: ["review"] },
			});
			expect(r.body).toEqual({ ok: true, path: "inbox/idea.md" });

			const read = await callTool(client, "read_note", { path: "inbox/idea.md" });
			expect(read.body.content).toContain("planning");
			expect(read.body.content).not.toContain("review");
			expect(read.body.content).toContain("done");

			await client.close();
		});

		it("fenced key errors when targeting a path outside its fence", async () => {
			const client = await mcpClient("fenced");
			// The fenced token is scoped to "fenced-zone" folder (from the test setup)
			// inbox/idea.md is outside that scope
			notesStore.set("inbox/idea.md", "---\nstatus: draft\n---\n# Idea\n\nbody\n");

			const r = await callTool(client, "update_frontmatter", {
				path: "inbox/idea.md",
				set: { priority: "high" },
			});
			expect(r.result.isError).toBe(true);

			// Verify the note was not modified
			const content = notesStore.get("inbox/idea.md")!;
			expect(content).not.toContain("priority: high");
			expect(content).toContain("status: draft");

			await client.close();
		});

		it("errors when the note does not exist", async () => {
			const client = await mcpClient("claude-full");

			const r = await callTool(client, "update_frontmatter", {
				path: "inbox/nonexistent.md",
				set: { status: "archived" },
			});
			expect(r.result.isError).toBe(true);

			await client.close();
		});

		it("errors when no operations are provided", async () => {
			const client = await mcpClient("claude-full");
			notesStore.set("inbox/idea.md", "---\nstatus: draft\n---\n# Idea\n\nbody\n");

			const r = await callTool(client, "update_frontmatter", {
				path: "inbox/idea.md",
			});
			expect(r.result.isError).toBe(true);

			await client.close();
		});
	});
});

describe("provenance stamping", () => {
	const PORT_PROV = 27982;
	const BASE_PROV = `http://127.0.0.1:${PORT_PROV}`;

	let serverProv: AnnotatedMcpServer;
	let storageProv: InMemoryStorageAdapter;
	let notesStoreProv: Map<string, string>;

	function buildNotesProv(): NoteAccess {
		notesStoreProv = new Map();
		return {
			exists: async (p) => notesStoreProv.has(p),
			read: async (p) => {
				const c = notesStoreProv.get(p);
				if (c === undefined) throw new Error(`ENOENT ${p}`);
				return c;
			},
			write: async (p, content) => void notesStoreProv.set(p, content),
			mkdir: async () => {},
			listCommentedNotePaths: async () => {
				const suffix = ".comments.json";
				return [...storageProv.files.keys()]
					.filter((p) => p.endsWith(suffix))
					.map((p) => p.slice(0, -suffix.length));
			},
		};
	}

	async function mcpClientProv(token: string): Promise<Client> {
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${BASE_PROV}/mcp`), {
				requestInit: { headers: { Authorization: `Bearer ${token}` } },
			}),
		);
		return client;
	}

	beforeAll(async () => {
		storageProv = new InMemoryStorageAdapter();
		const storeProv = new CommentStore(storageProv, { createdBy: "test@0.0.0" });
		const keys: KeyRecord[] = [
			{ tokenHash: await hashToken("claude-full"), identityId: "i_claude", scope: "full" },
		];
		serverProv = new AnnotatedMcpServer(
			{
				store: storeProv,
				notes: buildNotesProv(),
				auth: { getIdentities: () => [claude], getKeys: () => keys },
				info: { vaultName: "test-vault", pluginVersion: "0.0.0-test" },
				provenance: { now: () => "2099-06-13" },
			},
			{ port: PORT_PROV, host: "127.0.0.1" },
		);
		await serverProv.start();
	});

	afterAll(async () => {
		await serverProv.stop();
	});

	it("create_note stamps created, createdBy, updated, updatedBy in frontmatter", async () => {
		const client = await mcpClientProv("claude-full");

		const created = await callTool(client, "create_note", {
			path: "test.md",
			content: "# Test Note\n\nBody content",
		});
		expect(created.body).toEqual({ ok: true, path: "test.md" });

		const read = await callTool(client, "read_note", { path: "test.md" });
		const content = read.body.content;

		// Check that all four fields are present
		expect(content).toContain("created: 2099-06-13");
		expect(content).toContain("createdBy: Claude <i_claude>");
		expect(content).toContain("updated: 2099-06-13");
		expect(content).toContain("updatedBy: Claude <i_claude>");

		// Body should be preserved
		expect(content).toContain("# Test Note");
		expect(content).toContain("Body content");

		await client.close();
	});

	it("append_note respects write-once on created fields and updates updated/updatedBy", async () => {
		const client = await mcpClientProv("claude-full");

		// Create a note with explicit created timestamp
		notesStoreProv.set("existing.md", "---\ncreated: 2000-01-01\ncreatedBy: Bob <bob@example.com>\n---\n# Existing\n\nOld body");

		const appended = await callTool(client, "append_note", {
			path: "existing.md",
			content: "## New Entry\n\nAppended content",
		});
		expect(appended.body).toEqual({ ok: true, path: "existing.md", appended: "## New Entry\n\nAppended content".length });

		const read = await callTool(client, "read_note", { path: "existing.md" });
		const content = read.body.content;

		// Created fields should remain unchanged (write-once)
		expect(content).toContain("created: 2000-01-01");
		expect(content).toContain("createdBy: Bob <bob@example.com>");

		// Updated fields should be refreshed
		expect(content).toContain("updated: 2099-06-13");
		expect(content).toContain("updatedBy: Claude <i_claude>");

		// Original and appended content should both be present
		expect(content).toContain("# Existing");
		expect(content).toContain("Old body");
		expect(content).toContain("## New Entry");
		expect(content).toContain("Appended content");

		await client.close();
	});

	it("update_frontmatter stamps updated/updatedBy", async () => {
		const client = await mcpClientProv("claude-full");

		notesStoreProv.set("fields.md", "---\nstatus: draft\n---\n# Note\n\nBody");

		const updated = await callTool(client, "update_frontmatter", {
			path: "fields.md",
			set: { priority: "high" },
		});
		expect(updated.body).toEqual({ ok: true, path: "fields.md" });

		const read = await callTool(client, "read_note", { path: "fields.md" });
		const content = read.body.content;

		// New fields from the call
		expect(content).toContain("priority: high");
		expect(content).toContain("status: draft");

		// Provenance stamps
		expect(content).toContain("updated: 2099-06-13");
		expect(content).toContain("updatedBy: Claude <i_claude>");

		// Body unchanged
		expect(content).toContain("# Note");
		expect(content).toContain("Body");

		await client.close();
	});

	it("patch_note stamps updated/updatedBy", async () => {
		const client = await mcpClientProv("claude-full");

		notesStoreProv.set("patch.md", "---\nauthor: Alice\n---\n# Patch Test\n\nOld text here");

		const patched = await callTool(client, "patch_note", {
			path: "patch.md",
			oldString: "Old text",
			newString: "New text",
		});
		expect(patched.body).toEqual({ ok: true, replacements: 1 });

		const read = await callTool(client, "read_note", { path: "patch.md" });
		const content = read.body.content;

		// Provenance stamps should be added
		expect(content).toContain("updated: 2099-06-13");
		expect(content).toContain("updatedBy: Claude <i_claude>");

		// Original field and patched content
		expect(content).toContain("author: Alice");
		expect(content).toContain("New text here");
		expect(content).not.toContain("Old text");

		await client.close();
	});
});

