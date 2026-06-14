/**
 * Test suite for the OAuth gate: authorization server metadata, dynamic client
 * registration, authorization flow (PKCE), token exchange, and security boundaries.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import { createHash, randomBytes } from "crypto";
import { buildOAuthGate, wwwAuthenticate, LOGIN_PATH } from "../../server/OAuthGate";

const PORT = 27983;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server: Server;
let clients: any[] = [];

function pkcePair() {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

async function registerClient(clientName = "test-client"): Promise<any> {
	const res = await fetch(`${BASE_URL}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			redirect_uris: ["http://127.0.0.1:9999/callback"],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code"],
			response_types: ["code"],
			client_name: clientName,
		}),
	});
	expect([200, 201]).toContain(res.status);
	return await res.json();
}

async function login(
	clientId: string,
	redirectUri: string,
	challenge: string,
	key: string,
	state: string,
): Promise<Response> {
	const params = new URLSearchParams();
	params.set("key", key);
	params.set("client_id", clientId);
	params.set("redirect_uri", redirectUri);
	params.set("code_challenge", challenge);
	params.set("state", state);

	return await fetch(`${BASE_URL}${LOGIN_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
		redirect: "manual",
	});
}

async function token(
	grantType: string,
	code: string,
	verifier: string,
	clientId: string,
	redirectUri: string,
): Promise<Response> {
	const params = new URLSearchParams();
	params.set("grant_type", grantType);
	params.set("code", code);
	params.set("code_verifier", verifier);
	params.set("client_id", clientId);
	params.set("redirect_uri", redirectUri);

	return await fetch(`${BASE_URL}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});
}

beforeAll(async () => {
	const gate = buildOAuthGate({
		verifyKey: async (t: string) =>
			t === "good-key"
				? { identityName: "Claude", scope: "full" }
				: null,
		loadClients: () => clients,
		saveClients: (c: any[]) => {
			clients = c;
		},
		issuerUrl: BASE_URL,
		serverName: "Annotated Test",
	});

	server = createServer(gate.handler);
	await new Promise<void>((resolve) => {
		server.listen(PORT, "127.0.0.1", resolve);
	});
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
});

describe("serves authorization server metadata", () => {
	it("GET /.well-known/oauth-authorization-server → 200 with endpoints", async () => {
		const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(typeof json.authorization_endpoint).toBe("string");
		expect(typeof json.token_endpoint).toBe("string");
		expect(typeof json.registration_endpoint).toBe("string");
	});
});

describe("serves protected resource metadata", () => {
	it("GET /.well-known/oauth-protected-resource → 200", async () => {
		const res = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource`);
		expect(res.status).toBe(200);
	});
});

describe("registers a client dynamically and persists it", () => {
	it("registers client and persists in local array", async () => {
		const initialCount = clients.length;
		const registered = await registerClient("test-client-1");
		expect(typeof registered.client_id).toBe("string");
		expect(clients.length).toBe(initialCount + 1);
		expect(clients.some((c) => c.client_id === registered.client_id)).toBe(true);
	});
});

describe("authorize renders the paste-key form", () => {
	it("GET /authorize with valid params renders HTML form", async () => {
		const reg = await registerClient("test-client-2");
		const { challenge } = pkcePair();

		const res = await fetch(
			`${BASE_URL}/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/callback")}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz123`,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(res.headers.get("content-type") ?? "").toContain("text/html");
		expect(html).toContain(LOGIN_PATH);
		expect(html).toContain("xyz123");
	});
});

describe("full happy path: login → code → PKCE exchange → token is the key", () => {
	it("login with good-key → code → exchange with correct verifier → access_token", async () => {
		const reg = await registerClient("test-client-3");
		const pkce = pkcePair();
		const state = "happy-path-state-123";

		// Login with good-key
		const loginRes = await login(
			reg.client_id,
			"http://127.0.0.1:9999/callback",
			pkce.challenge,
			"good-key",
			state,
		);
		expect(loginRes.status).toBe(302);
		const location = loginRes.headers.get("location");
		expect(location).toBeDefined();
		const locationUrl = new URL(location!);
		expect(locationUrl.origin).toBe("http://127.0.0.1:9999");
		expect(locationUrl.pathname).toBe("/callback");
		expect(locationUrl.searchParams.get("state")).toBe(state);
		const code = locationUrl.searchParams.get("code");
		expect(code).toBeDefined();

		// Exchange code for token
		const tokenRes = await token(
			"authorization_code",
			code!,
			pkce.verifier,
			reg.client_id,
			"http://127.0.0.1:9999/callback",
		);
		expect(tokenRes.status).toBe(200);
		const tokenJson = await tokenRes.json();
		expect(tokenJson.access_token).toBe("good-key");
		expect(tokenJson.token_type).toBe("bearer");
	});
});

describe("wrong PKCE verifier is rejected", () => {
	it("exchange with different verifier → status >= 400", async () => {
		const reg = await registerClient("test-client-4");
		const pkce = pkcePair();
		const wrongPkce = pkcePair();

		// Login with good-key
		const loginRes = await login(
			reg.client_id,
			"http://127.0.0.1:9999/callback",
			pkce.challenge,
			"good-key",
			"wrong-verifier-test",
		);
		expect(loginRes.status).toBe(302);
		const location = loginRes.headers.get("location");
		const code = new URL(location!).searchParams.get("code");

		// Try to exchange with a different verifier
		const tokenRes = await token(
			"authorization_code",
			code!,
			wrongPkce.verifier,
			reg.client_id,
			"http://127.0.0.1:9999/callback",
		);
		expect(tokenRes.status).toBeGreaterThanOrEqual(400);
	});
});

describe("a consumed code cannot be reused", () => {
	it("exchange once (200), reuse same code → status >= 400", async () => {
		const reg = await registerClient("test-client-5");
		const pkce = pkcePair();

		// Login and get code
		const loginRes = await login(
			reg.client_id,
			"http://127.0.0.1:9999/callback",
			pkce.challenge,
			"good-key",
			"reuse-test",
		);
		const location = loginRes.headers.get("location");
		const code = new URL(location!).searchParams.get("code");

		// First exchange: should succeed
		const tokenRes1 = await token(
			"authorization_code",
			code!,
			pkce.verifier,
			reg.client_id,
			"http://127.0.0.1:9999/callback",
		);
		expect(tokenRes1.status).toBe(200);

		// Second exchange with same code: should fail
		const tokenRes2 = await token(
			"authorization_code",
			code!,
			pkce.verifier,
			reg.client_id,
			"http://127.0.0.1:9999/callback",
		);
		expect(tokenRes2.status).toBeGreaterThanOrEqual(400);
	});
});

describe("invalid key re-renders the form without echoing the key", () => {
	it("login with wrong key → 200 html, no key in body", async () => {
		const reg = await registerClient("test-client-6");
		const { challenge } = pkcePair();

		const loginRes = await login(
			reg.client_id,
			"http://127.0.0.1:9999/callback",
			challenge,
			"super-secret-wrong",
			"invalid-key-test",
		);
		expect(loginRes.status).toBe(200);
		const html = await loginRes.text();
		expect(html).not.toContain("super-secret-wrong");
	});
});

describe("unregistered redirect_uri is refused", () => {
	it("login with unregistered redirect_uri → 400, no Location header", async () => {
		const reg = await registerClient("test-client-7");
		const { challenge } = pkcePair();

		const loginRes = await login(
			reg.client_id,
			"http://evil.example/cb",
			challenge,
			"good-key",
			"unregistered-uri-test",
		);
		expect(loginRes.status).toBe(400);
		expect(loginRes.headers.get("location")).toBeNull();
	});
});

describe("wwwAuthenticate points at the resource metadata", () => {
	it("wwwAuthenticate formats Bearer challenge correctly", () => {
		const result = wwwAuthenticate("http://x.test/");
		expect(result).toBe(
			'Bearer resource_metadata="http://x.test/.well-known/oauth-protected-resource"',
		);
	});
});
