export function joinServerUrl(baseUrl: string | null | undefined, path: string): string {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error('Hanako server base URL is not ready');
  }
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

export function buildHanaUrl(
  baseUrl: string | null | undefined,
  serverToken: string | null | undefined,
  path: string,
): string {
  const url = joinServerUrl(baseUrl, path);
  if (!serverToken) return url;
  const sep = path.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(serverToken)}`;
}

export function buildWebSocketUrl(
  baseUrl: string | null | undefined,
  serverToken: string | null | undefined,
  path = '/ws',
): string {
  const httpUrl = new URL(joinServerUrl(baseUrl, path));
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  if (serverToken) {
    httpUrl.searchParams.set('token', serverToken);
  }
  return httpUrl.toString();
}
