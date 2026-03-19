import crypto from "crypto";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import { debugLog } from "../../lib/debug-log.js";
import { wsParse, wsSend } from "../ws-protocol.js";

class RemoteBrowserTransport {
  constructor(ws, { deviceId }) {
    this.ws = ws;
    this.deviceId = deviceId;
    this.pending = new Map();
    this.closed = false;
  }

  sendCmd(cmd, params = {}, timeoutMs = 30000) {
    if (this.closed || this.ws.readyState !== 1) {
      throw new Error("Desktop browser bridge is offline");
    }

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Browser bridge timed out: ${cmd}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      wsSend(this.ws, { type: "browser-cmd", id, cmd, params });
    });
  }

  handleMessage(raw) {
    const msg = wsParse(raw);
    if (!msg || msg.type !== "browser-result" || !this.pending.has(msg.id)) return;

    const entry = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.error) {
      entry.reject(new Error(msg.error));
      return;
    }
    entry.resolve(msg.result);
  }

  dispose(reason = "Desktop browser bridge disconnected") {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

export default async function browserBridgeRoute(app) {
  let activeTransport = null;

  function activateTransport(transport) {
    if (activeTransport && activeTransport !== transport) {
      activeTransport.dispose("Replaced by a newer desktop browser bridge");
    }
    activeTransport = transport;
    BrowserManager.setTransport(transport);
    debugLog()?.log("browser-bridge", `connected: ${transport.deviceId}`);
  }

  function clearTransport(transport, reason) {
    if (activeTransport !== transport) {
      transport.dispose(reason);
      return;
    }
    transport.dispose(reason);
    activeTransport = null;
    BrowserManager.setTransport(null);
    debugLog()?.log("browser-bridge", `disconnected: ${transport.deviceId} (${reason})`);
  }

  app.get("/api/browser-bridge/status", async () => ({
    connected: !!activeTransport,
    deviceId: activeTransport?.deviceId || null,
  }));

  app.get("/ws/browser-bridge", { websocket: true }, (socket, req) => {
    const deviceId = typeof req.query?.deviceId === "string" && req.query.deviceId.trim()
      ? req.query.deviceId.trim()
      : "desktop";
    const transport = new RemoteBrowserTransport(socket, { deviceId });
    activateTransport(transport);
    wsSend(socket, { type: "browser-bridge-ready", deviceId });

    socket.on("message", (raw) => {
      transport.handleMessage(raw);
    });

    socket.on("error", (err) => {
      debugLog()?.error("browser-bridge", `${deviceId}: ${err.message}`);
    });

    socket.on("close", () => {
      clearTransport(transport, "socket closed");
    });
  });
}
