import { describe, it, expect } from "vitest";
import {
	authenticate,
	authHttpStatus,
	bearerToken,
	canAccess,
	effectiveExcludeAuthors,
	generateIdentityId,
	hashToken,
	keyAllowsPath,
	resolveQueryScope,
	timingSafeEqualHex,
	AuthResult,
	Identity,
	KeyRecord,
} from "../src/auth";

const deme: Identity = { id: "i_deme", name: "Deme" };
const claude: Identity = { id: "i_claude", name: "Claude" };
const identities = [deme, claude];

async function makeKeys(): Promise<{ fullKey: KeyRecord; watchKey: KeyRecord; orphanKey: KeyRecord }> {
	return {
		fullKey: { tokenHash: await hashToken("full-token"), identityId: "i_claude", scope: "full" },
		watchKey: { tokenHash: await hashToken("watch-token"), identityId: "i_claude", scope: "watch" },
		orphanKey: { tokenHash: await hashToken("orphan-token"), identityId: "i_deleted", scope: "full" },
	};
}

describe("token plumbing", () => {
	it("bearerToken extracts from a well-formed header, case-insensitively", () => {
		expect(bearerToken("Bearer abc123")).toBe("abc123");
		expect(bearerToken("bearer abc123")).toBe("abc123");
		expect(bearerToken("  Bearer   abc123  ")).toBe("abc123");
	});

	it("bearerToken rejects malformed headers", () => {
		expect(bearerToken(undefined)).toBeNull();
		expect(bearerToken("")).toBeNull();
		expect(bearerToken("abc123")).toBeNull();
		expect(bearerToken("Basic abc123")).toBeNull();
		expect(bearerToken("Bearer")).toBeNull();
	});

	it("hashToken is deterministic sha256 hex", async () => {
		const h1 = await hashToken("secret");
		const h2 = await hashToken("secret");
		expect(h1).toBe(h2);
		expect(h1).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashToken("other")).not.toBe(h1);
	});

	it("timingSafeEqualHex compares correctly", () => {
		expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
		expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
		expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
	});

	it("generateIdentityId returns prefixed unique ids", () => {
		const a = generateIdentityId();
		const b = generateIdentityId();
		expect(a).toMatch(/^i_/);
		expect(a).not.toBe(b);
	});
});

describe("authenticate", () => {
	it("resolves a valid token to its key and identity", async () => {
		const { fullKey, watchKey } = await makeKeys();
		const result = await authenticate("full-token", [fullKey, watchKey], identities);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.key.scope).toBe("full");
			expect(result.identity.name).toBe("Claude");
		}
	});

	it("rejects a missing token", async () => {
		const { fullKey } = await makeKeys();
		const result = await authenticate(null, [fullKey], identities);
		expect(result).toEqual({ ok: false, reason: "missing_token" });
	});

	it("rejects an unknown token", async () => {
		const { fullKey } = await makeKeys();
		const result = await authenticate("wrong-token", [fullKey], identities);
		expect(result).toEqual({ ok: false, reason: "unknown_key" });
	});

	it("rejects a key whose identity was deleted (orphaned = soft revocation)", async () => {
		const { orphanKey } = await makeKeys();
		const result = await authenticate("orphan-token", [orphanKey], identities);
		expect(result).toEqual({ ok: false, reason: "orphaned_key" });
	});

	it("two keys can share one identity (full + watch pair)", async () => {
		const { fullKey, watchKey } = await makeKeys();
		const viaFull = await authenticate("full-token", [fullKey, watchKey], identities);
		const viaWatch = await authenticate("watch-token", [fullKey, watchKey], identities);
		expect(viaFull.ok && viaWatch.ok).toBe(true);
		if (viaFull.ok && viaWatch.ok) {
			expect(viaFull.identity.id).toBe(viaWatch.identity.id);
		}
	});
});

describe("authorization matrix (the rejection matrix)", () => {
	it("full key: all surfaces", () => {
		expect(canAccess("full", "mcp")).toBe(true);
		expect(canAccess("full", "actionable")).toBe(true);
	});

	it("watch key: actionable only", () => {
		expect(canAccess("watch", "actionable")).toBe(true);
		expect(canAccess("watch", "mcp")).toBe(false);
	});

	it("maps to HTTP statuses: 401 bad/missing/orphaned, 403 watch-on-mcp, 200 otherwise", async () => {
		const { fullKey, watchKey, orphanKey } = await makeKeys();
		const keys = [fullKey, watchKey, orphanKey];

		const cases: Array<[string | null, "mcp" | "actionable", number]> = [
			[null, "mcp", 401],
			["wrong", "mcp", 401],
			["orphan-token", "mcp", 401],
			["watch-token", "mcp", 403],
			["watch-token", "actionable", 200],
			["full-token", "mcp", 200],
			["full-token", "actionable", 200],
		];

		for (const [token, surface, expected] of cases) {
			const result: AuthResult = await authenticate(token, keys, identities);
			expect(authHttpStatus(result, surface), `${token} on ${surface}`).toBe(expected);
		}
	});
});

describe("folder fence (pathScope)", () => {
	const fenced: KeyRecord = {
		tokenHash: "h",
		identityId: "i_claude",
		scope: "full",
		pathScope: ["Projects", "inbox/agent.md"],
	};
	const unfenced: KeyRecord = { tokenHash: "h", identityId: "i_claude", scope: "full" };

	it("keyAllowsPath: unfenced key sees everything", () => {
		expect(keyAllowsPath(unfenced, "anywhere/note.md")).toBe(true);
	});

	it("keyAllowsPath: fenced key sees inside the fence only", () => {
		expect(keyAllowsPath(fenced, "Projects/x.md")).toBe(true);
		expect(keyAllowsPath(fenced, "Projects/sub/y.md")).toBe(true);
		expect(keyAllowsPath(fenced, "inbox/agent.md")).toBe(true);
		expect(keyAllowsPath(fenced, "inbox/other.md")).toBe(false);
		expect(keyAllowsPath(fenced, "ProjectsArchive/z.md")).toBe(false);
	});

	it("resolveQueryScope: unfenced key passes the request through", () => {
		expect(resolveQueryScope("inbox", unfenced)).toEqual({ ok: true, scopes: ["inbox"] });
		expect(resolveQueryScope(undefined, unfenced)).toEqual({ ok: true, scopes: undefined });
	});

	it("resolveQueryScope: fenced key with no request clamps to the fence", () => {
		expect(resolveQueryScope(undefined, fenced)).toEqual({
			ok: true,
			scopes: ["Projects", "inbox/agent.md"],
		});
		expect(resolveQueryScope("", fenced)).toEqual({
			ok: true,
			scopes: ["Projects", "inbox/agent.md"],
		});
	});

	it("resolveQueryScope: request inside the fence passes; outside is refused", () => {
		expect(resolveQueryScope("Projects/sub", fenced)).toEqual({
			ok: true,
			scopes: ["Projects/sub"],
		});
		expect(resolveQueryScope("other", fenced)).toEqual({ ok: false });
		// A parent of the fence is refused too (no implicit widening)
		expect(resolveQueryScope("inbox", fenced)).toEqual({ ok: false });
	});
});

describe("effectiveExcludeAuthors", () => {
	it("defaults to the caller's own identity (watcher excludes itself by construction)", () => {
		expect(effectiveExcludeAuthors(undefined, claude)).toEqual(["Claude"]);
		expect(effectiveExcludeAuthors([], claude)).toEqual(["Claude"]);
	});

	it("an explicit list overrides the default", () => {
		expect(effectiveExcludeAuthors(["Deme", "bot"], claude)).toEqual(["Deme", "bot"]);
	});
});
