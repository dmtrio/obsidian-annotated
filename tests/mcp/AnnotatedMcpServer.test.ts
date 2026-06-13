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
});
