// Storage is injected so the same store runs over Obsidian's vault adapter
// (plugin), node fs (stdio host), or memory (tests). Paths are vault-relative.

export interface CommentStorageAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export class InMemoryStorageAdapter implements CommentStorageAdapter {
	readonly files = new Map<string, string>();

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}

	async read(path: string): Promise<string> {
		const data = this.files.get(path);
		if (data === undefined) throw new Error(`ENOENT: ${path}`);
		return data;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
}
