import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationManager,
  createConversationScopedResourceLoader,
} from "./conversation-manager.js";

const tempDirs = [];

function makeManager() {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-conversations-"));
  tempDirs.push(agentDir);
  const manager = new ConversationManager({ agentDir });
  manager.init();
  return { agentDir, manager };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("ConversationManager", () => {
  it("injects shared conversation context through a dedicated extension", async () => {
    const baseLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: null }),
      getSystemPrompt: () => "base prompt",
    };
    const loader = createConversationScopedResourceLoader(baseLoader);
    loader.setConversationContext({
      conversationId: "conversation-1",
      currentSource: "desktop",
      pendingCount: 2,
      systemPrompt: "shared system rules",
      messageContent: "shared linked updates",
    });

    const extension = loader.getExtensions().extensions.at(-1);
    const handler = extension?.handlers?.get("before_agent_start")?.[0];
    const result = await handler?.({
      type: "before_agent_start",
      prompt: "continue",
      images: [],
      systemPrompt: "base prompt",
    });

    expect(result?.systemPrompt).toContain("base prompt");
    expect(result?.systemPrompt).toContain("shared system rules");
    expect(result?.message).toMatchObject({
      customType: "shared_conversation_context",
      content: "shared linked updates",
    });

    loader.clearConversationContext();
    const cleared = await handler?.({
      type: "before_agent_start",
      prompt: "continue",
      images: [],
      systemPrompt: "base prompt",
    });
    expect(cleared).toBeUndefined();
  });

  it("reuses the same conversation for the same local session", async () => {
    const { manager } = makeManager();
    const sessionPath = path.join("C:\\tmp", "session-1.jsonl");

    const firstId = await manager.ensureLocalSession(sessionPath, { cwd: "C:\\tmp" });
    const secondId = await manager.ensureLocalSession(sessionPath, { cwd: "C:\\tmp" });

    expect(secondId).toBe(firstId);
    expect(manager.getConversationIdForLocalSession(sessionPath)).toBe(firstId);
  });

  it("appends complete message events to the timeline", async () => {
    const { manager } = makeManager();
    const sessionPath = path.join("C:\\tmp", "session-2.jsonl");
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
      { role: "toolResult", toolName: "todo", details: { todos: ["a"] }, content: [] },
    ];

    const conversationId = await manager.appendLocalSessionMessages(sessionPath, messages, {
      cwd: "C:\\tmp",
    });
    const timeline = manager.readTimeline(conversationId);

    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({
      conversationId,
      seq: 1,
      sourceType: "local_session",
      sourceKey: "session-2.jsonl",
      messageRole: "user",
      text: "hello",
    });
    expect(timeline[1]).toMatchObject({
      seq: 2,
      messageRole: "assistant",
      text: "world",
    });
    expect(timeline[2]).toMatchObject({
      seq: 3,
      messageRole: "toolResult",
    });
    expect(timeline[2].rawMessage.toolName).toBe("todo");
  });

  it("builds a structured snapshot and ignores synthetic shared context messages", async () => {
    const { manager } = makeManager();
    const sessionPath = path.join("C:\\tmp", "session-3.jsonl");
    const messages = [
      { role: "custom", customType: "shared_conversation_context", content: [{ type: "text", text: "synthetic" }] },
      { role: "user", content: [{ type: "text", text: "继续做 bridge 改造，但不要共享同一个 transcript，必须保留来源归属。接下来怎么处理？" }] },
      { role: "assistant", content: [{ type: "text", text: "我们决定采用 snapshot + delta 方案，继续沿着这条线实现。" }] },
      { role: "toolResult", toolName: "todo", content: [{ type: "text", text: "2 open items" }] },
    ];

    const conversationId = await manager.appendLocalSessionMessages(sessionPath, messages, {
      cwd: "C:\\tmp",
    });
    const timeline = manager.readTimeline(conversationId);
    const snapshot = manager.readSnapshot(conversationId);

    expect(timeline).toHaveLength(3);
    expect(timeline.some((event) => event.messageRole === "custom")).toBe(false);
    expect(snapshot).toMatchObject({
      conversationId,
      lastSeq: 3,
      lastUserMessage: { source: "desktop" },
      lastAssistantMessage: { source: "desktop" },
      currentObjective: { source: "desktop" },
    });
    expect(snapshot?.currentObjective?.text).toContain("接下来怎么处理");
    expect(snapshot?.openLoops?.[0]).toMatchObject({
      source: "desktop",
    });
    expect(snapshot?.openLoops?.[0]?.text).toContain("接下来怎么处理");
    expect(snapshot?.confirmedConstraints?.[0]?.text).toContain("不要共享同一个 transcript");
    expect(snapshot?.recentDecisions?.[0]?.text).toContain("决定采用 snapshot + delta 方案");
    expect(snapshot?.recentToolResults?.[0]).toMatchObject({
      source: "desktop",
      toolName: "todo",
      text: "2 open items",
    });
  });

  it("keeps owner and guest bridge sessions in separate buckets", async () => {
    const { manager } = makeManager();

    const ownerId = await manager.appendBridgeSessionMessages("qq_dm_1", [
      { role: "user", content: [{ type: "text", text: "owner" }] },
    ]);
    const guestId = await manager.appendBridgeSessionMessages("qq_dm_1", [
      { role: "user", content: [{ type: "text", text: "guest" }] },
    ], { guest: true });

    expect(ownerId).not.toBe(guestId);
    expect(manager.getConversationIdForBridgeSession("qq_dm_1")).toBe(ownerId);
    expect(manager.getConversationIdForBridgeSession("qq_dm_1", { guest: true })).toBe(guestId);
  });

  it("builds pending prompt context from linked channels and advances cursors", async () => {
    const { manager } = makeManager();
    const localSession = path.join("C:\\tmp", "local.jsonl");

    const conversationId = await manager.appendBridgeSessionMessages("qq_dm_2", [
      { role: "user", content: [{ type: "text", text: "bridge asks about task A" }] },
      { role: "assistant", content: [{ type: "text", text: "bridge gets answer A" }] },
    ]);

    await manager.linkLocalSession(localSession, conversationId);

    const pending = await manager.prepareLocalPromptContext(localSession);
    expect(pending?.pendingCount).toBe(2);
    expect(pending?.currentSource).toBe("desktop");
    expect(pending?.systemPrompt).toContain("Treat that context as authoritative recent history");
    expect(pending?.messageContent).toContain("[Conversation snapshot]");
    expect(pending?.messageContent).toContain("Current objective:");
    expect(pending?.messageContent).toContain("[Linked conversation timeline | current source: desktop]");
    expect(pending?.messageContent).toContain("[qq] user");
    expect(pending?.messageContent).toContain("bridge asks about task A");

    await manager.markLocalPromptContextSeen(localSession, pending.uptoSeq);

    const afterMark = manager.getBindingInfoForLocalSession(localSession);
    expect(afterMark?.lastSeenSeq).toBe(pending.uptoSeq);

    const empty = await manager.prepareLocalPromptContext(localSession);
    expect(empty?.pendingCount).toBe(0);
    expect(empty?.systemPrompt).toBe("");
    expect(empty?.messageContent).toBe("");
  });
});
