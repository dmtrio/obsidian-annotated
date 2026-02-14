import { Notice, Vault } from "obsidian";
import { Comment, CommentFile, CommentReply } from "../types";

export class CommentManager {
	private vault: Vault;
	private cache: Map<string, CommentFile> = new Map();

	constructor(vault: Vault) {
		this.vault = vault;
	}

	async getComments(notePath: string): Promise<CommentFile | null> {
		const cached = this.cache.get(notePath);
		if (cached) return cached;

		const path = this.commentsPath(notePath);
		if (!(await this.vault.adapter.exists(path))) return null;

		try {
			const raw = await this.vault.adapter.read(path);
			const commentFile = JSON.parse(raw) as CommentFile;
			this.cache.set(notePath, commentFile);
			return commentFile;
		} catch (e) {
			console.error("Failed to parse comments file:", path, e);
			new Notice("Failed to parse comments file");
			return null;
		}
	}

	async saveComments(commentFile: CommentFile): Promise<void> {
		this.recalculateMetadata(commentFile);
		commentFile.updated_at = new Date().toISOString();
		const path = this.commentsPath(commentFile.note_path);
		await this.vault.adapter.write(path, JSON.stringify(commentFile, null, 2));
		this.cache.set(commentFile.note_path, commentFile);
	}

	async addComment(notePath: string, comment: Comment): Promise<void> {
		let commentFile = await this.getComments(notePath);
		if (!commentFile) {
			commentFile = this.createEmptyCommentFile(notePath);
		}
		commentFile.comments.push(comment);
		await this.saveComments(commentFile);
	}

	async addReply(notePath: string, commentId: string, reply: CommentReply): Promise<void> {
		const commentFile = await this.getComments(notePath);
		if (!commentFile) return;

		const comment = commentFile.comments.find((c) => c.id === commentId);
		if (!comment) return;

		comment.replies.push(reply);
		comment.updated_at = new Date().toISOString();
		comment.last_activity_at = reply.created_at;
		if (comment.status === "resolved") {
			comment.status = "open";
			comment.resolved_at = undefined;
			comment.resolved_by = undefined;
		}
		await this.saveComments(commentFile);
	}

	async resolveComment(notePath: string, commentId: string, resolvedBy: string): Promise<void> {
		const commentFile = await this.getComments(notePath);
		if (!commentFile) return;

		const comment = commentFile.comments.find((c) => c.id === commentId);
		if (!comment) return;

		comment.status = "resolved";
		comment.resolved_at = new Date().toISOString();
		comment.resolved_by = resolvedBy;
		comment.updated_at = comment.resolved_at;
		await this.saveComments(commentFile);
	}

	invalidateCache(notePath: string): void {
		this.cache.delete(notePath);
	}

	clearCache(): void {
		this.cache.clear();
	}

	private commentsPath(notePath: string): string {
		return notePath + ".comments";
	}

	private recalculateMetadata(commentFile: CommentFile): void {
		const comments = commentFile.comments;
		const authors = new Set<string>();
		let open = 0, resolved = 0, archived = 0;

		for (const c of comments) {
			authors.add(c.author);
			if (c.status === "open") open++;
			else if (c.status === "resolved") resolved++;
			else if (c.status === "archived") archived++;

			for (const r of c.replies) {
				authors.add(r.author);
			}
		}

		commentFile.metadata = {
			total_comments: comments.length,
			open_count: open,
			resolved_count: resolved,
			archived_count: archived,
			authors: [...authors],
		};
	}

	private createEmptyCommentFile(notePath: string): CommentFile {
		const now = new Date().toISOString();
		return {
			version: "1.0",
			note_path: notePath,
			created_at: now,
			updated_at: now,
			comments: [],
			metadata: {
				total_comments: 0,
				open_count: 0,
				resolved_count: 0,
				archived_count: 0,
				authors: [],
			},
		};
	}

	generateId(): string {
		return "c_" + Date.now().toString(36) + crypto.randomUUID().slice(0, 5);
	}
}
