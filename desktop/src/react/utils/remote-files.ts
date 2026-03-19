import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { showToast } from './toast';

async function materializeRemoteFile(filePath: string, fileName: string): Promise<string | null> {
  const data = await hanaFetch(`/api/fs/read-base64?path=${encodeURIComponent(filePath)}`).then((res) => res.text());
  if (!data) return null;
  return window.platform?.saveTempBase64File?.(fileName, data) ?? null;
}

export async function openWorkspaceFile(filePath: string, fileName: string): Promise<void> {
  const { serverMode } = useStore.getState();
  if (serverMode !== 'remote') {
    window.platform?.openFile?.(filePath);
    return;
  }

  const localPath = await materializeRemoteFile(filePath, fileName);
  if (!localPath) {
    showToast(`无法下载远程文件：${fileName}`, 'error', 6000);
    return;
  }
  window.platform?.openFile?.(localPath);
}

export async function revealWorkspaceFile(filePath: string, fileName: string): Promise<void> {
  const { serverMode } = useStore.getState();
  if (serverMode !== 'remote') {
    window.platform?.showInFinder?.(filePath);
    return;
  }

  const localPath = await materializeRemoteFile(filePath, fileName);
  if (!localPath) {
    showToast(`无法下载远程文件：${fileName}`, 'error', 6000);
    return;
  }
  window.platform?.showInFinder?.(localPath);
}

export function revealWorkspaceDirectory(dirPath: string, dirName: string): void {
  const { serverMode } = useStore.getState();
  if (serverMode !== 'remote') {
    window.platform?.showInFinder?.(dirPath);
    return;
  }
  showToast(`远程目录无法直接在本地打开：${dirName}`, 'error', 6000);
}

export function copyWorkspacePath(filePath: string): void {
  navigator.clipboard.writeText(filePath).catch(() => {
    showToast('复制路径失败', 'error', 4000);
  });
}
