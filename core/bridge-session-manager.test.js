import { describe, expect, it } from "vitest";
import { chooseAutoLinkTarget } from "./bridge-session-manager.js";

describe("chooseAutoLinkTarget", () => {
  it("links a fresh owner bridge session to the current local conversation", () => {
    const decision = chooseAutoLinkTarget(
      { conversationId: "local-1", conversationLastSeq: 6 },
      { conversationId: "bridge-1", conversationLastSeq: 0 },
    );

    expect(decision).toEqual({
      target: "bridge",
      conversationId: "local-1",
    });
  });

  it("links a fresh local session to an existing owner bridge conversation", () => {
    const decision = chooseAutoLinkTarget(
      { conversationId: "local-1", conversationLastSeq: 0 },
      { conversationId: "bridge-1", conversationLastSeq: 4 },
    );

    expect(decision).toEqual({
      target: "local",
      conversationId: "bridge-1",
    });
  });

  it("does not auto-link when both sides already have history", () => {
    const decision = chooseAutoLinkTarget(
      { conversationId: "local-1", conversationLastSeq: 3 },
      { conversationId: "bridge-1", conversationLastSeq: 2 },
    );

    expect(decision).toBeNull();
  });

  it("does nothing when both sides already share the same conversation", () => {
    const decision = chooseAutoLinkTarget(
      { conversationId: "shared-1", conversationLastSeq: 3 },
      { conversationId: "shared-1", conversationLastSeq: 0 },
    );

    expect(decision).toBeNull();
  });
});
