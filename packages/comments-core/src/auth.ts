// Auth contract (PLN Decisions 4/4b): identities are first-class attribution
// labels (synced with the vault); bearer keys are instance-local secrets, each
// bound to exactly one identity with a scope. Author is always derived from
// the authenticated key — never client-supplied. This module is pure logic;
// where identities/keys are stored (data.json vs device-local vs env) is the
// host's concern.

import { pathInScope } from "./actionableQuery";

export type KeyScope = "poll" | "additive" | "destructive" | "full" | "watch";

export type Tier = "poll" | "additive" | "destructive";

export const TIER_ORDER: Record<Tier, number> = { poll: 0, additive: 1, destructive: 2 };

/** Map any stored/legacy scope string to a capability tier. Unknown ⇒ poll (safest floor). */
export function normalizeScope(raw: string): Tier {
	switch (raw) {
		case "destructive": return "destructive";
		case "additive":
		case "full": return "additive";
		case "poll":
		case "watch": return "poll";
		default: return "poll";
	}
}

/** Does this stored scope grant at least `minTier`? */
export function tierAllows(scope: string, minTier: Tier): boolean {
	return TIER_ORDER[normalizeScope(scope)] >= TIER_ORDER[minTier];
}

export interface Identity {
	/** Random, immutable. Concurrent creation on synced replicas can't collide. */
	id: string;
	/** Display name stamped (with the id) into comment author fields. Renameable. */
	name: string;
}

export interface KeyRecord {
	/** sha256 hex of the bearer token. The token itself is never stored. */
	tokenHash: string;
	identityId: string;
	scope: KeyScope;
	/** Optional human label for the settings UI ("agent watch key"). */
	label?: string;
	/** Keys minted together (full + watch) share a pairId; revoked together in the UI. */
	pairId?: string;
	/**
	 * Optional folder fence: vault-relative folder (or note) prefixes this key
	 * may see and touch. Empty/absent = whole vault. Orthogonal to `scope`
	 * (which gates tools, not paths).
	 */
	pathScope?: string[];
}

/** The two server surfaces a key can be authorized for. */
export type Surface = "mcp" | "actionable";

export type AuthFailureReason = "missing_token" | "unknown_key" | "orphaned_key";

export type AuthResult =
	| { ok: true; key: KeyRecord; identity: Identity }
	| { ok: false; reason: AuthFailureReason };

export function generateIdentityId(): string {
	return "i_" + crypto.randomUUID();
}

/** Extract the token from an Authorization header value, or null. */
export function bearerToken(headerValue: string | undefined | null): string | null {
	if (!headerValue) return null;
	const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
	return match ? match[1] : null;
}

/** sha256 hex digest of a token. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Constant-time comparison of two equal-purpose hex digests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Resolve a bearer token to its key + identity.
 * - The token is hashed once and compared against every key (no early exit).
 * - A key whose identity id no longer exists is invalid ("orphaned" — the
 *   identity was deleted, possibly on another instance; deletion doubles as
 *   soft revocation).
 */
export async function authenticate(
	token: string | undefined | null,
	keys: KeyRecord[],
	identities: Identity[],
): Promise<AuthResult> {
	if (!token) return { ok: false, reason: "missing_token" };

	const tokenHash = await hashToken(token);
	let matched: KeyRecord | null = null;
	for (const key of keys) {
		if (timingSafeEqualHex(tokenHash, key.tokenHash)) {
			matched = key;
		}
	}
	if (!matched) return { ok: false, reason: "unknown_key" };

	const identity = identities.find((i) => i.id === matched!.identityId);
	if (!identity) return { ok: false, reason: "orphaned_key" };

	return { ok: true, key: matched, identity };
}

/** Every authenticated tier (>= poll) may reach both HTTP surfaces; MCP tools are gated individually by minTier at registration. */
export function canAccess(_scope: KeyScope, _surface: Surface): boolean {
	return true;
}

/**
 * HTTP status for an auth outcome on a surface:
 * 401 bad/missing/orphaned key, 403 valid key on a surface its scope doesn't
 * cover, 200 otherwise. (404-the-rest is routing, not auth.)
 */
export function authHttpStatus(result: AuthResult, surface: Surface): 200 | 401 | 403 {
	if (!result.ok) return 401;
	if (!canAccess(result.key.scope, surface)) return 403;
	return 200;
}

/** May this key touch this note? (Folder fence; tool gating is canAccess.) */
export function keyAllowsPath(key: KeyRecord, notePath: string): boolean {
	if (!key.pathScope || key.pathScope.length === 0) return true;
	return key.pathScope.some((scope) => pathInScope(notePath, scope));
}

export type ScopeResolution =
	| { ok: true; scopes: string[] | undefined } // undefined = whole vault
	| { ok: false };

/**
 * Intersect a requested query scope with the key's folder fence.
 * - Unfenced key: the request passes through.
 * - Fenced key, no request: clamp to the fence.
 * - Fenced key, request inside the fence: the request.
 * - Fenced key, request outside: refusal — loud beats silently empty.
 */
export function resolveQueryScope(
	requested: string | undefined,
	key: KeyRecord,
): ScopeResolution {
	const fence = key.pathScope?.filter((s) => s.replace(/^\/+|\/+$/g, "") !== "");
	if (!fence || fence.length === 0) {
		return { ok: true, scopes: requested ? [requested] : undefined };
	}
	if (!requested || requested.replace(/^\/+|\/+$/g, "") === "") {
		return { ok: true, scopes: fence };
	}
	const normalized = requested.replace(/^\/+|\/+$/g, "");
	const within = fence.some((scope) => pathInScope(normalized, scope));
	return within ? { ok: true, scopes: [normalized] } : { ok: false };
}

/**
 * The watch surface defaults exclusion to the caller's own identity — a
 * watcher excludes itself by construction. An explicit list overrides.
 */
export function effectiveExcludeAuthors(
	requested: string[] | undefined,
	callerIdentity: Identity,
): string[] {
	return requested && requested.length > 0 ? requested : [callerIdentity.name];
}
