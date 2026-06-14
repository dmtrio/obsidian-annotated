/**
 * ProvenanceStamper — testable, Obsidian-free hook for stamping frontmatter
 * created/createdBy/updated/updatedBy on note creates and modifies.
 *
 * Uses stampProvenance and readFrontmatter from @annotated/comments-core.
 * Loop guard: onModify tracks writes in a Set to ignore the echo-back modify event.
 * Idempotency backstop: if the stamped content is unchanged, no write occurs.
 */

import { stampProvenance, readFrontmatter } from "@annotated/comments-core";

export interface StamperDeps {
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	now(): string; // date string like "2026-06-13"
	getAuthor(): string | null; // git-style "name <id>", or null if no device identity is selected
}

export class ProvenanceStamper {
	private readonly deps: StamperDeps;
	private readonly justStamped = new Set<string>(); // paths written by this stamper

	constructor(deps: StamperDeps) {
		this.deps = deps;
	}

	async onCreate(path: string): Promise<void> {
		// No-op guards
		if (!this.isMdFile(path)) return;
		const author = this.deps.getAuthor();
		if (!author) return;

		try {
			const content = await this.deps.read(path);
			const stamped = stampProvenance(content, {
				author,
				date: this.deps.now(),
				isCreate: true,
			});

			if (stamped !== content) {
				this.justStamped.add(path);
				await this.deps.write(path, stamped);
			}
		} catch (err) {
			// Silently ignore read/write errors (file might not exist yet, etc.)
		}
	}

	async onModify(path: string): Promise<void> {
		// No-op guards
		if (!this.isMdFile(path)) return;

		// Loop guard: if we just wrote this, skip
		if (this.justStamped.has(path)) {
			this.justStamped.delete(path);
			return;
		}

		const author = this.deps.getAuthor();
		if (!author) return;

		try {
			const content = await this.deps.read(path);
			const stamped = stampProvenance(content, {
				author,
				date: this.deps.now(),
				isCreate: false,
			});

			if (stamped !== content) {
				this.justStamped.add(path);
				await this.deps.write(path, stamped);
			}
		} catch (err) {
			// Silently ignore read/write errors
		}
	}

	private isMdFile(path: string): boolean {
		// No-op if path doesn't end in .md or ends in .comments.json
		if (!path.endsWith(".md")) return false;
		if (path.endsWith(".comments.json")) return false;
		return true;
	}
}
