import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createModuleLogger } from "../debug-log.js";

const STORE_VERSION = 1;
const MAX_CONTEXT_EVENTS = 24;
const MAX_CONTEXT_CHARS = 12_000;
const SNAPSHOT_RECENT_LIMIT = 3;
const SNAPSHOT_TEXT_LIMIT = 240;
const SNAPSHOT_FACT_LIMIT = 4;
const CONVERSATION_CONTEXT_EXTENSION_PATH = "<hanako:shared-conversation-context>";
const SHARED_CONTEXT_CUSTOM_TYPE = "shared_conversation_context";
const log = createModuleLogger("conversation");

function nowIso() {
  return new Date().toISOString();
}

function shortId(value) {
  return typeof value === "string" && value.length > 8 ? value.slice(0, 8) : value;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function cloneValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalizeBindingEntry(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return {
      conversationId: value,
      lastSeenSeq: 0,
      updatedAt: null,
    };
  }
  if (typeof value.conversationId === "string" && value.conversationId) {
    return {
      conversationId: value.conversationId,
      lastSeenSeq: Number.isFinite(value.lastSeenSeq) ? value.lastSeenSeq : 0,
      updatedAt: value.updatedAt || null,
    };
  }
  return null;
}

function sourceLabel(sourceType, sourceKey) {
  const platform = (() => {
    if (typeof sourceKey !== "string") return null;
    if (sourceKey.startsWith("qq_")) return "qq";
    if (sourceKey.startsWith("telegram_") || sourceKey.startsWith("tg_")) return "telegram";
    if (sourceKey.startsWith("whatsapp_") || sourceKey.startsWith("wa_")) return "whatsapp";
    if (sourceKey.startsWith("feishu_")) return "feishu";
    return null;
  })();

  switch (sourceType) {
    case "local_session":
      return "desktop";
    case "bridge_owner":
      return platform ? `${platform}` : `bridge-owner:${sourceKey}`;
    case "bridge_guest":
      return platform ? `${platform}-guest` : `bridge-guest:${sourceKey}`;
    default:
      return `${sourceType}:${sourceKey}`;
  }
}

function summarizeEvent(event) {
  const role = event.messageRole || "unknown";
  const text = String(event.text || "").trim();
  if (text) {
    return `[${sourceLabel(event.sourceType, event.sourceKey)}] ${role}: ${text}`;
  }

  if (role === "toolResult") {
    const toolName = event.rawMessage?.toolName || "tool";
    return `[${sourceLabel(event.sourceType, event.sourceKey)}] toolResult(${toolName})`;
  }

  if (role === "custom") {
    const customType = event.rawMessage?.customType || "message";
    return `[${sourceLabel(event.sourceType, event.sourceKey)}] custom(${customType})`;
  }

  return `[${sourceLabel(event.sourceType, event.sourceKey)}] ${role}`;
}

function compactText(value, maxLength = SNAPSHOT_TEXT_LIMIT) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function trimRecentItems(items, limit = SNAPSHOT_RECENT_LIMIT) {
  return Array.isArray(items) ? items.slice(-limit) : [];
}

function trimFactItems(items, limit = SNAPSHOT_FACT_LIMIT) {
  return Array.isArray(items) ? items.slice(-limit) : [];
}

function normalizeFactKey(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function pushUniqueFact(items, item, limit = SNAPSHOT_FACT_LIMIT) {
  if (!item?.text) return trimFactItems(items, limit);
  const key = `${item.kind || "fact"}:${item.source || "unknown"}:${normalizeFactKey(item.text)}`;
  const next = (Array.isArray(items) ? items : []).filter((entry) => {
    const entryKey = `${entry.kind || "fact"}:${entry.source || "unknown"}:${normalizeFactKey(entry.text)}`;
    return entryKey !== key;
  });
  next.push(item);
  return trimFactItems(next, limit);
}

function makeSnapshotFact(event, text, kind) {
  const compacted = compactText(text);
  if (!compacted) return null;
  return {
    kind,
    seq: event.seq,
    source: sourceLabel(event.sourceType, event.sourceKey),
    text: compacted,
    recordedAt: event.recordedAt,
  };
}

function looksLikeQuestion(text) {
  const value = compactText(text);
  if (!value) return false;
  if (/[?？]/.test(value)) return true;
  return /^(how|what|why|when|which|who|can you|could you|please|接下来|下一步|怎么|如何|是否|要不要|能不能)/i.test(value);
}

function extractConstraintCandidate(text) {
  const value = compactText(text);
  if (!value) return "";
  const patterns = [
    /(不要[^。！？\n]+[。！？]?)/,
    /(不能[^。！？\n]+[。！？]?)/,
    /(必须[^。！？\n]+[。！？]?)/,
    /(只(?:能|需要)?[^。！？\n]+[。！？]?)/,
    /(先不[^。！？\n]+[。！？]?)/,
    /\b(do not|don't|must|must not|should not|only|without|avoid|keep)\b[^.!?\n]*/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[0]) return compactText(match[0]);
  }
  return "";
}

function extractDecisionCandidate(text) {
  const value = compactText(text);
  if (!value) return "";
  const patterns = [
    /(决定[^。！？\n]+[。！？]?)/,
    /(改成[^。！？\n]+[。！？]?)/,
    /(采用[^。！？\n]+[。！？]?)/,
    /(就按[^。！？\n]+[。！？]?)/,
    /(不再[^。！？\n]+[。！？]?)/,
    /(继续沿着[^。！？\n]+[。！？]?)/,
    /\b(we will|we'll|decided to|going with|switch to|move to|use)\b[^.!?\n]*/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[0]) return compactText(match[0]);
  }
  return "";
}

function isSyntheticConversationContextMessage(message) {
  return message?.role === "custom" && message?.customType === SHARED_CONTEXT_CUSTOM_TYPE;
}

function isSyntheticConversationContextEvent(event) {
  return event?.messageRole === "custom" && event?.rawMessage?.customType === SHARED_CONTEXT_CUSTOM_TYPE;
}

function isMeaningfulPendingEvent(event) {
  if (!event) return false;
  if (isSyntheticConversationContextEvent(event)) return false;
  const text = String(event.text || "").trim();
  if (text) return true;
  if (event.messageRole === "toolResult") return true;
  if (event.messageRole === "custom") return true;
  return false;
}

export function createConversationScopedResourceLoader(baseResourceLoader) {
  let conversationContext = null;
  const scopedLoader = Object.create(baseResourceLoader);
  const baseGetExtensions = typeof baseResourceLoader.getExtensions === "function"
    ? baseResourceLoader.getExtensions.bind(baseResourceLoader)
    : () => ({ extensions: [], errors: [] });
  const conversationExtension = {
    path: CONVERSATION_CONTEXT_EXTENSION_PATH,
    resolvedPath: CONVERSATION_CONTEXT_EXTENSION_PATH,
    handlers: new Map([
      ["before_agent_start", [
        async (event) => {
          const current = conversationContext;
          if (!current?.messageContent && !current?.systemPrompt) {
            return undefined;
          }

          const result = {};
          if (current.messageContent) {
            result.message = {
              customType: SHARED_CONTEXT_CUSTOM_TYPE,
              content: current.messageContent,
              details: {
                conversationId: current.conversationId,
                currentSource: current.currentSource,
                pendingCount: current.pendingCount,
              },
            };
          }

          if (current.systemPrompt) {
            result.systemPrompt = [event.systemPrompt, current.systemPrompt]
              .filter(Boolean)
              .join("\n\n");
          }

          return result;
        },
      ]],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };

  scopedLoader.getExtensions = () => {
    const baseExtensions = baseGetExtensions();
    const extensions = Array.isArray(baseExtensions?.extensions)
      ? baseExtensions.extensions
      : [];

    if (extensions.some((extension) => extension?.path === CONVERSATION_CONTEXT_EXTENSION_PATH)) {
      return baseExtensions;
    }

    return {
      ...baseExtensions,
      extensions: [...extensions, conversationExtension],
    };
  };

  scopedLoader.getSystemPrompt = () => {
    return typeof baseResourceLoader.getSystemPrompt === "function"
      ? baseResourceLoader.getSystemPrompt()
      : "";
  };

  scopedLoader.setConversationContext = (context) => {
    conversationContext = context && typeof context === "object"
      ? {
        ...context,
        systemPrompt: String(context.systemPrompt || "").trim(),
        messageContent: String(context.messageContent || "").trim(),
      }
      : null;
  };

  scopedLoader.clearConversationContext = () => {
    conversationContext = null;
  };

  return scopedLoader;
}

export class ConversationManager {
  constructor({ agentDir }) {
    this.agentDir = agentDir;
    this.baseDir = path.join(agentDir, "conversations");
    this.timelinesDir = path.join(this.baseDir, "timelines");
    this.snapshotsDir = path.join(this.baseDir, "snapshots");
    this.bindingsPath = path.join(this.baseDir, "bindings.json");
    this.indexPath = path.join(this.baseDir, "index.json");
    this._writeQueue = Promise.resolve();
  }

  init() {
    fs.mkdirSync(this.timelinesDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    if (!fs.existsSync(this.bindingsPath)) {
      writeJson(this.bindingsPath, this._emptyBindings());
    }
    if (!fs.existsSync(this.indexPath)) {
      writeJson(this.indexPath, this._emptyIndex());
    }
  }

  async ensureLocalSession(sessionPath, meta = {}) {
    if (!sessionPath) return null;
    return this._enqueue(() => this._ensureBinding({
      bucket: "localSessions",
      sourceType: "local_session",
      sourceKey: this._localKey(sessionPath),
      sessionPath,
      meta,
    }));
  }

  async ensureBridgeSession(sessionKey, { guest = false, meta = {} } = {}) {
    if (!sessionKey) return null;
    return this._enqueue(() => this._ensureBinding({
      bucket: guest ? "bridgeGuestSessions" : "bridgeOwnerSessions",
      sourceType: guest ? "bridge_guest" : "bridge_owner",
      sourceKey: sessionKey,
      sessionPath: null,
      meta,
    }));
  }

  async linkLocalSession(sessionPath, conversationId, meta = {}) {
    if (!sessionPath || !conversationId) return null;
    return this._enqueue(() => this._linkBinding({
      bucket: "localSessions",
      sourceType: "local_session",
      sourceKey: this._localKey(sessionPath),
      sessionPath,
      conversationId,
      meta,
    }));
  }

  async linkBridgeSession(sessionKey, conversationId, { guest = false, meta = {} } = {}) {
    if (!sessionKey || !conversationId) return null;
    return this._enqueue(() => this._linkBinding({
      bucket: guest ? "bridgeGuestSessions" : "bridgeOwnerSessions",
      sourceType: guest ? "bridge_guest" : "bridge_owner",
      sourceKey: sessionKey,
      sessionPath: null,
      conversationId,
      meta,
    }));
  }

  async appendLocalSessionMessages(sessionPath, messages, meta = {}) {
    if (!sessionPath || !Array.isArray(messages) || messages.length === 0) return null;
    return this._enqueue(() => {
      const sourceKey = this._localKey(sessionPath);
      const conversationId = this._ensureBinding({
        bucket: "localSessions",
        sourceType: "local_session",
        sourceKey,
        sessionPath,
        meta,
      });
      this._appendMessages({
        bucket: "localSessions",
        conversationId,
        sourceType: "local_session",
        sourceKey,
        sessionPath,
        messages,
        meta,
      });
      return conversationId;
    });
  }

  async appendBridgeSessionMessages(sessionKey, messages, { guest = false, meta = {} } = {}) {
    if (!sessionKey || !Array.isArray(messages) || messages.length === 0) return null;
    return this._enqueue(() => {
      const sourceType = guest ? "bridge_guest" : "bridge_owner";
      const bucket = guest ? "bridgeGuestSessions" : "bridgeOwnerSessions";
      const conversationId = this._ensureBinding({
        bucket,
        sourceType,
        sourceKey: sessionKey,
        sessionPath: null,
        meta,
      });
      this._appendMessages({
        bucket,
        conversationId,
        sourceType,
        sourceKey: sessionKey,
        sessionPath: null,
        messages,
        meta,
      });
      return conversationId;
    });
  }

  async prepareLocalPromptContext(sessionPath) {
    if (!sessionPath) return null;
    return this._enqueue(() => this._preparePromptContext({
      bucket: "localSessions",
      sourceType: "local_session",
      sourceKey: this._localKey(sessionPath),
    }));
  }

  async prepareBridgePromptContext(sessionKey, { guest = false } = {}) {
    if (!sessionKey) return null;
    return this._enqueue(() => this._preparePromptContext({
      bucket: guest ? "bridgeGuestSessions" : "bridgeOwnerSessions",
      sourceType: guest ? "bridge_guest" : "bridge_owner",
      sourceKey: sessionKey,
    }));
  }

  async markLocalPromptContextSeen(sessionPath, uptoSeq) {
    if (!sessionPath || !Number.isFinite(uptoSeq)) return false;
    return this._enqueue(() => this._markPromptContextSeen("localSessions", this._localKey(sessionPath), uptoSeq));
  }

  async markBridgePromptContextSeen(sessionKey, uptoSeq, { guest = false } = {}) {
    if (!sessionKey || !Number.isFinite(uptoSeq)) return false;
    return this._enqueue(() => this._markPromptContextSeen(
      guest ? "bridgeGuestSessions" : "bridgeOwnerSessions",
      sessionKey,
      uptoSeq,
    ));
  }

  getConversationIdForLocalSession(sessionPath) {
    const entry = this._getBinding("localSessions", this._localKey(sessionPath));
    return entry?.conversationId || null;
  }

  getConversationIdForBridgeSession(sessionKey, { guest = false } = {}) {
    const bucket = guest ? "bridgeGuestSessions" : "bridgeOwnerSessions";
    const entry = this._getBinding(bucket, sessionKey);
    return entry?.conversationId || null;
  }

  getBindingInfoForLocalSession(sessionPath) {
    return this._getBindingInfo("localSessions", this._localKey(sessionPath));
  }

  getBindingInfoForBridgeSession(sessionKey, { guest = false } = {}) {
    return this._getBindingInfo(
      guest ? "bridgeGuestSessions" : "bridgeOwnerSessions",
      sessionKey,
    );
  }

  readTimeline(conversationId) {
    if (!conversationId) return [];
    try {
      return fs.readFileSync(this._timelinePath(conversationId), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  readSnapshot(conversationId) {
    if (!conversationId) return null;
    return readJson(this._snapshotPath(conversationId), null);
  }

  _enqueue(task) {
    const run = this._writeQueue.then(task, task);
    this._writeQueue = run.catch(() => {});
    return run;
  }

  _emptyBindings() {
    return {
      version: STORE_VERSION,
      localSessions: {},
      bridgeOwnerSessions: {},
      bridgeGuestSessions: {},
    };
  }

  _emptyIndex() {
    return {
      version: STORE_VERSION,
      conversations: {},
    };
  }

  _normalizeBindingBucket(bucket) {
    const normalized = {};
    for (const [key, value] of Object.entries(bucket || {})) {
      const entry = normalizeBindingEntry(value);
      if (entry) normalized[key] = entry;
    }
    return normalized;
  }

  _readBindings() {
    const raw = readJson(this.bindingsPath, this._emptyBindings());
    return {
      version: raw.version || STORE_VERSION,
      localSessions: this._normalizeBindingBucket(raw.localSessions),
      bridgeOwnerSessions: this._normalizeBindingBucket(raw.bridgeOwnerSessions),
      bridgeGuestSessions: this._normalizeBindingBucket(raw.bridgeGuestSessions),
    };
  }

  _writeBindings(bindings) {
    writeJson(this.bindingsPath, bindings);
  }

  _readIndex() {
    return readJson(this.indexPath, this._emptyIndex());
  }

  _writeIndex(index) {
    writeJson(this.indexPath, index);
  }

  _getBinding(bucket, sourceKey) {
    if (!sourceKey) return null;
    const bindings = this._readBindings();
    return normalizeBindingEntry(bindings[bucket]?.[sourceKey]);
  }

  _getBindingInfo(bucket, sourceKey) {
    const binding = this._getBinding(bucket, sourceKey);
    if (!binding) return null;
    const index = this._readIndex();
    const conversation = index.conversations[binding.conversationId] || null;
    return {
      bucket,
      sourceKey,
      conversationId: binding.conversationId,
      lastSeenSeq: binding.lastSeenSeq || 0,
      conversationLastSeq: conversation?.lastSeq || 0,
      updatedAt: binding.updatedAt || null,
    };
  }

  _ensureBinding({ bucket, sourceType, sourceKey, sessionPath, meta }) {
    const bindings = this._readBindings();
    const index = this._readIndex();
    const existing = normalizeBindingEntry(bindings[bucket][sourceKey]);
    if (existing) {
      bindings[bucket][sourceKey] = existing;
      this._touchConversation(index, existing.conversationId, {
        bucket,
        sourceKey,
        sourceType,
        sessionPath,
        meta,
      });
      this._writeBindings(bindings);
      this._writeIndex(index);
      return existing.conversationId;
    }

    const conversationId = crypto.randomUUID();
    bindings[bucket][sourceKey] = {
      conversationId,
      lastSeenSeq: 0,
      updatedAt: nowIso(),
    };
    this._touchConversation(index, conversationId, {
      bucket,
      sourceKey,
      sourceType,
      sessionPath,
      meta,
      createdAt: nowIso(),
    });
    this._writeBindings(bindings);
    this._writeIndex(index);
    return conversationId;
  }

  _linkBinding({ bucket, sourceType, sourceKey, sessionPath, conversationId, meta }) {
    const bindings = this._readBindings();
    const index = this._readIndex();
    const conversation = index.conversations[conversationId] || {
      id: conversationId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastSeq: 0,
      bindings: {
        localSessions: [],
        bridgeOwnerSessions: [],
        bridgeGuestSessions: [],
      },
      sources: [],
    };

    index.conversations[conversationId] = conversation;
    bindings[bucket][sourceKey] = {
      conversationId,
      lastSeenSeq: 0,
      updatedAt: nowIso(),
    };
    this._touchConversation(index, conversationId, {
      bucket,
      sourceKey,
      sourceType,
      sessionPath,
      meta,
    });
    this._writeBindings(bindings);
    this._writeIndex(index);
    log.log(`link ${sourceLabel(sourceType, sourceKey)} -> ${shortId(conversationId)}`);
    return conversationId;
  }

  _touchConversation(index, conversationId, { bucket, sourceKey, sourceType, sessionPath, meta, createdAt }) {
    const current = index.conversations[conversationId] || {
      id: conversationId,
      createdAt: createdAt || nowIso(),
      updatedAt: createdAt || nowIso(),
      lastSeq: 0,
      bindings: {
        localSessions: [],
        bridgeOwnerSessions: [],
        bridgeGuestSessions: [],
      },
      sources: [],
    };

    current.updatedAt = nowIso();
    if (!current.bindings[bucket].includes(sourceKey)) {
      current.bindings[bucket].push(sourceKey);
    }
    if (!current.sources.includes(sourceType)) {
      current.sources.push(sourceType);
    }
    if (sessionPath) {
      current.lastSessionPath = sessionPath;
    }
    if (meta && Object.keys(meta).length > 0) {
      current.meta = { ...(current.meta || {}), ...meta };
    }
    index.conversations[conversationId] = current;
  }

  _appendMessages({ bucket, conversationId, sourceType, sourceKey, sessionPath, messages, meta }) {
    const bindings = this._readBindings();
    const index = this._readIndex();
    const conversation = index.conversations[conversationId];
    if (!conversation) {
      throw new Error(`conversation "${conversationId}" not found`);
    }

    const recordedAt = nowIso();
    const turnId = crypto.randomUUID();
    const lines = [];
    const appendedEvents = [];

    for (const message of messages) {
      if (isSyntheticConversationContextMessage(message)) {
        continue;
      }
      conversation.lastSeq += 1;
      const event = {
        version: STORE_VERSION,
        eventType: "session_message",
        conversationId,
        seq: conversation.lastSeq,
        recordedAt,
        turnId,
        sourceType,
        sourceKey,
        sessionPath: sessionPath || undefined,
        messageRole: message?.role || "unknown",
        text: extractText(message?.content),
        rawMessage: cloneValue(message),
        meta: meta && Object.keys(meta).length > 0 ? meta : undefined,
      };
      lines.push(JSON.stringify(event));
      appendedEvents.push(event);
    }

    if (lines.length === 0) {
      return;
    }

    conversation.updatedAt = recordedAt;
    if (sessionPath) {
      conversation.lastSessionPath = sessionPath;
    }
    if (meta && Object.keys(meta).length > 0) {
      conversation.meta = { ...(conversation.meta || {}), ...meta };
    }

    const binding = normalizeBindingEntry(bindings[bucket]?.[sourceKey]);
    if (binding) {
      binding.lastSeenSeq = conversation.lastSeq;
      binding.updatedAt = recordedAt;
      bindings[bucket][sourceKey] = binding;
    }

    fs.mkdirSync(this.timelinesDir, { recursive: true });
    fs.appendFileSync(this._timelinePath(conversationId), lines.join("\n") + "\n", "utf8");
    this._writeSnapshot(this._buildSnapshot(conversationId, conversation, appendedEvents));
    this._writeBindings(bindings);
    this._writeIndex(index);
    const startSeq = conversation.lastSeq - lines.length + 1;
    log.log(
      `append ${sourceLabel(sourceType, sourceKey)} +${lines.length} -> ${shortId(conversationId)} seq=${startSeq}-${conversation.lastSeq}`,
    );
  }

  _preparePromptContext({ bucket, sourceType, sourceKey }) {
    const binding = this._getBinding(bucket, sourceKey);
    if (!binding?.conversationId) return null;

    const index = this._readIndex();
    const conversation = index.conversations[binding.conversationId];
    if (!conversation) return null;

    const lastSeenSeq = binding.lastSeenSeq || 0;
    const lastSeq = conversation.lastSeq || 0;
    if (lastSeq <= lastSeenSeq) {
      return {
        conversationId: binding.conversationId,
        uptoSeq: lastSeq,
        pendingCount: 0,
        systemPrompt: "",
        messageContent: "",
      };
    }

    const pendingEvents = this.readTimeline(binding.conversationId)
      .filter((event) => event.seq > lastSeenSeq)
      .filter((event) => !(event.sourceType === sourceType && event.sourceKey === sourceKey))
      .filter(isMeaningfulPendingEvent);

    if (pendingEvents.length === 0) {
      return {
        conversationId: binding.conversationId,
        uptoSeq: lastSeq,
        pendingCount: 0,
        systemPrompt: "",
        messageContent: "",
      };
    }

    const limitedEvents = this._limitEventsForContext(pendingEvents);
    const omittedCount = pendingEvents.length - limitedEvents.length;
    const snapshot = this.readSnapshot(binding.conversationId);
    const rendered = limitedEvents.map((event) => `- ${summarizeEvent(event)}`).join("\n");
    const currentSource = sourceLabel(sourceType, sourceKey);
    const snapshotBlock = this._renderSnapshot(snapshot);
    const systemPrompt = [
      "Shared conversation context may be attached for linked channels that belong to the same ongoing conversation.",
      "Treat that context as authoritative recent history, but do not confuse it with the current channel transcript.",
      "Keep source attribution exact: desktop events happened on desktop; qq/telegram/feishu/whatsapp events happened on those channels.",
      "If the user asks what just happened, what your previous message was, or asks to continue, answer from the shared conversation context first.",
      "Do not mention hidden channel history unless the user asks or the task requires it.",
    ].join("\n");
    const messageContent = [
      `[Linked conversation timeline | current source: ${currentSource}]`,
      "This block is system-provided context from other linked channels in the same conversation.",
      "It is not a new user message on the current channel.",
      "Use it to stay consistent with the user's task, decisions, and recent tool outcomes.",
      "Preserve the original source labels when referring to where something happened.",
      snapshotBlock || null,
      omittedCount > 0 ? `Older pending updates omitted for brevity: ${omittedCount}.` : null,
      "",
      rendered,
    ].filter(Boolean).join("\n");

    log.log(
      `prepare prompt ${currentSource} -> ${shortId(binding.conversationId)} pending=${pendingEvents.length} seen=${lastSeenSeq} last=${lastSeq}`,
    );

    return {
      conversationId: binding.conversationId,
      uptoSeq: lastSeq,
      pendingCount: pendingEvents.length,
      currentSource,
      systemPrompt,
      messageContent,
    };
  }

  _limitEventsForContext(events) {
    const tail = events.slice(-MAX_CONTEXT_EVENTS);
    const kept = [];
    let totalChars = 0;

    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const rendered = summarizeEvent(tail[i]);
      totalChars += rendered.length + 2;
      if (kept.length > 0 && totalChars > MAX_CONTEXT_CHARS) {
        break;
      }
      kept.unshift(tail[i]);
    }

    return kept;
  }

  _buildSnapshot(conversationId, conversation, appendedEvents) {
    const previous = this.readSnapshot(conversationId) || {
      version: STORE_VERSION,
      conversationId,
      updatedAt: conversation?.updatedAt || nowIso(),
      lastSeq: 0,
      lastUserMessage: null,
      lastAssistantMessage: null,
      recentUserMessages: [],
      recentAssistantMessages: [],
      recentToolResults: [],
      currentObjective: null,
      openLoops: [],
      confirmedConstraints: [],
      recentDecisions: [],
      sources: {},
    };

    const snapshot = {
      ...previous,
      version: STORE_VERSION,
      conversationId,
      updatedAt: conversation?.updatedAt || nowIso(),
      lastSeq: conversation?.lastSeq || previous.lastSeq || 0,
      recentUserMessages: [...(previous.recentUserMessages || [])],
      recentAssistantMessages: [...(previous.recentAssistantMessages || [])],
      recentToolResults: [...(previous.recentToolResults || [])],
      currentObjective: previous.currentObjective || null,
      openLoops: [...(previous.openLoops || [])],
      confirmedConstraints: [...(previous.confirmedConstraints || [])],
      recentDecisions: [...(previous.recentDecisions || [])],
      sources: { ...(previous.sources || {}) },
    };

    for (const event of appendedEvents) {
      if (isSyntheticConversationContextEvent(event)) continue;
      const source = sourceLabel(event.sourceType, event.sourceKey);
      snapshot.sources[source] = event.seq;

      if (event.messageRole === "user") {
        const item = {
          seq: event.seq,
          source,
          text: compactText(event.text),
          recordedAt: event.recordedAt,
        };
        snapshot.lastUserMessage = item;
        snapshot.currentObjective = {
          ...item,
          text: compactText(event.text),
        };
        snapshot.recentUserMessages.push(item);
        snapshot.recentUserMessages = trimRecentItems(snapshot.recentUserMessages);
        if (looksLikeQuestion(event.text)) {
          const openLoop = makeSnapshotFact(event, event.text, "open_loop");
          snapshot.openLoops = pushUniqueFact(snapshot.openLoops, openLoop);
        }
        const constraintText = extractConstraintCandidate(event.text);
        if (constraintText) {
          const constraint = makeSnapshotFact(event, constraintText, "constraint");
          snapshot.confirmedConstraints = pushUniqueFact(snapshot.confirmedConstraints, constraint);
        }
      } else if (event.messageRole === "assistant") {
        const item = {
          seq: event.seq,
          source,
          text: compactText(event.text),
          recordedAt: event.recordedAt,
        };
        snapshot.lastAssistantMessage = item;
        snapshot.recentAssistantMessages.push(item);
        snapshot.recentAssistantMessages = trimRecentItems(snapshot.recentAssistantMessages);
        const decisionText = extractDecisionCandidate(event.text);
        if (decisionText) {
          const decision = makeSnapshotFact(event, decisionText, "decision");
          snapshot.recentDecisions = pushUniqueFact(snapshot.recentDecisions, decision);
        }
      } else if (event.messageRole === "toolResult") {
        const item = {
          seq: event.seq,
          source,
          toolName: event.rawMessage?.toolName || "tool",
          text: compactText(event.text || event.rawMessage?.content || ""),
          recordedAt: event.recordedAt,
        };
        snapshot.recentToolResults.push(item);
        snapshot.recentToolResults = trimRecentItems(snapshot.recentToolResults);
      }
    }

    return snapshot;
  }

  _writeSnapshot(snapshot) {
    if (!snapshot?.conversationId) return;
    writeJson(this._snapshotPath(snapshot.conversationId), snapshot);
  }

  _renderSnapshot(snapshot) {
    if (!snapshot || !snapshot.lastSeq) return "";

    const sections = [
      "[Conversation snapshot]",
      `Last seq: ${snapshot.lastSeq}`,
    ];

    if (snapshot.lastUserMessage?.text) {
      sections.push(`Latest user message: [${snapshot.lastUserMessage.source}] ${snapshot.lastUserMessage.text}`);
    }
    if (snapshot.lastAssistantMessage?.text) {
      sections.push(`Latest assistant message: [${snapshot.lastAssistantMessage.source}] ${snapshot.lastAssistantMessage.text}`);
    }
    if (snapshot.currentObjective?.text) {
      sections.push(`Current objective: [${snapshot.currentObjective.source}] ${snapshot.currentObjective.text}`);
    }
    if (Array.isArray(snapshot.openLoops) && snapshot.openLoops.length > 0) {
      sections.push("Open loops:");
      for (const item of snapshot.openLoops) {
        sections.push(`- [${item.source}] ${item.text}`);
      }
    }
    if (Array.isArray(snapshot.confirmedConstraints) && snapshot.confirmedConstraints.length > 0) {
      sections.push("Confirmed constraints:");
      for (const item of snapshot.confirmedConstraints) {
        sections.push(`- [${item.source}] ${item.text}`);
      }
    }
    if (Array.isArray(snapshot.recentDecisions) && snapshot.recentDecisions.length > 0) {
      sections.push("Recent decisions:");
      for (const item of snapshot.recentDecisions) {
        sections.push(`- [${item.source}] ${item.text}`);
      }
    }
    if (Array.isArray(snapshot.recentToolResults) && snapshot.recentToolResults.length > 0) {
      sections.push("Recent tool results:");
      for (const item of snapshot.recentToolResults) {
        sections.push(`- [${item.source}] ${item.toolName}: ${item.text || "(no text result)"}`);
      }
    }

    return sections.join("\n");
  }

  _markPromptContextSeen(bucket, sourceKey, uptoSeq) {
    const bindings = this._readBindings();
    const entry = normalizeBindingEntry(bindings[bucket]?.[sourceKey]);
    if (!entry) return false;
    const prevSeenSeq = entry.lastSeenSeq || 0;
    entry.lastSeenSeq = Math.max(prevSeenSeq, uptoSeq);
    entry.updatedAt = nowIso();
    bindings[bucket][sourceKey] = entry;
    this._writeBindings(bindings);
    if (entry.lastSeenSeq !== prevSeenSeq) {
      log.log(`cursor ${bucket}:${sourceKey} ${prevSeenSeq} -> ${entry.lastSeenSeq}`);
    }
    return true;
  }

  _timelinePath(conversationId) {
    return path.join(this.timelinesDir, `${conversationId}.jsonl`);
  }

  _snapshotPath(conversationId) {
    return path.join(this.snapshotsDir, `${conversationId}.json`);
  }

  _localKey(sessionPath) {
    return sessionPath ? path.basename(sessionPath) : null;
  }
}
