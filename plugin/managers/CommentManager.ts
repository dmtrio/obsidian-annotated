import { Notice, Vault } from "obsidian";
import { Comment, CommentFile, CommentReply } from "../types";
import {
	CommentStore,
	CommentStorageAdapter,
} from "@annotated/comments-core";

/**
 * Thin Obsidian binding over the shared CommentStore (@annotated/comments-core):
 * vault adapter in, Notice-based error reporting out. All comment semantics
 * live in the core package.
 */
export class CommentManager {
	/**
	 * Exposed so the in-plugin MCP server shares this exact instance — one
	 * cache over one vault adapter; the modify-event invalidation in main.ts
	 * reaches server-written files too.
	 */
	readonly store: CommentStore;

	constructor(vault: Vault, pluginVersion = "0.0.0") {
		const storage: CommentStorageAdapter = {
			exists: (path) => vault.adapter.exists(path),
			read: (path) => vault.adapter.read(path),
			write: (path, data) => vault.adapter.write(path, data),
		};
		this.store = new CommentStore(storage, {
			createdBy: `annotated@${pluginVersion}`,
			onError: (message, cause) => {
				console.error(message, cause);
				new Notice("Failed to parse comments file");
			},
		});
	}

	getComments(notePath: string): Promise<CommentFile | null> {
		return this.store.getComments(notePath);
	}

	saveComments(commentFile: CommentFile): Promise<void> {
		return this.store.saveComments(commentFile);
	}

	addComment(notePath: string, comment: Comment): Promise<void> {
		return this.store.addComment(notePath, comment);
	}

	addReply(notePath: string, commentId: string, reply: CommentReply): Promise<void> {
		return this.store.addReply(notePath, commentId, reply);
	}

	resolveComment(
		notePath: string,
		commentId: string,
		resolvedBy: string,
		resolvedById?: string,
	): Promise<void> {
		return this.store.resolveComment(notePath, commentId, resolvedBy, resolvedById);
	}

	invalidateCache(notePath: string): void {
		this.store.invalidateCache(notePath);
	}

	clearCache(): void {
		this.store.clearCache();
	}

	generateId(): string {
		return this.store.generateId();
	}
}
