import { describe, it, expect, beforeEach } from "vitest";
import { CommentManager } from "../../src/managers/CommentManager";
import { createMockVault } from "../mocks/vault";
import { Comment, CommentFile, CommentReply, SCHEMA_VERSION } from "../../src/types";

function makeComment(overrides: Partial<Comment> = {}): Comment {
  const now = new Date().toISOString();
  return {
    id: "c_test1",
    author: "alice",
    created_at: now,
    updated_at: now,
    location: { type: "range", start_line: 1, start_char: 0, end_line: 1, end_char: 0 },
    content: "test comment",
    status: "open",
    replies: [],
    last_activity_at: now,
    ...overrides,
  };
}

describe("CommentManager", () => {
  let vault: ReturnType<typeof createMockVault>;
  let manager: CommentManager;

  beforeEach(() => {
    vault = createMockVault();
    manager = new CommentManager(vault, "0.1.0");
  });

  describe("addComment", () => {
    it("creates comment file if missing", async () => {
      const comment = makeComment();
      await manager.addComment("note.md", comment);

      const raw = await vault.adapter.read("note.md.comments.json");
      const file = JSON.parse(raw) as CommentFile;
      expect(file.comments).toHaveLength(1);
      expect(file.comments[0].id).toBe(comment.id);
      expect(file.note_path).toBe("note.md");
      expect(file.version).toBe(SCHEMA_VERSION);
      expect(file.createdBy).toBe("obsidian-annotated@0.1.0");
    });

    it("appends to existing comment file", async () => {
      const c1 = makeComment({ id: "c_1" });
      const c2 = makeComment({ id: "c_2" });
      await manager.addComment("note.md", c1);
      await manager.addComment("note.md", c2);

      const raw = await vault.adapter.read("note.md.comments.json");
      const file = JSON.parse(raw) as CommentFile;
      expect(file.comments).toHaveLength(2);
    });
  });

  describe("addReply", () => {
    it("adds reply and updates last_activity_at", async () => {
      const comment = makeComment({ id: "c_1", created_at: "2024-01-01T00:00:00Z" });
      await manager.addComment("note.md", comment);

      const reply: CommentReply = {
        id: "r_1",
        author: "bob",
        created_at: "2024-06-01T00:00:00Z",
        updated_at: "2024-06-01T00:00:00Z",
        content: "a reply",
        status: "open",
      };
      await manager.addReply("note.md", "c_1", reply);

      const raw = await vault.adapter.read("note.md.comments.json");
      const file = JSON.parse(raw) as CommentFile;
      expect(file.comments[0].replies).toHaveLength(1);
      expect(file.comments[0].last_activity_at).toBe("2024-06-01T00:00:00Z");
    });

    it("reopens resolved comment when reply is added", async () => {
      const comment = makeComment({
        id: "c_1",
        status: "resolved",
        resolved_at: "2024-03-01T00:00:00Z",
        resolved_by: "alice",
      });
      await manager.addComment("note.md", comment);

      const reply: CommentReply = {
        id: "r_1",
        author: "bob",
        created_at: "2024-06-01T00:00:00Z",
        updated_at: "2024-06-01T00:00:00Z",
        content: "reopening",
        status: "open",
      };
      await manager.addReply("note.md", "c_1", reply);

      const raw = await vault.adapter.read("note.md.comments.json");
      const file = JSON.parse(raw) as CommentFile;
      expect(file.comments[0].status).toBe("open");
      expect(file.comments[0].resolved_at).toBeUndefined();
      expect(file.comments[0].resolved_by).toBeUndefined();
    });
  });

  describe("resolveComment", () => {
    it("sets status, resolved_at, and resolved_by", async () => {
      const comment = makeComment({ id: "c_1" });
      await manager.addComment("note.md", comment);
      await manager.resolveComment("note.md", "c_1", "alice");

      const raw = await vault.adapter.read("note.md.comments.json");
      const file = JSON.parse(raw) as CommentFile;
      expect(file.comments[0].status).toBe("resolved");
      expect(file.comments[0].resolved_by).toBe("alice");
      expect(file.comments[0].resolved_at).toBeDefined();
    });
  });

  describe("getComments / caching", () => {
    it("returns null for non-existent file", async () => {
      const result = await manager.getComments("nonexistent.md");
      expect(result).toBeNull();
    });

    it("caches results", async () => {
      const comment = makeComment();
      await manager.addComment("note.md", comment);

      const first = await manager.getComments("note.md");
      const second = await manager.getComments("note.md");
      expect(first).toBe(second); // Same reference = cached
    });

    it("invalidateCache clears cache", async () => {
      const comment = makeComment();
      await manager.addComment("note.md", comment);

      await manager.getComments("note.md");
      manager.invalidateCache("note.md");

      // Modify underlying file directly
      const raw = await vault.adapter.read("note.md.comments.json");
      const file = JSON.parse(raw) as CommentFile;
      file.comments[0].content = "modified";
      await vault.adapter.write("note.md.comments.json", JSON.stringify(file));

      const refreshed = await manager.getComments("note.md");
      expect(refreshed?.comments[0].content).toBe("modified");
    });
  });

  describe("recalculateMetadata", () => {
    it("correctly counts comments and authors", async () => {
      const c1 = makeComment({ id: "c_1", author: "alice", status: "open" });
      const c2 = makeComment({ id: "c_2", author: "bob", status: "resolved" });
      await manager.addComment("note.md", c1);
      await manager.addComment("note.md", c2);

      const raw = await vault.adapter.read("note.md.comments.json");
      const file = JSON.parse(raw) as CommentFile;
      expect(file.metadata.total_comments).toBe(2);
      expect(file.metadata.open_count).toBe(1);
      expect(file.metadata.resolved_count).toBe(1);
      expect(file.metadata.authors).toContain("alice");
      expect(file.metadata.authors).toContain("bob");
    });

    it("includes reply authors in metadata", async () => {
      const comment = makeComment({ id: "c_1", author: "alice" });
      await manager.addComment("note.md", comment);

      const reply: CommentReply = {
        id: "r_1",
        author: "charlie",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        content: "reply",
        status: "open",
      };
      await manager.addReply("note.md", "c_1", reply);

      const raw = await vault.adapter.read("note.md.comments.json");
      const file = JSON.parse(raw) as CommentFile;
      expect(file.metadata.authors).toContain("charlie");
    });
  });

  describe("generateId", () => {
    it("returns prefixed unique strings", () => {
      const id1 = manager.generateId();
      const id2 = manager.generateId();
      expect(id1).toMatch(/^c_/);
      expect(id2).toMatch(/^c_/);
      expect(id1).not.toBe(id2);
    });
  });
});
