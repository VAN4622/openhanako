/**
 * weixin-media.js — 微信媒体辅助
 *
 * 负责：
 *   - 入站图片 / 文件 / 视频的 CDN 下载与解密
 *   - 出站媒体的 getuploadurl + CDN 上传 + sendmessage
 *
 * 设计目标是给 Hanako 的 bridge 层提供最小媒体能力，
 * 不引入额外的插件运行时依赖。
 */

import crypto from "crypto";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";

export const DEFAULT_WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

const DEFAULT_API_TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MESSAGE_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
};
const UPLOAD_MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
};

function readChannelVersion() {
  try {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

const CHANNEL_VERSION = readChannelVersion();

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function buildClientId() {
  return `openclaw-weixin:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
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

async function postJson(baseUrl, endpoint, payload, { token, timeoutMs = DEFAULT_API_TIMEOUT_MS, label }) {
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

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`${label}: invalid aes_key payload (${decoded.length} bytes)`);
}

async function fetchBuffer(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label}: CDN ${res.status} ${res.statusText} ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function downloadAndDecryptBuffer(encryptedQueryParam, aesKeyBase64, cdnBaseUrl, label) {
  const encrypted = await fetchBuffer(buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl), label);
  const key = parseAesKey(aesKeyBase64, label);
  return decryptAesEcb(encrypted, key);
}

async function downloadPlainBuffer(encryptedQueryParam, cdnBaseUrl, label) {
  return fetchBuffer(buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl), label);
}

function inferImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 && buf.slice(0, 6).toString("ascii") === "GIF87a") {
    return "image/gif";
  }
  if (buf.length >= 6 && buf.slice(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "image/jpeg";
}

function mimeToExt(mime) {
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/json": ".json",
    "application/zip": ".zip",
    "application/octet-stream": ".bin",
  };
  return map[mime] || ".bin";
}

function extToMime(ext) {
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".json": "application/json",
    ".zip": "application/zip",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}

function sanitizeFileName(name, fallback = "file") {
  const trimmed = String(name || fallback).trim();
  return trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || fallback;
}

async function saveBuffer(buffer, dir, baseName, ext) {
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new Error(`media too large: ${buffer.length} bytes`);
  }
  await fs.mkdir(dir, { recursive: true });
  const safeBase = sanitizeFileName(baseName, "media");
  const filePath = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeBase}${ext}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

function getFileMime(filePath) {
  return extToMime(path.extname(filePath));
}

async function uploadBufferToCdn({ buffer, uploadParam, filekey, cdnBaseUrl, aesKey, label }) {
  const ciphertext = encryptAesEcb(buffer, aesKey);
  const res = await fetch(buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!res.ok) {
    const errMsg = res.headers.get("x-error-message") || (await res.text().catch(() => ""));
    throw new Error(`${label}: CDN upload failed ${res.status} ${errMsg}`);
  }
  const downloadParam = res.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error(`${label}: CDN response missing x-encrypted-param`);
  }
  return {
    downloadParam,
    ciphertextSize: ciphertext.length,
  };
}

async function getUploadUrl({ baseUrl, token, toUserId, mediaType, filePath, aesKeyHex }) {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const resp = await postJson(baseUrl, "ilink/bot/getuploadurl", {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: buildBaseInfo(),
  }, {
    token,
    label: "weixin.getuploadurl",
  });
  if (!resp?.upload_param) {
    throw new Error("weixin.getuploadurl missing upload_param");
  }
  return {
    uploadParam: resp.upload_param,
    filekey,
    rawsize,
    filesize,
    plaintext,
  };
}

async function sendMessageItems({ baseUrl, token, toUserId, fromUserId, contextToken, items }) {
  for (const item of items) {
    await postJson(baseUrl, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: buildClientId(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }, {
      token,
      label: "weixin.sendmessage",
    });
  }
}

export async function extractInboundWeixinMedia({ itemList, storageDir, cdnBaseUrl = DEFAULT_WEIXIN_CDN_BASE_URL }) {
  const images = [];
  const promptNotes = [];
  const displayTokens = [];
  const attachments = [];

  if (!Array.isArray(itemList) || itemList.length === 0) {
    return { images, promptNotes, displayTokens, attachments };
  }

  const inboundDir = path.join(storageDir, "inbound");

  for (const item of itemList) {
    if (item?.type === MESSAGE_ITEM_TYPE.IMAGE) {
      const img = item.image_item;
      if (!img?.media?.encrypt_query_param) continue;
      const aesKeyBase64 = img.aeskey
        ? Buffer.from(img.aeskey, "hex").toString("base64")
        : img.media.aes_key;
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(img.media.encrypt_query_param, aesKeyBase64, cdnBaseUrl, "weixin.image")
        : await downloadPlainBuffer(img.media.encrypt_query_param, cdnBaseUrl, "weixin.image");
      const mimeType = inferImageMime(buf);
      const filePath = await saveBuffer(buf, inboundDir, "image", mimeToExt(mimeType));
      images.push({ type: "image", data: buf.toString("base64"), mimeType });
      attachments.push({ kind: "image", path: filePath, name: path.basename(filePath), mimeType });
      displayTokens.push("[图片]");
    } else if (item?.type === MESSAGE_ITEM_TYPE.FILE) {
      const fileItem = item.file_item;
      if (!fileItem?.media?.encrypt_query_param || !fileItem.media.aes_key) continue;
      const buf = await downloadAndDecryptBuffer(fileItem.media.encrypt_query_param, fileItem.media.aes_key, cdnBaseUrl, "weixin.file");
      const name = sanitizeFileName(fileItem.file_name || "file.bin");
      const mimeType = getFileMime(name);
      const filePath = await saveBuffer(buf, inboundDir, path.basename(name, path.extname(name)), path.extname(name) || ".bin");
      attachments.push({ kind: "file", path: filePath, name, mimeType });
      promptNotes.push(`[微信文件] ${name}\n路径: ${filePath}`);
      displayTokens.push(`[文件] ${name}`);
    } else if (item?.type === MESSAGE_ITEM_TYPE.VIDEO) {
      const videoItem = item.video_item;
      if (!videoItem?.media?.encrypt_query_param || !videoItem.media.aes_key) continue;
      const buf = await downloadAndDecryptBuffer(videoItem.media.encrypt_query_param, videoItem.media.aes_key, cdnBaseUrl, "weixin.video");
      const filePath = await saveBuffer(buf, inboundDir, "video", ".mp4");
      attachments.push({ kind: "video", path: filePath, name: path.basename(filePath), mimeType: "video/mp4" });
      promptNotes.push(`[微信视频]\n路径: ${filePath}`);
      displayTokens.push("[视频]");
    }
  }

  return { images, promptNotes, displayTokens, attachments };
}

export async function sendWeixinMediaFiles({
  files,
  toUserId,
  baseUrl,
  token,
  contextToken,
  fromUserId = "",
  caption = "",
  cdnBaseUrl = DEFAULT_WEIXIN_CDN_BASE_URL,
}) {
  if (!contextToken) {
    throw new Error("weixin context_token missing for media send");
  }

  let first = true;
  for (const filePath of files) {
    const mime = getFileMime(filePath);
    const mediaType = mime.startsWith("image/")
      ? UPLOAD_MEDIA_TYPE.IMAGE
      : mime.startsWith("video/")
        ? UPLOAD_MEDIA_TYPE.VIDEO
        : UPLOAD_MEDIA_TYPE.FILE;
    const aesKey = crypto.randomBytes(16);
    const aesKeyHex = aesKey.toString("hex");
    const upload = await getUploadUrl({
      baseUrl,
      token,
      toUserId,
      mediaType,
      filePath,
      aesKeyHex,
    });
    const cdn = await uploadBufferToCdn({
      buffer: upload.plaintext,
      uploadParam: upload.uploadParam,
      filekey: upload.filekey,
      cdnBaseUrl,
      aesKey,
      label: "weixin.media",
    });

    const items = [];
    if (first && caption) {
      items.push({ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: caption } });
    }
    if (mediaType === UPLOAD_MEDIA_TYPE.IMAGE) {
      items.push({
        type: MESSAGE_ITEM_TYPE.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: cdn.downloadParam,
            // 与官方插件保持一致：发送 base64(32-char hex string)，而不是 base64(raw 16 bytes)
            aes_key: Buffer.from(aesKeyHex, "utf-8").toString("base64"),
            encrypt_type: 1,
          },
          mid_size: cdn.ciphertextSize,
        },
      });
    } else if (mediaType === UPLOAD_MEDIA_TYPE.VIDEO) {
      items.push({
        type: MESSAGE_ITEM_TYPE.VIDEO,
        video_item: {
          media: {
            encrypt_query_param: cdn.downloadParam,
            aes_key: Buffer.from(aesKeyHex, "utf-8").toString("base64"),
            encrypt_type: 1,
          },
          video_size: cdn.ciphertextSize,
        },
      });
    } else {
      items.push({
        type: MESSAGE_ITEM_TYPE.FILE,
        file_item: {
          media: {
            encrypt_query_param: cdn.downloadParam,
            aes_key: Buffer.from(aesKeyHex, "utf-8").toString("base64"),
            encrypt_type: 1,
          },
          file_name: path.basename(filePath),
          len: String(upload.rawsize),
        },
      });
    }

    await sendMessageItems({
      baseUrl,
      token,
      toUserId,
      fromUserId,
      contextToken,
      items,
    });
    first = false;
  }
}
