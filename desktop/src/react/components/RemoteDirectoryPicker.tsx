import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../hooks/use-i18n';

export interface RemoteDirectoryRoot {
  id: string;
  path: string;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
}

export interface RemoteDirectoryListing {
  roots: RemoteDirectoryRoot[];
  currentPath: string;
  parentPath: string | null;
  directories: RemoteDirectoryEntry[];
}

interface RemoteDirectoryPickerProps {
  open: boolean;
  initialPath?: string | null;
  title?: string;
  description?: string;
  confirmLabel?: string;
  loadDirectories: (path?: string | null) => Promise<RemoteDirectoryListing>;
  onClose: () => void;
  onPick: (path: string) => void;
}

function rootLabel(id: string, zh: boolean): string {
  if (id === 'workspace') return zh ? '默认工作区' : 'Workspace';
  if (id === 'current') return zh ? '当前目录' : 'Current';
  if (id === 'home') return zh ? '主目录' : 'Home';
  return id;
}

export function RemoteDirectoryPicker({
  open,
  initialPath,
  title,
  description,
  confirmLabel,
  loadDirectories,
  onClose,
  onPick,
}: RemoteDirectoryPickerProps) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadWithFallback = async (targetPath?: string | null) => {
    try {
      return await loadDirectories(targetPath);
    } catch (err) {
      if (!targetPath) throw err;
      return loadDirectories();
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError('');
      try {
        const data = await loadWithFallback(initialPath);
        if (!cancelled) setListing(data);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || (zh ? '目录加载失败' : 'Failed to load directories'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [open, initialPath, loadDirectories, zh]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const refresh = async (targetPath?: string | null) => {
    setLoading(true);
    setError('');
    try {
      const data = await loadWithFallback(targetPath);
      setListing(data);
    } catch (err: any) {
      setError(err?.message || (zh ? '目录加载失败' : 'Failed to load directories'));
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="hana-warning-overlay" onClick={onClose}>
      <div className="hana-warning-box remote-dir-picker" onClick={(e) => e.stopPropagation()}>
        <h3 className="hana-warning-title">
          {title || (zh ? '选择服务器目录' : 'Choose Server Directory')}
        </h3>
        <div className="hana-warning-body">
          <p>
            {description || (zh
              ? '这里浏览的是远程 Hanako 服务器上的目录，不是当前桌面客户端的本地文件夹。'
              : 'You are browsing folders on the remote Hanako server, not on the local desktop client.')}
          </p>
        </div>

        <div className="remote-dir-picker-roots">
          {(listing?.roots || []).map((root) => (
            <button
              key={root.path}
              className={`remote-dir-root-btn${listing?.currentPath?.startsWith(root.path) ? ' active' : ''}`}
              onClick={() => void refresh(root.path)}
            >
              {rootLabel(root.id, zh)}
            </button>
          ))}
        </div>

        <div className="remote-dir-picker-toolbar">
          <button
            className="memory-confirm-cancel"
            onClick={() => void refresh(listing?.parentPath)}
            disabled={!listing?.parentPath || loading}
          >
            {zh ? '上一级' : 'Up'}
          </button>
          <code className="remote-dir-current-path">{listing?.currentPath || initialPath || '-'}</code>
        </div>

        <div className="remote-dir-picker-list">
          {loading && <div className="remote-dir-placeholder">{zh ? '加载中...' : 'Loading...'}</div>}
          {!loading && error && <div className="remote-dir-error">{error}</div>}
          {!loading && !error && listing && listing.directories.length === 0 && (
            <div className="remote-dir-placeholder">{zh ? '此目录下没有可选子目录。' : 'No subdirectories here.'}</div>
          )}
          {!loading && !error && listing?.directories.map((entry) => (
            <div key={entry.path} className="remote-dir-entry">
              <button className="remote-dir-entry-open" onClick={() => void refresh(entry.path)}>
                <span className="remote-dir-entry-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <span className="remote-dir-entry-name">{entry.name}</span>
              </button>
              <button className="memory-confirm-primary" onClick={() => onPick(entry.path)}>
                {zh ? '选中' : 'Select'}
              </button>
            </div>
          ))}
        </div>

        <div className="hana-warning-actions">
          <button className="hana-warning-cancel" onClick={onClose}>
            {zh ? '取消' : 'Cancel'}
          </button>
          <button
            className="hana-warning-confirm"
            onClick={() => listing?.currentPath && onPick(listing.currentPath)}
            disabled={!listing?.currentPath}
          >
            {confirmLabel || (zh ? '使用当前目录' : 'Use Current Directory')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
