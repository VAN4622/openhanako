import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { t, autoSaveConfig } from '../helpers';
import { hanaFetch as settingsHanaFetch } from '../api';
import { Toggle } from '../widgets/Toggle';
import { SelectWidget } from '../widgets/SelectWidget';
import { RemoteDirectoryPicker, type RemoteDirectoryListing } from '../../components/RemoteDirectoryPicker';

const platform = (window as any).platform;

export function WorkTab() {
  const { settingsConfig, showToast, gatewayConfig, serverMode, serverBaseUrl } = useSettingsStore();
  const [homeFolder, setHomeFolder] = useState('');
  const [hbEnabled, setHbEnabled] = useState(true);
  const [hbInterval, setHbInterval] = useState(17);
  const [cronAutoApprove, setCronAutoApprove] = useState(true);
  const [gatewayMode, setGatewayMode] = useState<'local' | 'remote'>('local');
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState('');
  const [gatewayToken, setGatewayToken] = useState('');
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [showRemotePicker, setShowRemotePicker] = useState(false);

  const locale = settingsConfig?.locale || 'zh-CN';
  const zh = locale.startsWith('zh');
  const tx = (key: string, zhText: string, enText: string) => {
    const value = t(key);
    return value === key ? (zh ? zhText : enText) : value;
  };
  const remoteWorkspaceMode = serverMode === 'remote';

  useEffect(() => {
    if (settingsConfig) {
      setHomeFolder(settingsConfig.desk?.home_folder || '');
      setHbEnabled(settingsConfig.desk?.heartbeat_enabled !== false);
      setHbInterval(settingsConfig.desk?.heartbeat_interval ?? 17);
      setCronAutoApprove(settingsConfig.desk?.cron_auto_approve !== false);
    }
  }, [settingsConfig]);

  useEffect(() => {
    setGatewayMode(gatewayConfig.mode || 'local');
    setGatewayBaseUrl(gatewayConfig.baseUrl || '');
    setGatewayToken(gatewayConfig.token || '');
  }, [gatewayConfig]);

  const pickHomeFolder = async () => {
    if (remoteWorkspaceMode) {
      setShowRemotePicker(true);
      return;
    }
    const folder = await platform?.selectFolder?.();
    if (!folder) return;
    setHomeFolder(folder);
    useSettingsStore.setState({ homeFolder: folder });
    await autoSaveConfig({ desk: { home_folder: folder } });
  };

  const clearHomeFolder = async () => {
    setHomeFolder('');
    useSettingsStore.setState({ homeFolder: null });
    await autoSaveConfig({ desk: { home_folder: '' } });
  };

  const toggleHeartbeat = async (on: boolean) => {
    setHbEnabled(on);
    await autoSaveConfig({ desk: { heartbeat_enabled: on } });
  };

  const toggleCronAutoApprove = async (on: boolean) => {
    setCronAutoApprove(on);
    await autoSaveConfig({ desk: { cron_auto_approve: on } });
  };

  const saveWork = async () => {
    const interval = Math.max(1, Math.min(120, hbInterval));
    const deskPatch: Record<string, unknown> = { heartbeat_interval: interval };
    if (remoteWorkspaceMode) {
      deskPatch.home_folder = homeFolder.trim();
      useSettingsStore.setState({ homeFolder: homeFolder.trim() || null });
    }
    await autoSaveConfig({ desk: deskPatch });
  };

  const loadRemoteDirectories = async (targetPath?: string | null): Promise<RemoteDirectoryListing> => {
    const qs = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    const res = await settingsHanaFetch(`/api/fs/directories${qs}`);
    return res.json();
  };

  const saveGateway = async () => {
    setGatewaySaving(true);
    try {
      const nextConfig = {
        mode: gatewayMode,
        baseUrl: gatewayBaseUrl.trim(),
        token: gatewayToken.trim(),
      };
      if (gatewayMode === 'remote') {
        await platform?.verifyGatewayConfig?.(nextConfig);
      }
      const saved = await platform?.saveGatewayConfig?.(nextConfig);
      useSettingsStore.setState({ gatewayConfig: saved || nextConfig });
      showToast(
        tx(
          'settings.gateway.saved',
          '远程网关配置已保存，重启应用后生效',
          'Gateway settings saved. Restart the app to apply them.',
        ),
        'success',
      );
    } catch (err: any) {
      showToast(
        tx(
          'settings.gateway.saveFailed',
          '远程网关保存失败',
          'Failed to save gateway settings',
        ) + `: ${err.message}`,
        'error',
      );
    } finally {
      setGatewaySaving(false);
    }
  };

  return (
    <div className="settings-tab-content active" data-tab="work">
      {/* 主文件夹 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.work.homeFolder')}</h2>
        <p className="settings-desc settings-desc-compact">
          {t('settings.work.homeFolderDesc')}
        </p>
        <div className="settings-folder-picker">
          <input
            type="text"
            className="settings-input settings-folder-input"
            readOnly={!remoteWorkspaceMode}
            value={homeFolder}
            placeholder={remoteWorkspaceMode
              ? tx(
                'settings.work.remoteHomeFolderPlaceholder',
                '填写远程服务器上的目录，例如 /home/ubuntu/workspace',
                'Enter a server-side path, for example /home/ubuntu/workspace',
              )
              : t('settings.work.homeFolderPlaceholder')}
            onClick={remoteWorkspaceMode ? undefined : pickHomeFolder}
            onChange={remoteWorkspaceMode ? (e) => setHomeFolder(e.target.value) : undefined}
          />
          <button className="settings-folder-browse" onClick={pickHomeFolder}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {homeFolder && (
            <button
              className="settings-folder-clear"
              onClick={clearHomeFolder}
              title={t('settings.work.homeFolderClear')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        {remoteWorkspaceMode && (
          <p className="settings-desc settings-desc-compact">
            {tx(
              'settings.work.remoteHomeFolderHelp',
              '这里填写的是远程 Linux 服务器上的路径，不是当前 Windows 客户端上的目录。',
              'This path is resolved on the remote Linux server, not on the local desktop client.',
            )}
          </p>
        )}
      </section>

      {/* 巡检 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.work.title')}</h2>
        <div className="tool-caps-group">
          <div className="tool-caps-item">
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.heartbeatEnabled')}</span>
              <span className="tool-caps-desc">{t('settings.work.heartbeatDesc')}</span>
            </div>
            <Toggle
              on={hbEnabled}
              onChange={toggleHeartbeat}
            />
          </div>
          <div className={`tool-caps-item${hbEnabled ? '' : ' settings-disabled'}`}>
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.heartbeatInterval')}</span>
            </div>
            <div className="settings-input-group">
              <input
                type="number"
                className="settings-input small"
                min={1}
                max={120}
                value={hbInterval}
                disabled={!hbEnabled}
                onChange={(e) => setHbInterval(parseInt(e.target.value) || 15)}
              />
              <span className="settings-input-unit">{t('settings.work.heartbeatUnit')}</span>
            </div>
          </div>
          <div className="tool-caps-item">
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.cronAutoApprove')}</span>
              <span className="tool-caps-desc">{t('settings.work.cronAutoApproveDesc')}</span>
            </div>
            <Toggle
              on={cronAutoApprove}
              onChange={toggleCronAutoApprove}
            />
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">
          {tx('settings.gateway.title', '远程网关', 'Remote Gateway')}
        </h2>
        <p className="settings-desc settings-desc-compact">
          {tx(
            'settings.gateway.desc',
            '让当前桌面客户端连接到远程 Hanako 后端。切换后需要重启应用。',
            'Connect this desktop client to a remote Hanako backend. Restart is required after changes.',
          )}
        </p>

        <div className="settings-field">
          <label className="settings-field-label">
            {tx('settings.gateway.current', '当前连接', 'Current Connection')}
          </label>
          <div className="settings-field-hint">
            {serverMode === 'remote'
              ? `${tx('settings.gateway.mode.remote', '远程网关', 'Remote gateway')} · ${serverBaseUrl || '-'}`
              : `${tx('settings.gateway.mode.local', '本地内置服务', 'Local embedded server')} · ${serverBaseUrl || '-'}`}
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-field-label">
            {tx('settings.gateway.mode', '连接模式', 'Connection Mode')}
          </label>
          <SelectWidget
            options={[
              { value: 'local', label: tx('settings.gateway.mode.local', '本地内置服务', 'Local embedded server') },
              { value: 'remote', label: tx('settings.gateway.mode.remote', '远程网关', 'Remote gateway') },
            ]}
            value={gatewayMode}
            onChange={(value) => setGatewayMode(value as 'local' | 'remote')}
          />
        </div>

        <div className={`settings-field${gatewayMode === 'remote' ? '' : ' settings-disabled'}`}>
          <label className="settings-field-label">
            {tx('settings.gateway.baseUrl', '网关地址', 'Gateway URL')}
          </label>
          <input
            type="url"
            className="settings-input"
            value={gatewayBaseUrl}
            disabled={gatewayMode !== 'remote'}
            placeholder="https://your-gateway.example.com"
            onChange={(e) => setGatewayBaseUrl(e.target.value)}
          />
          <span className="settings-field-hint">
            {tx(
              'settings.gateway.baseUrlHint',
              '填写远程 Hanako 服务的根地址，例如 https://host 或 https://host/hanako',
              'Use the remote Hanako base URL, for example https://host or https://host/hanako',
            )}
          </span>
        </div>

        <div className={`settings-field${gatewayMode === 'remote' ? '' : ' settings-disabled'}`}>
          <label className="settings-field-label">
            {tx('settings.gateway.token', '访问令牌', 'Access Token')}
          </label>
          <input
            type="password"
            className="settings-input"
            value={gatewayToken}
            disabled={gatewayMode !== 'remote'}
            placeholder={tx('settings.gateway.tokenPlaceholder', '可选，如果网关要求 Bearer Token', 'Optional if the gateway requires a Bearer token')}
            onChange={(e) => setGatewayToken(e.target.value)}
          />
        </div>

        <div className="settings-section-footer">
          <button className="settings-save-btn-sm" onClick={saveGateway} disabled={gatewaySaving}>
            {gatewaySaving
              ? tx('settings.gateway.saving', '保存中...', 'Saving...')
              : tx('settings.gateway.save', '保存网关配置', 'Save Gateway Settings')}
          </button>
        </div>
      </section>

      <div className="settings-section-footer">
        <button className="settings-save-btn-sm" onClick={saveWork}>
          {t('settings.save')}
        </button>
      </div>

      <RemoteDirectoryPicker
        open={showRemotePicker}
        initialPath={homeFolder}
        title={tx('settings.work.remotePickerTitle', '选择远程工作目录', 'Choose Remote Workspace')}
        description={tx(
          'settings.work.remotePickerDesc',
          '浏览远程 Hanako 服务器上的目录，并把它设为默认工作目录。',
          'Browse directories on the remote Hanako server and set one as the default workspace.',
        )}
        confirmLabel={tx('settings.work.remotePickerConfirm', '使用当前目录', 'Use Current Directory')}
        loadDirectories={loadRemoteDirectories}
        onClose={() => setShowRemotePicker(false)}
        onPick={(path) => {
          setHomeFolder(path);
          useSettingsStore.setState({ homeFolder: path });
          setShowRemotePicker(false);
        }}
      />
    </div>
  );
}
