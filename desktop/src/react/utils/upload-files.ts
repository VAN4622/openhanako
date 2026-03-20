import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import type { DeskFile } from '../types';

export interface LocalUploadItem {
  path: string;
  name?: string;
}

export interface UploadRejection {
  path: string;
  name: string;
  reason: 'directory' | 'read_failed';
}

interface RemoteUploadFile {
  name: string;
  data: string;
}

interface UploadApiItem {
  dest?: string;
  name?: string;
  isDirectory?: boolean;
  error?: string;
}

function basenameOfPath(filePath: string): string {
  return String(filePath || '').replace(/\\/g, '/').split('/').pop() || filePath;
}

async function buildRemoteFiles(items: LocalUploadItem[]): Promise<{
  files: RemoteUploadFile[];
  rejected: UploadRejection[];
}> {
  const files: RemoteUploadFile[] = [];
  const rejected: UploadRejection[] = [];

  for (const item of items) {
    const name = item.name || basenameOfPath(item.path);
    const info = await window.platform?.getPathInfo?.(item.path);
    if (!info?.exists) {
      rejected.push({ path: item.path, name, reason: 'read_failed' });
      continue;
    }
    if (info.isDirectory) {
      rejected.push({ path: item.path, name, reason: 'directory' });
      continue;
    }
    const data = await window.platform?.readFileBase64?.(item.path);
    if (!data) {
      rejected.push({ path: item.path, name, reason: 'read_failed' });
      continue;
    }
    files.push({ name, data });
  }

  return { files, rejected };
}

async function postJson(apiPath: string, body: Record<string, unknown>) {
  const res = await hanaFetch(apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function uploadChatFiles(items: LocalUploadItem[]): Promise<{
  uploads: UploadApiItem[];
  rejected: UploadRejection[];
}> {
  const { serverMode } = useStore.getState();
  if (serverMode !== 'remote') {
    const data = await postJson('/api/upload', { paths: items.map((item) => item.path) });
    return { uploads: (data.uploads || []) as UploadApiItem[], rejected: [] };
  }

  const { files, rejected } = await buildRemoteFiles(items);
  if (files.length === 0) {
    return { uploads: [], rejected };
  }
  const data = await postJson('/api/upload', { files });
  return { uploads: (data.uploads || []) as UploadApiItem[], rejected };
}

export async function uploadDeskFiles(
  items: LocalUploadItem[],
  opts: { dir?: string; subdir?: string },
): Promise<{ files?: DeskFile[]; results?: unknown[]; rejected: UploadRejection[] }> {
  const { serverMode } = useStore.getState();
  if (serverMode !== 'remote') {
    const data = await postJson('/api/desk/files', {
      action: 'upload',
      dir: opts.dir,
      subdir: opts.subdir || '',
      paths: items.map((item) => item.path),
    });
    return { ...data, rejected: [] };
  }

  const { files, rejected } = await buildRemoteFiles(items);
  if (files.length === 0) {
    return { rejected };
  }
  const data = await postJson('/api/desk/files', {
    action: 'upload',
    dir: opts.dir,
    subdir: opts.subdir || '',
    files,
  });
  return { ...data, rejected };
}

export function formatUploadRejection(rejection: UploadRejection): string {
  if (rejection.reason === 'directory') {
    return `远程模式暂不支持上传文件夹: ${rejection.name}`;
  }
  return `无法读取文件内容: ${rejection.name}`;
}
