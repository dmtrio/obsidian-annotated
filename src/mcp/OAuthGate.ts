/**
 * PLN — MCP OAuth Shim (D1/D2): SDK handles protocol + PKCE; the token IS an
 * existing Annotated key. This file's only hand-written surface is the login
 * form + code store. Clients (claude.ai) exchange a pasted key for an OAuth
 * access token that persists across sessions.
 */
import express from "express";
import type { Response } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface VerifiedKey {
	identityName: string;
	scope: "full" | "watch";
}

export interface OAuthGateDeps {
	/** Resolve a pasted access key. Null = invalid. Never log the key. */
	verifyKey(token: string): Promise<VerifiedKey | null>;
	/** Device-local persistence for dynamically registered OAuth clients. */
	loadClients(): OAuthClientInformationFull[];
	saveClients(clients: OAuthClientInformationFull[]): void;
	/** Public base URL of this server, e.g. "https://mcp-obsidian.dmetr.io" or "http://127.0.0.1:27191". */
	issuerUrl: string;
	serverName: string;
	onLog?: (message: string) => void;
}

export const LOGIN_PATH = "/oauth/annotated-login";

/**
 * Value for the WWW-Authenticate header on 401s so clients can discover OAuth.
 */
export function wwwAuthenticate(issuerUrl: string): string {
	const baseUrl = issuerUrl.endsWith("/") ? issuerUrl.slice(0, -1) : issuerUrl;
	return `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
}

function escapeHtml(text: string): string {
	const map: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	};
	return text.replace(/[&<>"']/g, (char) => map[char]);
}

interface CodeEntry {
	key: string;
	codeChallenge: string;
	clientId: string;
	redirectUri: string;
	state?: string;
	expiresAt: number;
}

const codeStore = new Map<string, CodeEntry>();

function purgeExpiredCodes(): void {
	const now = Date.now();
	for (const [code, entry] of codeStore.entries()) {
		if (entry.expiresAt <= now) {
			codeStore.delete(code);
		}
	}
}

export function buildOAuthGate(deps: OAuthGateDeps): { handler: express.Express } {
	const app = express();
	app.use(express.urlencoded({ extended: false }));

	const store: OAuthRegisteredClientsStore = {
		getClient: (clientId: string) => {
			const clients = deps.loadClients();
			return clients.find((c) => c.client_id === clientId);
		},
		registerClient: async (clientInfo) => {
			const clientId = "anncli_" + crypto.randomUUID();
			const clientIdIssuedAt = Math.floor(Date.now() / 1000);
			const full: OAuthClientInformationFull = {
				...clientInfo,
				client_id: clientId,
				client_id_issued_at: clientIdIssuedAt,
			};
			const clients = deps.loadClients();
			clients.push(full);
			deps.saveClients(clients);
			return full;
		},
	};

	const provider: OAuthServerProvider = {
		get clientsStore(): OAuthRegisteredClientsStore {
			return store;
		},

		async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
			const clientName = client.client_name ?? client.client_id;
			const serverName = escapeHtml(deps.serverName);
			const escapedClientName = escapeHtml(clientName);
			const html = `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Annotated OAuth Login</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			display: flex;
			justify-content: center;
			align-items: center;
			min-height: 100vh;
			padding: 20px;
		}
		.container {
			background: white;
			border-radius: 8px;
			box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
			padding: 40px;
			max-width: 400px;
			width: 100%;
		}
		h1 {
			font-size: 24px;
			margin-bottom: 8px;
			color: #333;
		}
		.subtitle {
			font-size: 14px;
			color: #666;
			margin-bottom: 30px;
		}
		.info {
			background: #f5f5f5;
			border-left: 4px solid #667eea;
			padding: 12px;
			margin-bottom: 20px;
			border-radius: 4px;
			font-size: 14px;
			color: #333;
		}
		.form-group {
			margin-bottom: 16px;
		}
		label {
			display: block;
			font-size: 14px;
			font-weight: 500;
			color: #333;
			margin-bottom: 6px;
		}
		input[type="password"],
		input[type="hidden"] {
			width: 100%;
			padding: 10px 12px;
			border: 1px solid #ddd;
			border-radius: 4px;
			font-size: 14px;
			font-family: monospace;
		}
		input[type="password"]:focus {
			outline: none;
			border-color: #667eea;
			box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
		}
		.button {
			width: 100%;
			padding: 12px;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			border: none;
			border-radius: 4px;
			font-size: 16px;
			font-weight: 600;
			cursor: pointer;
			transition: transform 0.2s, box-shadow 0.2s;
		}
		.button:hover {
			transform: translateY(-2px);
			box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
		}
		.button:active {
			transform: translateY(0);
		}
		.error {
			background: #fee;
			border: 1px solid #fcc;
			border-radius: 4px;
			color: #c33;
			padding: 12px;
			margin-bottom: 20px;
			font-size: 14px;
		}
	</style>
</head>
<body>
	<div class="container">
		<h1>${serverName}</h1>
		<p class="subtitle">${escapedClientName} is requesting access</p>
		<div class="info">
			Paste an Annotated access key to grant this app access.
		</div>
		<form method="POST" action="${escapeHtml(LOGIN_PATH)}">
			<div class="form-group">
				<label for="key">Access Key:</label>
				<input type="password" id="key" name="key" required autofocus>
			</div>
			<input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}">
			<input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
			<input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
			<input type="hidden" name="state" value="${escapeHtml(params.state ?? "")}">
			<button type="submit" class="button">Grant Access</button>
		</form>
	</div>
</body>
</html>`;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.status(200).send(html);
		},

		async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
			purgeExpiredCodes();
			const entry = codeStore.get(authorizationCode);
			if (!entry || entry.clientId !== client.client_id) {
				throw new Error("Unknown or expired authorization code");
			}
			return entry.codeChallenge;
		},

		async exchangeAuthorizationCode(
			client: OAuthClientInformationFull,
			authorizationCode: string,
			_codeVerifier?: string,
			redirectUri?: string,
			_resource?: URL,
		): Promise<OAuthTokens> {
			purgeExpiredCodes();
			const entry = codeStore.get(authorizationCode);
			if (!entry || entry.clientId !== client.client_id) {
				throw new Error("Unknown or expired authorization code");
			}
			if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
				throw new Error("redirect_uri mismatch");
			}
			codeStore.delete(authorizationCode);
			return {
				access_token: entry.key,
				token_type: "bearer",
			};
		},

		async exchangeRefreshToken(): Promise<OAuthTokens> {
			throw new Error("Refresh tokens are not supported");
		},

		async verifyAccessToken(token: string): Promise<AuthInfo> {
			const verified = await deps.verifyKey(token);
			if (!verified) {
				throw new Error("Invalid access token");
			}
			return {
				token,
				clientId: "annotated-key",
				scopes: ["annotated:" + verified.scope],
				extra: {
					identityName: verified.identityName,
				},
			};
		},

		async revokeToken(): Promise<void> {
			// No-op: revocation happens in the plugin's key UI.
		},
	};

	// Helper to render authorize form with error
	function renderAuthorizeWithError(
		client: OAuthClientInformationFull,
		params: AuthorizationParams,
		errorMessage: string,
	): string {
		const clientName = client.client_name ?? client.client_id;
		const serverName = escapeHtml(deps.serverName);
		const escapedClientName = escapeHtml(clientName);
		const escapedError = escapeHtml(errorMessage);
		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Annotated OAuth Login</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			display: flex;
			justify-content: center;
			align-items: center;
			min-height: 100vh;
			padding: 20px;
		}
		.container {
			background: white;
			border-radius: 8px;
			box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
			padding: 40px;
			max-width: 400px;
			width: 100%;
		}
		h1 {
			font-size: 24px;
			margin-bottom: 8px;
			color: #333;
		}
		.subtitle {
			font-size: 14px;
			color: #666;
			margin-bottom: 30px;
		}
		.info {
			background: #f5f5f5;
			border-left: 4px solid #667eea;
			padding: 12px;
			margin-bottom: 20px;
			border-radius: 4px;
			font-size: 14px;
			color: #333;
		}
		.form-group {
			margin-bottom: 16px;
		}
		label {
			display: block;
			font-size: 14px;
			font-weight: 500;
			color: #333;
			margin-bottom: 6px;
		}
		input[type="password"],
		input[type="hidden"] {
			width: 100%;
			padding: 10px 12px;
			border: 1px solid #ddd;
			border-radius: 4px;
			font-size: 14px;
			font-family: monospace;
		}
		input[type="password"]:focus {
			outline: none;
			border-color: #667eea;
			box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
		}
		.button {
			width: 100%;
			padding: 12px;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			border: none;
			border-radius: 4px;
			font-size: 16px;
			font-weight: 600;
			cursor: pointer;
			transition: transform 0.2s, box-shadow 0.2s;
		}
		.button:hover {
			transform: translateY(-2px);
			box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
		}
		.button:active {
			transform: translateY(0);
		}
		.error {
			background: #fee;
			border: 1px solid #fcc;
			border-radius: 4px;
			color: #c33;
			padding: 12px;
			margin-bottom: 20px;
			font-size: 14px;
		}
	</style>
</head>
<body>
	<div class="container">
		<h1>${serverName}</h1>
		<p class="subtitle">${escapedClientName} is requesting access</p>
		<div class="error">That key was not accepted — check it and try again.</div>
		<div class="info">
			Paste an Annotated access key to grant this app access.
		</div>
		<form method="POST" action="${escapeHtml(LOGIN_PATH)}">
			<div class="form-group">
				<label for="key">Access Key:</label>
				<input type="password" id="key" name="key" required autofocus>
			</div>
			<input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}">
			<input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
			<input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
			<input type="hidden" name="state" value="${escapeHtml(params.state ?? "")}">
			<button type="submit" class="button">Grant Access</button>
		</form>
	</div>
</body>
</html>`;
	}

	// POST /oauth/annotated-login
	app.post(LOGIN_PATH, async (req, res) => {
		try {
			const key = req.body.key;
			const clientId = req.body.client_id;
			const redirectUri = req.body.redirect_uri;
			const codeChallenge = req.body.code_challenge;
			const state = req.body.state;

			// Validate required parameters
			if (!key || !clientId || !redirectUri || !codeChallenge) {
				res.status(400).json({ error: "invalid_request" });
				return;
			}

			// Look up client
			const client = await store.getClient(clientId);
			if (!client) {
				res.status(400).json({ error: "invalid_client" });
				return;
			}

			// Validate redirect_uri against registered URIs
			if (!client.redirect_uris || !client.redirect_uris.includes(redirectUri)) {
				res.status(400).json({ error: "invalid_redirect_uri" });
				return;
			}

			// Verify the key
			const verified = await deps.verifyKey(key);
			if (!verified) {
				// Re-render the authorize form with error message
				const errorForm = renderAuthorizeWithError(
					client,
					{ redirectUri, codeChallenge, state: state || undefined },
					"",
				);
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.status(200).send(errorForm);
				return;
			}

			// Generate authorization code
			const code = "anncode_" + crypto.randomUUID();
			codeStore.set(code, {
				key,
				codeChallenge,
				clientId,
				redirectUri,
				state: state || undefined,
				expiresAt: Date.now() + 120_000,
			});

			// Log (generic message only, never log the key)
			deps.onLog?.(`oauth: code issued for client ${clientId}`);

			// Redirect with code
			const redirectUrl = new URL(redirectUri);
			redirectUrl.searchParams.set("code", code);
			if (state) {
				redirectUrl.searchParams.set("state", state);
			}

			res.redirect(302, redirectUrl.toString());
		} catch (err) {
			const message = err instanceof Error ? err.message : "Internal server error";
			res.status(500).json({ error: "server_error", error_description: message });
		}
	});

	// Mount the OAuth router
	const issuerUrl = new URL(deps.issuerUrl);
	app.use(
		mcpAuthRouter({
			provider,
			issuerUrl,
			scopesSupported: ["annotated:full", "annotated:watch"],
			resourceName: deps.serverName,
		}),
	);

	return { handler: app };
}
