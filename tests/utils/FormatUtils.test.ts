import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  formatLocationText,
  getCommentActivityTime,
  truncateContent,
} from "../../src/utils/FormatUtils";
import { Comment } from "../../src/types";

describe("formatLocationText", () => {
  it("returns 'Line X' when start equals end", () => {
    expect(formatLocationText({ start_line: 5, end_line: 5 })).toBe("Line 5");
  });

  it("returns 'Lines X–Y' when start differs from end", () => {
    expect(formatLocationText({ start_line: 3, end_line: 7 })).toBe("Lines 3\u20137");
  });
});

describe("getCommentActivityTime", () => {
  const baseComment: Comment = {
    id: "c_1",
    author: "alice",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    location: { type: "range", start_line: 1, start_char: 0, end_line: 1, end_char: 0 },
    content: "test",
    status: "open",
    replies: [],
    last_activity_at: "2024-06-01T00:00:00Z",
  };

  it("prefers last_activity_at when present", () => {
    const result = getCommentActivityTime(baseComment);
    expect(result).toBe(new Date("2024-06-01T00:00:00Z").getTime());
  });

  it("falls back to last reply when last_activity_at is empty", () => {
    const comment: Comment = {
      ...baseComment,
      last_activity_at: "",
      replies: [
        {
          id: "r_1",
          author: "bob",
          created_at: "2024-03-15T00:00:00Z",
          updated_at: "2024-03-15T00:00:00Z",
          content: "reply",
          status: "open",
        },
      ],
    };
    const result = getCommentActivityTime(comment);
    expect(result).toBe(new Date("2024-03-15T00:00:00Z").getTime());
  });

  it("falls back to created_at when no replies and no last_activity_at", () => {
    const comment: Comment = {
      ...baseComment,
      last_activity_at: "",
      replies: [],
    };
    const result = getCommentActivityTime(comment);
    expect(result).toBe(new Date("2024-01-01T00:00:00Z").getTime());
  });
});

describe("truncateContent", () => {
  it("returns text unchanged when under limit", () => {
    expect(truncateContent("short")).toBe("short");
  });

  it("truncates with ellipsis when over limit", () => {
    const long = "a".repeat(150);
    const result = truncateContent(long);
    expect(result).toBe("a".repeat(120) + "\u2026");
  });

  it("returns text unchanged at exact limit", () => {
    const exact = "b".repeat(120);
    expect(truncateContent(exact)).toBe(exact);
  });

  it("respects custom max", () => {
    const result = truncateContent("hello world", 5);
    expect(result).toBe("hello\u2026");
  });
});

describe("formatTimestamp", () => {
  it("formats today's date as time only", () => {
    const now = new Date();
    now.setHours(14, 30, 0, 0);
    const result = formatTimestamp(now.toISOString());
    expect(result).toBe("2:30 PM");
  });

  it("formats a past date with month, day, and time", () => {
    const result = formatTimestamp("2023-03-15T09:45:00Z");
    // moment will format in local timezone, so just check it contains the date components
    expect(result).toMatch(/Mar 1[45]/);
    expect(result).toMatch(/\d{1,2}:\d{2} [AP]M/);
  });
});
