/**
 * Plugin binding for AnnotatedMcpServer (PLN Decisions 4/4b).
 *
 * Storage split, per the livesync reality check (LOG 2026-06-12):
 * - Identity registry → plugin settings (data.json) — SYNCS between instances.
 * - Key table + bind host/port → Obsidian device-local storage — never syncs.
 * - Env override (ANNOTATED_MCP_KEYS / _PORT / _HOST) → headless container
 *   path; survives container rebuilds where device-local storage would not.
 */
import { App, Vault } from "obsidian";
import {
	hashToken,
	type Identity,
	type KeyRecord,
	type KeyScope,
} from "@annotated/comments-core";
import type { AuthProvider, NoteAccess } from "./AnnotatedMcpServer";

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
		if (!entry?.token || !entry.identity || (entry.scope !== "full" && entry.scope !== "watch")) {
			onWarn(`ANNOTATED_MCP_KEYS[${i}] needs token, identity, scope full|watch — skipped`);
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

export function buildNoteAccess(vault: Vault): NoteAccess {
	return {
		exists: (path) => vault.adapter.exists(path),
		read: (path) => vault.adapter.read(path),
		write: (path, content) => vault.adapter.write(path, content),
		listCommentedNotePaths: async () => {
			const suffix = ".comments.json";
			return vault
				.getFiles()
				.filter((f) => f.path.endsWith(suffix))
				.map((f) => f.path.slice(0, -suffix.length));
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
