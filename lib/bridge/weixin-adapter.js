/**
 * weixin-adapter.js — 微信官方接口适配器
 *
 * 通过官方长轮询接口接收私聊消息，并使用 sendmessage 发送回复。
 * 当前支持：
 *   - 扫码登录获取 bot token
 *   - 文本消息收发
 *   - 图片输入
 *   - 文件 / 视频输入（落地为本地路径）
 *   - present_files 媒体回发
 *   - 单账号 direct chat
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  DEFAULT_WEIXIN_CDN_BASE_URL,
  extractInboundWeixinMedia,
  sendWeixinMediaFiles,
} from "./weixin-media.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const DEFAULT_ILINK_BOT_TYPE = "3";
const TYPING_STATUS = {
  TYPING: 1,
  CANCEL: 2,
};

export const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";

const activeLogins = new Map();

function readChannelVersion() {
  try {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

const CHANNEL_VERSION = readChannelVersion();

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token, body = "") {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": buildWechatUin(),
  };
  if (body) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function postJson(baseUrl, endpoint, payload, { token, timeoutMs, label }) {
  const body = JSON.stringify(payload);
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(token, body),
      body,
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`${label} ${res.status}: ${raw}`);
    }
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(baseUrl, endpoint, { timeoutMs, label }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "iLink-App-ClientVersion": "1",
      },
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`${label} ${res.status}: ${raw}`);
    }
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timer);
  }
}

function isLoginFresh(login) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins() {
  for (const [sessionKey, login] of activeLogins.entries()) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(sessionKey);
    }
  }
}

export async function startWeixinQrLogin({ apiBaseUrl = DEFAULT_WEIXIN_BASE_URL, sessionKey }) {
  const finalSessionKey = sessionKey || crypto.randomUUID();
  purgeExpiredLogins();

  const existing = activeLogins.get(finalSessionKey);
  if (existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      sessionKey: finalSessionKey,
      qrcodeUrl: existing.qrcodeUrl,
      message: "二维码已就绪，请使用微信扫描。",
    };
  }

  const endpoint = `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_ILINK_BOT_TYPE)}`;
  const data = await getJson(apiBaseUrl, endpoint, {
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "weixin.get_bot_qrcode",
  });

  activeLogins.set(finalSessionKey, {
    sessionKey: finalSessionKey,
    qrcode: data.qrcode,
    qrcodeUrl: data.qrcode_img_content,
    startedAt: Date.now(),
  });

  return {
    sessionKey: finalSessionKey,
    qrcodeUrl: data.qrcode_img_content,
    message: "使用微信扫描二维码完成登录。",
  };
}

export async function waitForWeixinQrLogin({
  sessionKey,
  apiBaseUrl = DEFAULT_WEIXIN_BASE_URL,
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
}) {
  const login = activeLogins.get(sessionKey);
  if (!login) {
    return { connected: false, message: "当前没有进行中的登录。" };
  }
  if (!isLoginFresh(login)) {
    activeLogins.delete(sessionKey);
    return { connected: false, expired: true, message: "二维码已过期，请重新生成。" };
  }

  const endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}`;
  try {
    const data = await getJson(apiBaseUrl, endpoint, {
      timeoutMs,
      label: "weixin.get_qrcode_status",
    });

    if (data.status === "confirmed" && data.bot_token && data.ilink_bot_id) {
      activeLogins.delete(sessionKey);
      return {
        connected: true,
        accountId: data.ilink_bot_id,
        userId: data.ilink_user_id,
        token: data.bot_token,
        baseUrl: data.baseurl || apiBaseUrl,
        message: "微信登录成功。",
      };
    }
    if (data.status === "expired") {
      activeLogins.delete(sessionKey);
      return { connected: false, expired: true, message: "二维码已过期，请重新生成。" };
    }

    return {
      connected: false,
      status: data.status || "wait",
      message: data.status === "scaned" ? "已扫码，请在微信中确认。" : "等待扫码中…",
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { connected: false, status: "wait", message: "等待扫码中…" };
    }
    throw err;
  }
}

function bodyFromItemList(itemList) {
  if (!Array.isArray(itemList) || itemList.length === 0) return "";
  for (const item of itemList) {
    if (item?.type === 1 && item?.text_item?.text) {
      return String(item.text_item.text);
    }
    if (item?.type === 3 && item?.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}

async function buildInboundPayload(msg, { storageDir, cdnBaseUrl }) {
  const baseText = bodyFromItemList(msg?.item_list);
  const media = await extractInboundWeixinMedia({
    itemList: msg?.item_list,
    storageDir,
    cdnBaseUrl,
  });

  const promptParts = [];
  if (baseText) promptParts.push(String(baseText));
  if (media.images.length > 0) {
    promptParts.push(`[微信图片] 已附加 ${media.images.length} 张图片。`);
  }
  if (media.promptNotes.length > 0) {
    promptParts.push(...media.promptNotes);
  }

  let text = promptParts.join("\n\n").trim();
  if (!text && media.images.length > 0) {
    text = "请查看微信发来的图片。";
  }

  const displayParts = [];
  if (baseText) displayParts.push(String(baseText));
  if (media.displayTokens.length > 0) {
    displayParts.push(...media.displayTokens);
  }
  const displayText = displayParts.join("\n").trim() || text;

  return {
    text,
    displayText,
    images: media.images,
    attachments: media.attachments,
  };
}

function buildClientId() {
  return `openclaw-weixin:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export function createWeixinAdapter({
  baseUrl,
  token,
  accountId,
  userId,
  storageDir = path.join(process.cwd(), ".hanako-weixin-media"),
  cdnBaseUrl = DEFAULT_WEIXIN_CDN_BASE_URL,
  onMessage,
  onStatus,
}) {
  let stopped = false;
  let syncBuf = "";
  let connected = false;
  let longPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  const contextTokens = new Map();
  const typingTickets = new Map();

  async function getTypingTicket(chatId, contextToken) {
    const cached = typingTickets.get(chatId);
    if (cached) return cached;

    const data = await postJson(baseUrl, "ilink/bot/getconfig", {
      ilink_user_id: chatId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    }, {
      token,
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: "weixin.getconfig",
    });

    const typingTicket = data?.typing_ticket || "";
    if (typingTicket) {
      typingTickets.set(chatId, typingTicket);
    }
    return typingTicket;
  }

  async function sendTypingStatus(chatId, status) {
    const contextToken = contextTokens.get(chatId);
    if (!contextToken) return;
    const typingTicket = await getTypingTicket(chatId, contextToken);
    if (!typingTicket) return;

    await postJson(baseUrl, "ilink/bot/sendtyping", {
      ilink_user_id: chatId,
      typing_ticket: typingTicket,
      status,
      base_info: buildBaseInfo(),
    }, {
      token,
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: "weixin.sendtyping",
    });
  }

  async function sendReply(chatId, text) {
    const contextToken = contextTokens.get(chatId);
    if (!contextToken) {
      throw new Error("weixin context_token missing for current user");
    }
    const chunks = [];
    const MAX_CHARS = 1800;
    for (let i = 0; i < text.length; i += MAX_CHARS) {
      chunks.push(text.slice(i, i + MAX_CHARS));
    }
    if (chunks.length === 0) chunks.push("");

    for (const chunk of chunks) {
      await postJson(baseUrl, "ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: chatId,
          client_id: buildClientId(),
          message_type: 2,
          message_state: 2,
          item_list: chunk
            ? [{ type: 1, text_item: { text: chunk } }]
            : undefined,
          context_token: contextToken,
        },
        base_info: buildBaseInfo(),
      }, {
        token,
        timeoutMs: DEFAULT_API_TIMEOUT_MS,
        label: "weixin.sendmessage",
      });
    }
  }

  async function sendMediaFiles(chatId, filePaths, text = "") {
    const contextToken = contextTokens.get(chatId);
    if (!contextToken) {
      throw new Error("weixin context_token missing for current user");
    }
    const normalized = (filePaths || [])
      .map((filePath) => path.resolve(String(filePath)))
      .filter(Boolean);
    if (normalized.length === 0) return;

    await sendWeixinMediaFiles({
      files: normalized,
      toUserId: chatId,
      baseUrl,
      token,
      contextToken,
      fromUserId: userId || accountId || "",
      caption: text,
      cdnBaseUrl,
    });
  }

  async function pollOnce() {
    const data = await postJson(baseUrl, "ilink/bot/getupdates", {
      get_updates_buf: syncBuf,
      base_info: {},
    }, {
      token,
      timeoutMs: longPollTimeoutMs,
      label: "weixin.getupdates",
    }).catch((err) => {
      if (err instanceof Error && err.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: syncBuf };
      }
      throw err;
    });

    if (typeof data?.get_updates_buf === "string") {
      syncBuf = data.get_updates_buf;
    }
    if (typeof data?.longpolling_timeout_ms === "number" && data.longpolling_timeout_ms > 0) {
      longPollTimeoutMs = data.longpolling_timeout_ms;
    }
    if (data?.ret && data.ret !== 0) {
      throw new Error(data.errmsg || `getupdates failed: ${data.errcode || data.ret}`);
    }
    if (!connected) {
      connected = true;
      onStatus?.("connected");
    }

    for (const msg of data?.msgs || []) {
      if (msg?.message_type && msg.message_type !== 1) continue;
      const fromUserId = msg?.from_user_id;
      if (!fromUserId) continue;
      if (msg?.context_token) {
        contextTokens.set(fromUserId, msg.context_token);
      }
      let inbound;
      try {
        inbound = await buildInboundPayload(msg, { storageDir, cdnBaseUrl });
      } catch (err) {
        const fallback = bodyFromItemList(msg?.item_list) || "[微信媒体消息]";
        onStatus?.("error", err.message);
        inbound = {
          text: fallback,
          displayText: fallback,
          images: [],
          attachments: [],
        };
      }
      if (!inbound.text && !(inbound.images?.length)) continue;
      onMessage?.({
        platform: "weixin",
        chatId: fromUserId,
        userId: fromUserId,
        sessionKey: `wx_dm_${fromUserId}`,
        text: inbound.text,
        displayText: inbound.displayText,
        images: inbound.images,
        attachments: inbound.attachments,
        senderName: fromUserId,
        isGroup: false,
      });
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        await pollOnce();
      } catch (err) {
        if (stopped) break;
        connected = false;
        onStatus?.("error", err.message);
        await sleep(3000);
      }
    }
  }

  void loop();

  return {
    sendReply,
    sendMediaFiles,

    async startTyping(chatId) {
      await sendTypingStatus(chatId, TYPING_STATUS.TYPING);
    },

    async stopTyping(chatId) {
      await sendTypingStatus(chatId, TYPING_STATUS.CANCEL);
    },

    stop() {
      stopped = true;
    },

    resolveOwnerChatId(targetUserId) {
      return targetUserId || null;
    },
  };
}
