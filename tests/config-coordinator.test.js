import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { ConfigCoordinator } from "../core/config-coordinator.js";
import { clearConfigCache } from "../lib/memory/config-loader.js";

describe("ConfigCoordinator interactive-only provider guards", () => {
  const tmpDir = path.join(os.tmpdir(), `hana-config-coord-${Date.now()}`);
  const hanakoHome = path.join(tmpDir, ".hanako");

  beforeEach(() => {
    fs.mkdirSync(hanakoHome, { recursive: true });
    process.env.HANA_HOME = hanakoHome;
    fs.writeFileSync(
      path.join(hanakoHome, "models.json"),
      JSON.stringify({
        providers: {
          "bailian-coding-plan": {
            models: [{ id: "qwen3-coder-plus" }],
          },
          siliconflow: {
            models: [{ id: "deepseek-chat" }],
          },
        },
      }, null, 2),
      "utf-8",
    );
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    delete process.env.HANA_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createCoordinator() {
    const prefs = {};
    return new ConfigCoordinator({
      hanakoHome,
      agentsDir: tmpDir,
      getAgent: () => ({ config: {}, _utilityModel: null }),
      getAgents: () => new Map(),
      getModels: () => ({
        availableModels: [
          { id: "qwen3-coder-plus", provider: "bailian-coding-plan" },
          { id: "deepseek-chat", provider: "siliconflow" },
        ],
        resolveUtilityConfig: () => ({ utility: "deepseek-chat" }),
      }),
      getPrefs: () => ({
        getPreferences: () => prefs,
        savePreferences: (next) => {
          Object.keys(prefs).forEach((key) => delete prefs[key]);
          Object.assign(prefs, next);
        },
      }),
      getSkills: () => null,
      getSession: () => null,
      getHub: () => null,
      emitEvent: () => {},
      emitDevLog: () => {},
      getCurrentModel: () => "deepseek-chat",
    });
  }

  it("rejects Coding Plan models as shared utility models", () => {
    const coordinator = createCoordinator();
    expect(() => coordinator.setSharedModels({ utility: "qwen3-coder-plus" })).toThrow(
      /interactive coding\/chat turns only/i,
    );
  });

  it("rejects Coding Plan as utility_api provider", () => {
    const coordinator = createCoordinator();
    expect(() => coordinator.setUtilityApi({ provider: "bailian-coding-plan" })).toThrow(
      /interactive coding\/chat turns only/i,
    );
  });
});
