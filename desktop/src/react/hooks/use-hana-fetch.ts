import { useStore } from '../stores';
import { buildHanaUrl, joinServerUrl } from '../utils/server-url';

const DEFAULT_TIMEOUT = 30_000;

/**
 * 构建带认证的 Hana Server URL
 */
export function hanaUrl(path: string): string {
  const { serverBaseUrl, serverToken } = useStore.getState();
  return buildHanaUrl(serverBaseUrl, serverToken, path);
}

/**
 * 带认证的 fetch 封装
 * - 默认 30s 超时
 * - 自动校验 res.ok，非 2xx 抛错
 */
export async function hanaFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { serverBaseUrl, serverToken } = useStore.getState();
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
      throw new Error(`hanaFetch ${path}: ${res.status} ${res.statusText}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
