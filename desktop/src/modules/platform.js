/**
 * platform.js - platform abstraction layer
 *
 * Electron mode uses preload IPC, but remote gateway mode needs a few file
 * reads to go back through HTTP so the renderer reads the Linux backend
 * workspace instead of the Windows client filesystem.
 */
(function () {
  if (window.hana) {
    const api = window.hana;

    async function resolveDesktopServer() {
      const [baseUrl, token, mode] = await Promise.all([
        api.getServerBaseUrl?.(),
        api.getServerToken?.(),
        api.getServerMode?.(),
      ]);
      return { baseUrl, token, mode };
    }

    async function remoteFetch(apiPath) {
      const { baseUrl, token, mode } = await resolveDesktopServer();
      if (mode !== "remote" || !baseUrl) return null;
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}${apiPath}`, { headers });
      if (!res.ok) return null;
      return res.text();
    }

    window.platform = {
      ...api,
      readFile: async (p) => {
        const remote = await remoteFetch(`/api/fs/read?path=${encodeURIComponent(p)}`);
        return remote !== null ? remote : api.readFile(p);
      },
      readFileBase64: async (p) => {
        const remote = await remoteFetch(`/api/fs/read-base64?path=${encodeURIComponent(p)}`);
        return remote !== null ? remote : api.readFileBase64(p);
      },
      readDocxHtml: async (p) => {
        const remote = await remoteFetch(`/api/fs/docx-html?path=${encodeURIComponent(p)}`);
        return remote !== null ? remote : api.readDocxHtml(p);
      },
      readXlsxHtml: async (p) => {
        const remote = await remoteFetch(`/api/fs/xlsx-html?path=${encodeURIComponent(p)}`);
        return remote !== null ? remote : api.readXlsxHtml(p);
      },
    };
    return;
  }

  const params = new URLSearchParams(location.search);
  const token = params.get("token") || localStorage.getItem("hana-token") || "";
  const baseUrl = `${location.protocol}//${location.host}`;

  function apiFetch(path, opts = {}) {
    const headers = { ...opts.headers };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${baseUrl}${path}`, { ...opts, headers });
  }

  window.platform = {
    getServerPort: async () => location.port || "3000",
    getServerBaseUrl: async () => baseUrl,
    getServerToken: async () => token,
    getServerMode: async () => "web",
    getGatewayConfig: async () => ({ mode: "local", baseUrl: "", token: "" }),
    saveGatewayConfig: async () => ({ mode: "local", baseUrl: "", token: "" }),
    verifyGatewayConfig: async () => ({ ok: false, mode: "web" }),
    appReady: async () => {},

    readFile: (p) => apiFetch(`/api/fs/read?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    readFileBase64: (p) => apiFetch(`/api/fs/read-base64?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    getPathInfo: async () => null,
    readDocxHtml: (p) => apiFetch(`/api/fs/docx-html?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    readXlsxHtml: (p) => apiFetch(`/api/fs/xlsx-html?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),

    writeFile: async () => false,
    watchFile: async () => false,
    unwatchFile: async () => false,
    onFileChanged: () => {},
    openEditorWindow: () => {},
    onEditorDockFile: () => {},
    onEditorDetached: () => {},

    getFilePath: () => null,
    getAvatarPath: () => null,
    getSplashInfo: async () => ({}),

    selectFolder: async () => null,
    selectSkill: async () => null,

    openFolder: () => {},
    openFile: () => {},
    openExternal: (url) => { try { window.open(url, "_blank"); } catch {} },
    showInFinder: () => {},
    startDrag: () => {},

    openSettings: () => {},
    reloadMainWindow: () => location.reload(),

    settingsChanged: () => {},
    onSettingsChanged: () => {},

    openBrowserViewer: () => {},
    closeBrowserViewer: () => {},
    onBrowserUpdate: () => {},
    browserGoBack: () => {},
    browserGoForward: () => {},
    browserReload: () => {},
    browserEmergencyStop: () => {},

    openSkillViewer: () => {},
    listSkillFiles: async () => [],
    readSkillFile: async () => null,
    onSkillViewerLoad: () => {},
    closeSkillViewer: () => {},

    onboardingComplete: async () => {},
    debugOpenOnboarding: async () => {},
    debugOpenOnboardingPreview: async () => {},

    getPlatform: async () => "web",
    windowMinimize: () => {},
    windowMaximize: () => {},
    windowClose: () => {},
    windowIsMaximized: async () => false,
    onMaximizeChange: () => {},
  };
})();

(async function initPlatform() {
  const p = window.platform;
  if (!p?.getPlatform) return;
  const plat = await p.getPlatform();
  document.documentElement.setAttribute("data-platform", plat);

  if (plat !== "darwin" && plat !== "web") {
    const titlebar = document.querySelector(".titlebar");
    if (!titlebar) return;

    const controls = document.createElement("div");
    controls.className = "window-controls";
    controls.innerHTML = `
      <button class="wc-btn wc-minimize" title="最小化">
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1"/></svg>
      </button>
      <button class="wc-btn wc-maximize" title="最大化">
        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/></svg>
      </button>
      <button class="wc-btn wc-close" title="关闭">
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1"/></svg>
      </button>
    `;
    titlebar.appendChild(controls);

    controls.querySelector(".wc-minimize").addEventListener("click", () => p.windowMinimize());
    controls.querySelector(".wc-maximize").addEventListener("click", () => p.windowMaximize());
    controls.querySelector(".wc-close").addEventListener("click", () => p.windowClose());

    if (p.onMaximizeChange) {
      p.onMaximizeChange((maximized) => {
        const svg = controls.querySelector(".wc-maximize svg");
        if (maximized) {
          svg.innerHTML = '<rect x="3" y="1" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><rect x="1" y="3" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/>';
        } else {
          svg.innerHTML = '<rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/>';
        }
      });
    }
  }
})();
