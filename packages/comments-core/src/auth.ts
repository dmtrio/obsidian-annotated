// Auth contract (PLN Decisions 4/4b): identities are first-class attribution
// labels (synced with the vault); bearer keys are instance-local secrets, each
// bound to exactly one identity with a scope. Author is always derived from
// the authenticated key — never client-supplied. This module is pure logic;
// where identities/keys are stored (data.json vs device-local vs env) is the
// host's concern.

export type KeyScope = "full" | "watch";

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

/** full → everything; watch → the actionable route only. */
export function canAccess(scope: KeyScope, surface: Surface): boolean {
	return scope === "full" || surface === "actionable";
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
