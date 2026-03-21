/**
 * Settings window API utilities
 * 从 settings store 读 port/token，独立于主窗口
 */
import { useSettingsStore } from './store';
import { buildHanaUrl, joinServerUrl } from '../utils/server-url';

const DEFAULT_TIMEOUT = 30_000;

export function hanaUrl(path: string): string {
  const { serverBaseUrl, serverToken } = useSettingsStore.getState();
  return buildHanaUrl(serverBaseUrl, serverToken, path);
}

export async function hanaFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { serverBaseUrl, serverToken } = useSettingsStore.getState();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (serverToken) {
    headers['Authorization'] = `Bearer ${serverToken}`;
  }

  const { timeout = DEFAULT_TIMEOUT, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(joinServerUrl(serverBaseUrl, path), {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const text = await res.text();
        if (text) {
          try {
            const parsed = JSON.parse(text);
            detail = parsed?.error || parsed?.message || text;
          } catch {
            detail = text;
          }
        }
      } catch {
        // Ignore secondary read failures and fall back to status text only.
      }
      const suffix = detail ? ` - ${detail}` : '';
      throw new Error(`hanaFetch ${path}: ${res.status} ${res.statusText}${suffix}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** 根据 yuan 类型返回 fallback 头像路径 */
export function yuanFallbackAvatar(yuan?: string): string {
  const t = (window as any).t || ((k: string) => k);
  const types = t('yuan.types') || {};
  const entry = types[yuan || 'hanako'];
  return `assets/${entry?.avatar || 'Hanako.png'}`;
}
