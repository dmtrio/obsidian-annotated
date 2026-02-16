/**
 * Minimal in-memory Vault adapter mock for testing CommentManager.
 */
export function createMockVault() {
  const files = new Map<string, string>();

  const adapter = {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    },
    write: async (path: string, data: string) => {
      files.set(path, data);
    },
  };

  return {
    adapter,
    // Test helpers
    _files: files,
  } as any;
}
