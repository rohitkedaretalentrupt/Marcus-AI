import { describe, expect, it } from "vitest";

import {
  conversationTitleSchema,
  createConversationSchema,
  MESSAGE_MAX_LENGTH,
  messageContentSchema,
  renameConversationSchema,
  sendMessageSchema,
  TITLE_MAX_LENGTH,
} from "./validation";

describe("messageContentSchema", () => {
  it.each(["", "   ", "\n\n\t \n"])("rejects empty or whitespace-only content %j", (content) => {
    expect(messageContentSchema.safeParse(content).success).toBe(false);
  });

  it("rejects content over the maximum length", () => {
    expect(messageContentSchema.safeParse("a".repeat(MESSAGE_MAX_LENGTH + 1)).success).toBe(false);
    expect(messageContentSchema.safeParse("a".repeat(MESSAGE_MAX_LENGTH)).success).toBe(true);
  });

  it("preserves meaningful whitespace (indentation, blank lines, inner spacing)", () => {
    const content = "Experience:\n\n  - Led   a team\n    of five\n\nSkills";
    expect(messageContentSchema.parse(content)).toBe(content);
  });

  it("drops only leading blank lines and trailing whitespace, and normalises CRLF", () => {
    expect(messageContentSchema.parse("\n  \n  Indented first line\r\nNext  \n\n")).toBe(
      "  Indented first line\nNext",
    );
  });

  it("rejects non-string input", () => {
    expect(messageContentSchema.safeParse(42).success).toBe(false);
  });
});

describe("conversationTitleSchema", () => {
  it("trims and accepts 1–100 characters", () => {
    expect(conversationTitleSchema.parse("  Client A resume  ")).toBe("Client A resume");
    expect(conversationTitleSchema.safeParse("a".repeat(TITLE_MAX_LENGTH)).success).toBe(true);
  });

  it.each(["", "   ", "a".repeat(TITLE_MAX_LENGTH + 1)])("rejects %j", (title) => {
    expect(conversationTitleSchema.safeParse(title).success).toBe(false);
  });
});

describe("request body schemas", () => {
  it("reject unknown fields such as a client-supplied userId", () => {
    expect(renameConversationSchema.safeParse({ title: "x", userId: "someone" }).success).toBe(
      false,
    );
    expect(sendMessageSchema.safeParse({ content: "x", role: "ASSISTANT" }).success).toBe(false);
    expect(createConversationSchema.safeParse({ userId: "someone" }).success).toBe(false);
  });

  it("allows creating a conversation with or without a first message", () => {
    expect(createConversationSchema.parse({})).toEqual({ attachmentFileIds: [] });
    expect(createConversationSchema.parse({ message: "Hi" })).toEqual({
      message: "Hi",
      attachmentFileIds: [],
    });
  });
});
