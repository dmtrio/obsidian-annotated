import { describe, it, expect } from "vitest";
import { captureSnippet, findLineBySnippet, bigramSimilarity } from "../../src/utils/SnippetMatcher";

describe("captureSnippet", () => {
  it("returns first 50 chars trimmed", () => {
    const line = "a".repeat(60);
    expect(captureSnippet(line)).toBe("a".repeat(50));
  });

  it("trims trailing whitespace", () => {
    expect(captureSnippet("hello   ")).toBe("hello");
  });

  it("returns empty string for empty input", () => {
    expect(captureSnippet("")).toBe("");
  });

  it("returns short lines unchanged (after trimEnd)", () => {
    expect(captureSnippet("short line")).toBe("short line");
  });
});

describe("findLineBySnippet", () => {
  const doc = [
    "line zero",
    "line one",
    "line two",
    "line three",
    "line four",
  ];

  it("returns exact match at hint line", () => {
    const result = findLineBySnippet(doc, "line two", 2);
    expect(result).toEqual({ line: 2, confidence: 1.0 });
  });

  it("finds exact match at offset from hint", () => {
    const result = findLineBySnippet(doc, "line four", 2);
    expect(result).toEqual({ line: 4, confidence: 1.0 });
  });

  it("returns null for empty snippet", () => {
    expect(findLineBySnippet(doc, "", 0)).toBeNull();
  });

  it("returns null when no match found", () => {
    expect(findLineBySnippet(doc, "not in doc", 0)).toBeNull();
  });

  it("finds fuzzy match when exact match fails", () => {
    const docWithSimilar = [
      "function hello() {",
      "  return world;",
      "  return worlds;",
    ];
    // "return world;" vs "return worlds;" should fuzzy match
    const result = findLineBySnippet(docWithSimilar, "  return world;", 2);
    // Should find line 1 as exact match (startsWith)
    expect(result).toEqual({ line: 1, confidence: 1.0 });
  });

  it("prefers closer match when confidence is equal", () => {
    const docDup = [
      "unique start",
      "duplicate line here",
      "something else",
      "something else",
      "duplicate line here",
    ];
    // Hint at line 3 - should prefer line 1 (closer) over line 4
    const result = findLineBySnippet(docDup, "duplicate line here", 3);
    // Both are exact matches, but line 4 is closer to hint 3
    expect(result?.line).toBe(4);
    expect(result?.confidence).toBe(1.0);
  });

  it("respects radius limit", () => {
    // Build a doc where each line is unique and no line within radius 50 of hint 0 resembles the target
    const bigDoc = Array.from({ length: 200 }, (_, i) => `alpha_${String(i).padStart(4, "0")}`);
    // Replace line 150 with a completely different string
    bigDoc[150] = "zzz_unique_target_string";
    const result = findLineBySnippet(bigDoc, "zzz_unique_target_string", 0);
    expect(result).toBeNull();
  });
});

describe("bigramSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(bigramSimilarity("hello", "hello")).toBe(1.0);
  });

  it("returns 0 for completely different strings", () => {
    expect(bigramSimilarity("ab", "cd")).toBe(0);
  });

  it("returns 1.0 for identical single-char strings (identity check)", () => {
    expect(bigramSimilarity("a", "a")).toBe(1.0);
  });

  it("returns 0 for different strings shorter than 2 chars", () => {
    expect(bigramSimilarity("a", "b")).toBe(0);
  });

  it("returns partial overlap score", () => {
    const sim = bigramSimilarity("night", "nacht");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("is symmetric", () => {
    expect(bigramSimilarity("abc", "bcd")).toBe(bigramSimilarity("bcd", "abc"));
  });
});
