/**
 * Plugin binding for AnnotatedMcpServer (PLN Decisions 4/4b).
 *
 * Storage split, per the livesync reality check (LOG 2026-06-12):
 * - Identity registry → plugin settings (data.json) — SYNCS between instances.
 * - Key table + bind host/port → Obsidian device-local storage — never syncs.
 * - Env override (ANNOTATED_MCP_KEYS / _PORT / _HOST) → headless container
 *   path; survives container rebuilds where device-local storage would not.
 */
import { App, Vault, prepareSimpleSearch } from "obsidian";
import {
	hashToken,
	readFrontmatter,
	pathInScope,
	type Identity,
	type KeyRecord,
	type KeyScope,
} from "@annotated/comments-core";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthProvider, NoteAccess, SearchHit } from "./AnnotatedMcpServer";

export const DEFAULT_MCP_PORT = 27191;
export const DEFAULT_MCP_HOST = "127.0.0.1";

const LOCAL_STORAGE_KEY = "annotated-mcp";

/**
 * Device-local key record: unlike the core KeyRecord (hash-only), the token
 * itself is kept so the settings UI can re-copy it. Acceptable here because
 * this store never syncs and is no more readable than the vault on the same
 * disk; the auth path still compares hashes only.
 */
export type DeviceKeyRecord = KeyRecord & { token?: string };

export interface DeviceLocalMcpConfig {
	enabled: boolean;
	port: number;
	host: string;
	keys: DeviceKeyRecord[];
	/**
	 * Which registry identity this device's human writes as (PLN step 6 /
	 * Decision 4b: the UI-default author is per-device, never synced).
	 */
	uiIdentityId?: string;
	/**
	 * OAuth gate sub-toggle (PLN — MCP OAuth Shim, D6). Default OFF: no
	 * metadata endpoints, no authorize page, no discovery surface.
	 */
	oauthEnabled?: boolean;
	/** Dynamically registered OAuth clients (D4) — device-local, no secrets worth syncing. */
	oauthClients?: OAuthClientInformationFull[];
}

const DEFAULT_DEVICE_CONFIG: DeviceLocalMcpConfig = {
	enabled: true,
	port: DEFAULT_MCP_PORT,
	host: DEFAULT_MCP_HOST,
	keys: [],
};

interface ObsidianLocalStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

/** Device-local (Electron localStorage, vault-scoped) — structurally unsyncable. */
export class DeviceLocalStore {
	constructor(private readonly app: App) {}

	load(): DeviceLocalMcpConfig {
		const raw = (this.app as unknown as ObsidianLocalStorage).loadLocalStorage(LOCAL_STORAGE_KEY);
		if (!raw || typeof raw !== "object") return { ...DEFAULT_DEVICE_CONFIG, keys: [] };
		return { ...DEFAULT_DEVICE_CONFIG, ...(raw as Partial<DeviceLocalMcpConfig>) };
	}

	save(config: DeviceLocalMcpConfig): void {
		(this.app as unknown as ObsidianLocalStorage).saveLocalStorage(LOCAL_STORAGE_KEY, config);
	}

	/**
	 * Mint a full+watch key pair for an identity (creation and revocation are
	 * pair-level by design — LOG 2026-06-12). Returns the tokens — shown once,
	 * only hashes are stored.
	 */
	async mintPair(
		identityId: string,
		label?: string,
		pathScope?: string[],
	): Promise<{ full: string; watch: string }> {
		const pairId = "p_" + crypto.randomUUID();
		const fence = pathScope && pathScope.length > 0 ? pathScope : undefined;
		const config = this.load();
		const tokens = {} as { full: string; watch: string };
		for (const scope of ["full", "watch"] as KeyScope[]) {
			const bytes = new Uint8Array(24);
			crypto.getRandomValues(bytes);
			const token =
				`ann_${scope}_` + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
			tokens[scope] = token;
			config.keys.push({
				tokenHash: await hashToken(token),
				token,
				identityId,
				scope,
				label,
				pairId,
				pathScope: fence,
			});
		}
		this.save(config);
		return tokens;
	}

	loadOAuthClients(): OAuthClientInformationFull[] {
		return this.load().oauthClients ?? [];
	}

	saveOAuthClients(clients: OAuthClientInformationFull[]): void {
		const config = this.load();
		config.oauthClients = clients;
		this.save(config);
	}

	/** Revoke by pairId (both halves) — or a single legacy key by tokenHash. */
	revokePair(pairIdOrTokenHash: string): void {
		const config = this.load();
		config.keys = config.keys.filter(
			(k) => k.pairId !== pairIdOrTokenHash && k.tokenHash !== pairIdOrTokenHash,
		);
		this.save(config);
	}
}

/**
 * Env-supplied keys for the headless/container instance:
 * ANNOTATED_MCP_KEYS = JSON [{ "token": "...", "identity": "<name or id>", "scope": "full"|"watch" }]
 * Hashed once at load; identity references resolve against the live registry
 * at auth time (by id, then by name), so a key declared before the registry
 * syncs in simply stays orphaned until it does.
 */
export async function loadEnvKeys(
	getIdentities: () => Identity[],
	onWarn: (message: string) => void,
): Promise<() => KeyRecord[]> {
	const raw = typeof process !== "undefined" ? process.env?.ANNOTATED_MCP_KEYS : undefined;
	if (!raw) return () => [];

	let entries: Array<{ token?: string; identity?: string; scope?: string; paths?: string[] }>;
	try {
		entries = JSON.parse(raw);
		if (!Array.isArray(entries)) throw new Error("not an array");
	} catch (e) {
		onWarn(`ANNOTATED_MCP_KEYS is not a JSON array — ignoring (${String(e)})`);
		return () => [];
	}

	const hashed: Array<{
		tokenHash: string;
		identityRef: string;
		scope: KeyScope;
		label: string;
		pathScope?: string[];
	}> = [];
	for (const [i, entry] of entries.entries()) {
		if (!entry?.token || !entry.identity || !["full", "watch", "poll", "additive", "destructive"].includes(entry.scope as string)) {
			onWarn(`ANNOTATED_MCP_KEYS[${i}] needs token, identity, scope poll|additive|destructive|full|watch — skipped`);
			continue;
		}
		hashed.push({
			tokenHash: await hashToken(entry.token),
			identityRef: entry.identity,
			scope: entry.scope,
			label: `env[${i}]`,
			pathScope: Array.isArray(entry.paths) && entry.paths.length > 0 ? entry.paths : undefined,
		});
	}

	return () => {
		const identities = getIdentities();
		return hashed.map((k) => {
			const identity =
				identities.find((id) => id.id === k.identityRef) ??
				identities.find((id) => id.name === k.identityRef);
			return {
				tokenHash: k.tokenHash,
				// Unresolvable ref → impossible id → authenticate() reports orphaned_key.
				identityId: identity?.id ?? `unresolved:${k.identityRef}`,
				scope: k.scope,
				label: k.label,
				pathScope: k.pathScope,
			};
		});
	};
}

export function buildAuthProvider(
	getIdentities: () => Identity[],
	deviceStore: DeviceLocalStore,
	getEnvKeys: () => KeyRecord[],
): AuthProvider {
	return {
		getIdentities,
		getKeys: () => [...deviceStore.load().keys, ...getEnvKeys()],
	};
}

export function buildNoteAccess(app: App): NoteAccess {
	const vault = app.vault;
	return {
		exists: (path) => vault.adapter.exists(path),
		read: (path) => vault.adapter.read(path),
		write: (path, content) => vault.adapter.write(path, content),
		mkdir: (path) => vault.adapter.mkdir(path),
		listCommentedNotePaths: async () => {
			const suffix = ".comments.json";
			return vault
				.getFiles()
				.filter((f) => f.path.endsWith(suffix))
				.map((f) => f.path.slice(0, -suffix.length));
		},
		listPaths: async () =>
			vault
				.getFiles()
				.filter((f) => f.path.endsWith(".md"))
				.map((f) => f.path),
		listFrontmatter: async () => {
			// TODO: metadataCache would be the cheaper source instead of reading files
			const result = [];
			for (const file of vault.getFiles()) {
				if (!file.path.endsWith(".md")) continue;
				try {
					const content = await vault.adapter.read(file.path);
					const parsed = readFrontmatter(content);
					result.push({
						path: file.path,
						frontmatter: parsed.scalars,
					});
				} catch {
					// Skip unreadable files
				}
			}
			return result;
		},
		search: async (query, scopes, opts) => {
			const limit = opts?.limit ?? 20;
			const scorer = prepareSimpleSearch(query);
			const inScope = (p: string) => (!scopes ? true : scopes.some((s) => pathInScope(p, s)));
			const files = vault.getMarkdownFiles().filter((f) => inScope(f.path));
			const hits: SearchHit[] = [];
			for (const f of files) {
				const content = await vault.cachedRead(f);
				const m = scorer(content);
				if (!m) continue;
				const offset = m.matches?.[0]?.[0] ?? 0;
				const line = content.slice(0, offset).split("\n").length;
				const start = Math.max(0, offset - 30);
				const excerpt = content.slice(start, offset + 60).replace(/\s+/g, " ").trim();
				hits.push({ path: f.path, line, excerpt, score: m.score });
			}
			hits.sort((a, b) => b.score - a.score);
			return hits.slice(0, limit);
		},
		move: async (oldPath, newPath) => {
			const file = vault.getAbstractFileByPath(oldPath);
			if (!file) throw new Error(`Note not found: ${oldPath}`);
			await app.fileManager.renameFile(file, newPath);
		},
		trash: async (path) => {
			const file = vault.getAbstractFileByPath(path);
			if (!file) return;
			await app.fileManager.trashFile(file);
		},
	};
}

export function resolveBindConfig(device: DeviceLocalMcpConfig): { port: number; host: string } {
	const envPort = typeof process !== "undefined" ? Number(process.env?.ANNOTATED_MCP_PORT) : NaN;
	const envHost = typeof process !== "undefined" ? process.env?.ANNOTATED_MCP_HOST : undefined;
	return {
		port: Number.isFinite(envPort) && envPort > 0 ? envPort : device.port,
		host: envHost || device.host,
	};
}

/** OAuth on/off: env wins (headless container), else the device toggle, default off. */
export function resolveOAuthEnabled(device: DeviceLocalMcpConfig): boolean {
	const env = typeof process !== "undefined" ? process.env?.ANNOTATED_MCP_OAUTH : undefined;
	if (env !== undefined) return env === "1" || env.toLowerCase() === "true";
	return device.oauthEnabled === true;
}

/** Public base URL for OAuth metadata (the proxy-facing URL on the container). */
export function resolvePublicUrl(bind: { host: string; port: number }): string {
	const env = typeof process !== "undefined" ? process.env?.ANNOTATED_MCP_PUBLIC_URL : undefined;
	return (env && env.trim().replace(/\/+$/, "")) || `http://${bind.host}:${bind.port}`;
}
