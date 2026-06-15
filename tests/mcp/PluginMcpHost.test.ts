import { describe, it, expect } from "vitest";
import { DeviceLocalStore, tierLabel } from "../../server/PluginMcpHost";
import type { App } from "obsidian";

function fakeApp(): App {
	const ls: Record<string, unknown> = {};
	return {
		loadLocalStorage: (k: string) => ls[k] ?? null,
		saveLocalStorage: (k: string, v: unknown) => { ls[k] = v; },
	} as unknown as App;
}

describe("tierLabel", () => {
	it("maps stored scopes (incl. legacy) to capability labels", () => {
		expect(tierLabel("poll")).toBe("Read");
		expect(tierLabel("watch")).toBe("Read");
		expect(tierLabel("additive")).toBe("Read + Write");
		expect(tierLabel("full")).toBe("Read + Write");
		expect(tierLabel("destructive")).toBe("Read + Write + Move/Delete");
	});
});

describe("mintPair", () => {
	it("mints a poll + additive pair sharing a pairId", async () => {
		const store = new DeviceLocalStore(fakeApp());
		const tokens = await store.mintPair("i_claude", "additive", "agent");
		expect(tokens.poll).toMatch(/^ann_poll_/);
		expect(tokens.write).toMatch(/^ann_additive_/);
		const keys = store.load().keys;
		expect(keys).toHaveLength(2);
		expect(keys.map((k) => k.scope).sort()).toEqual(["additive", "poll"]);
		expect(new Set(keys.map((k) => k.pairId)).size).toBe(1);
		expect(keys.every((k) => k.identityId === "i_claude")).toBe(true);
	});

	it("mints a poll + destructive pair", async () => {
		const store = new DeviceLocalStore(fakeApp());
		const tokens = await store.mintPair("i_claude", "destructive");
		expect(tokens.write).toMatch(/^ann_destructive_/);
		const keys = store.load().keys;
		expect(keys.map((k) => k.scope).sort()).toEqual(["destructive", "poll"]);
	});

	it("applies a folder fence to both keys", async () => {
		const store = new DeviceLocalStore(fakeApp());
		await store.mintPair("i_claude", "additive", undefined, ["Inbox"]);
		const keys = store.load().keys;
		expect(keys.every((k) => k.pathScope?.includes("Inbox"))).toBe(true);
	});
});
