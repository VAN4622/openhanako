/**
 * update-settings-tool.js — 设置修改工具
 *
 * 让 Agent 提议修改设置，通过阻塞式确认卡片等待用户批准。
 * 不自己实现 apply 逻辑，复用 engine/preferences 上已有的 setter。
 */

import { Type } from "@sinclair/typebox";

/**
 * 设置注册表
 * 每个 key 对应一个可修改的设置项：
 *   type: 'toggle' | 'list' | 'text'
 *   label: 显示名称
 *   options?: list 类型的可选值（静态）
 *   optionsFrom?: 动态选项来源
 *   get: (engine) => currentValue
 *   apply: (engine, value) => void
 *   frontend?: true 表示前端专属设置（theme 等）
 */
const SETTINGS_REGISTRY = {
  sandbox: {
    type: "toggle",
    label: "沙盒安全",
    description: "限制文件系统写入范围",
    get: (engine) => String(engine.preferences.getSandbox() !== false),
    apply: (engine) => engine.setSandbox,
  },
  locale: {
    type: "list",
    label: "语言",
    options: ["zh-CN", "en"],
    get: (engine) => engine.preferences.getLocale() || "zh-CN",
    apply: (engine) => engine.setLocale,
  },
  timezone: {
    type: "text",
    label: "时区",
    description: "IANA 时区（如 Asia/Shanghai）",
    get: (engine) => engine.preferences.getTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    apply: (engine) => engine.setTimezone,
  },
  thinking_level: {
    type: "list",
    label: "思考深度",
    options: ["auto", "off", "low", "medium", "high"],
    get: (engine) => engine.preferences.getThinkingLevel() || "auto",
    apply: (engine) => engine.setThinkingLevel,
  },
  "memory.enabled": {
    type: "toggle",
    label: "记忆系统",
    description: "开启/关闭当前 Agent 的记忆功能",
    scope: "agent",
    get: (engine) => String(engine.agent?.memoryMasterEnabled !== false),
    apply: (engine, v) => engine.agent?.updateConfig({ memory: { enabled: v === "true" } }),
  },
  "agent.name": {
    type: "text",
    label: "Agent 名称",
    scope: "agent",
    get: (engine) => engine.agent?.agentName || "Hanako",
    apply: (engine, v) => engine.agent?.updateConfig({ agent: { name: v } }),
  },
  "user.name": {
    type: "text",
    label: "用户名称",
    scope: "agent",
    get: (engine) => engine.agent?.userName || "用户",
    apply: (engine, v) => engine.agent?.updateConfig({ user: { name: v } }),
  },
  home_folder: {
    type: "text",
    label: "工作目录",
    description: "Agent 的文件系统工作目录",
    get: (engine) => engine.getHomeFolder() || "",
    apply: (engine) => engine.setHomeFolder,
  },
  theme: {
    type: "list",
    label: "主题",
    options: ["warm-paper", "midnight", "high-contrast", "grass-aroma", "contemplation", "absolutely", "delve", "deep-think", "auto"],
    frontend: true,
    get: () => "auto",
    apply: null, // 前端处理
  },
  "models.chat": {
    type: "list",
    label: "对话模型",
    scope: "agent",
    optionsFrom: "availableModels",
    get: (engine) => engine.agent?.config?.models?.chat || "",
    apply: (engine, v) => engine.agent?.updateConfig({ models: { chat: v } }),
  },
};

/**
 * 创建 update_settings 工具
 */
export function createUpdateSettingsTool(deps = {}) {
  const {
    getEngine,        // () => engine
    getConfirmStore,  // () => ConfirmStore
    getSessionPath,   // () => string|null
    emitEvent,        // (event) => void
  } = deps;

  const settingKeys = Object.keys(SETTINGS_REGISTRY);
  const description = `修改 Hanako 的设置。所有修改需要用户确认后才会生效。

可修改的设置：
${settingKeys.map(k => {
  const s = SETTINGS_REGISTRY[k];
  const opts = s.options ? `（${s.options.join(" / ")}）` : "";
  return `- ${k}: ${s.label}${opts}`;
}).join("\n")}

value 参数：toggle 类型传 "true" 或 "false"，list 类型传选项值，text 类型传字符串。`;

  return {
    name: "update_settings",
    userFacingName: "设置",
    description,
    parameters: {
      type: "object",
      properties: {
        key: Type.String({ description: `设置项 key（${settingKeys.join(" / ")}）` }),
        value: Type.String({ description: "提议的新值" }),
      },
      required: ["key", "value"],
    },
    isUserFacing: true,
    execute: async (_toolCallId, params) => {
      const { key, value } = params;
      const reg = SETTINGS_REGISTRY[key];
      if (!reg) {
        return { content: [{ type: "text", text: `未知的设置项: ${key}。可用设置: ${settingKeys.join(", ")}` }] };
      }

      const engine = getEngine?.();
      const confirmStore = getConfirmStore?.();
      const sessionPath = getSessionPath?.();

      if (!engine || !confirmStore) {
        return { content: [{ type: "text", text: "设置系统未就绪" }] };
      }

      // 读取当前值
      const currentValue = reg.get(engine);

      // 动态选项
      let options = reg.options;
      if (reg.optionsFrom === "availableModels") {
        options = (engine.availableModels || []).map(m => m.id);
      }

      // 创建阻塞确认
      const { confirmId, promise } = confirmStore.create(
        "settings",
        { key, label: reg.label, description: reg.description, type: reg.type, currentValue, proposedValue: value, options, frontend: reg.frontend },
        sessionPath,
      );

      // 广播确认事件（在 await 之前，因为 _emitEvent 是同步的）
      emitEvent?.({
        type: "settings_confirmation",
        confirmId,
        settingKey: key,
        cardType: reg.type,
        currentValue,
        proposedValue: value,
        options: options || null,
        label: reg.label,
        description: reg.description || null,
        frontend: !!reg.frontend,
      });

      // 阻塞等待用户确认
      const result = await promise;

      if (result.action === "confirmed") {
        const finalValue = result.value !== undefined ? String(result.value) : value;
        try {
          if (reg.frontend) {
            // 前端专属设置，广播 apply 事件
            emitEvent?.({ type: "apply_frontend_setting", key, value: finalValue });
          } else {
            const applier = typeof reg.apply === "function" ? reg.apply : reg.apply?.(engine);
            if (typeof applier === "function") {
              applier(finalValue);
            } else {
              reg.apply(engine, finalValue);
            }
          }
          return { content: [{ type: "text", text: `已将「${reg.label}」修改为 ${finalValue}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `设置修改失败: ${err.message}` }] };
        }
      } else if (result.action === "rejected") {
        return { content: [{ type: "text", text: `用户取消了「${reg.label}」的修改` }] };
      } else {
        return { content: [{ type: "text", text: `「${reg.label}」修改确认超时，设置未变更` }] };
      }
    },
  };
}
