export const BAILIAN_CODING_PLAN_PROVIDER = "bailian-coding-plan";
export const BAILIAN_CODING_PLAN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
export const BAILIAN_CODING_PLAN_API = "openai-completions";
export const PROVIDER_USAGE_SCOPE_INTERACTIVE_ONLY = "interactive-only";

// Officially documented Coding Plan model catalog.
export const BAILIAN_CODING_PLAN_MODELS = [
  "qwen3-coder-plus",
  "qwen3-coder-next",
  "qwen3-max-2026-01-23",
  "qwen3-plus",
  "qwen3-thinking-plus",
  "deepseek-v3.1",
  "kimi-k2.5",
  "glm-4.7",
  "glm-5",
  "MiniMax-M2.5",
];

export function getProviderUsageScope(providerName, baseUrl = "") {
  if (
    providerName === BAILIAN_CODING_PLAN_PROVIDER ||
    isBailianCodingPlanBaseUrl(baseUrl)
  ) {
    return PROVIDER_USAGE_SCOPE_INTERACTIVE_ONLY;
  }
  return "";
}

export function isInteractiveOnlyProvider(providerName, baseUrl = "") {
  return getProviderUsageScope(providerName, baseUrl) === PROVIDER_USAGE_SCOPE_INTERACTIVE_ONLY;
}

export function getInteractiveOnlyProviderReason(providerName, baseUrl = "") {
  if (
    providerName !== BAILIAN_CODING_PLAN_PROVIDER &&
    !isBailianCodingPlanBaseUrl(baseUrl)
  ) {
    return "";
  }
  return "is intended for interactive coding/chat turns only";
}

export function getStaticProviderModels(providerName) {
  if (providerName !== BAILIAN_CODING_PLAN_PROVIDER) return [];
  return BAILIAN_CODING_PLAN_MODELS.map((id) => ({
    id,
    name: id,
    context: null,
    maxOutput: null,
  }));
}

export function isBailianCodingPlanBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "") === BAILIAN_CODING_PLAN_BASE_URL;
}
