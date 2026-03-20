import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { formatSessionDate, parseMoodFromContent } from '../utils/format';
import { renderMarkdown } from '../utils/markdown';

interface BridgeSession {
  sessionKey: string;
  chatId: string;
  displayName?: string;
  avatarUrl?: string;
  lastActive?: number;
  isOwner?: boolean;
}

interface BridgeMessage {
  role: string;
  content: string;
}

interface StatusData {
  telegram?: { status: string; configured?: boolean };
  feishu?: { status: string; configured?: boolean };
  [key: string]: { status: string; configured?: boolean } | undefined;
}

interface ConversationBinding {
  conversationId: string;
  lastSeenSeq: number;
  conversationLastSeq: number;
  updatedAt: string | null;
}

interface TimelineEvent {
  seq: number;
  sourceType: string;
  sourceKey: string;
  messageRole: string;
  text?: string;
  recordedAt?: string;
}

interface SnapshotItem {
  seq: number;
  source: string;
  text: string;
  toolName?: string;
  recordedAt?: string;
}

interface ConversationSnapshot {
  conversationId: string;
  updatedAt: string;
  lastSeq: number;
  currentObjective?: SnapshotItem | null;
  openLoops?: SnapshotItem[];
  confirmedConstraints?: SnapshotItem[];
  recentDecisions?: SnapshotItem[];
  lastUserMessage?: SnapshotItem | null;
  lastAssistantMessage?: SnapshotItem | null;
  recentToolResults?: SnapshotItem[];
}

export function BridgePanel() {
  const activePanel = useStore(s => s.activePanel);
  const panelClosing = useStore(s => s.panelClosing);
  const setActivePanel = useStore(s => s.setActivePanel);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const localSessions = useStore(s => s.sessions);

  const [platform, setPlatform] = useState(() => localStorage.getItem('hana_bridge_tab') || 'feishu');
  const [sessions, setSessions] = useState<BridgeSession[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState('');
  const [messages, setMessages] = useState<BridgeMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [statusData, setStatusData] = useState<StatusData>({});
  const [localBinding, setLocalBinding] = useState<ConversationBinding | null>(null);
  const [bridgeBinding, setBridgeBinding] = useState<ConversationBinding | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [isConversationLoading, setIsConversationLoading] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [isResettingConversation, setIsResettingConversation] = useState(false);
  const [linkError, setLinkError] = useState('');

  const messagesRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;

  const currentBridgeSession = sessions.find(s => s.sessionKey === currentKey) || null;
  const currentLocalSession = localSessions.find(s => s.path === currentSessionPath) || null;

  // 加载状态
  const loadStatus = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/bridge/status');
      const data = await res.json();
      setStatusData(data);
      updateSidebarDot(data);
    } catch {}
  }, []);

  // 加载平台数据
  const loadPlatformData = useCallback(async (plat: string) => {
    try {
      const [statusRes, sessionsRes] = await Promise.all([
        hanaFetch('/api/bridge/status'),
        hanaFetch(`/api/bridge/sessions?platform=${plat}`),
      ]);
      const sData = await statusRes.json();
      const sessData = await sessionsRes.json();
      setStatusData(sData);
      updateSidebarDot(sData);
      setShowOverlay(!sData[plat]?.configured);
      setSessions(sessData.sessions || []);
    } catch (err) {
      console.error('[bridge] load platform data failed:', err);
    }
  }, []);

  const loadConversationState = useCallback(async (sessionKey: string | null) => {
    if (!sessionKey) {
      setBridgeBinding(null);
      setTimelineEvents([]);
      setSnapshot(null);
      setLinkError('');
      return;
    }

    setIsConversationLoading(true);
    setLinkError('');

    try {
      const requests: Promise<Response>[] = [
        hanaFetch(`/api/conversations/bridge?sessionKey=${encodeURIComponent(sessionKey)}&guest=false`),
      ];

      if (currentSessionPath) {
        requests.push(
          hanaFetch(`/api/conversations/local?sessionPath=${encodeURIComponent(currentSessionPath)}`),
        );
      }

      const responses = await Promise.all(requests);
      const bridgeData = await responses[0].json();
      const localData = responses[1] ? await responses[1].json() : { binding: null };
      const nextBridgeBinding = bridgeData.binding || null;
      const nextLocalBinding = localData.binding || null;

      setBridgeBinding(nextBridgeBinding);
      setLocalBinding(nextLocalBinding);

      if (nextBridgeBinding?.conversationId) {
        const [timelineRes, snapshotRes] = await Promise.all([
          hanaFetch(
            `/api/conversations/${encodeURIComponent(nextBridgeBinding.conversationId)}/timeline?limit=8`,
          ),
          hanaFetch(
            `/api/conversations/${encodeURIComponent(nextBridgeBinding.conversationId)}/snapshot`,
          ),
        ]);
        const timelineData = await timelineRes.json();
        const snapshotData = await snapshotRes.json();
        setTimelineEvents(Array.isArray(timelineData.events) ? timelineData.events : []);
        setSnapshot(snapshotData.snapshot || null);
      } else {
        setTimelineEvents([]);
        setSnapshot(null);
      }
    } catch (err) {
      console.error('[bridge] load conversation state failed:', err);
      setTimelineEvents([]);
      setSnapshot(null);
    } finally {
      setIsConversationLoading(false);
    }
  }, [currentSessionPath]);

  // 面板打开时加载数据
  useEffect(() => {
    if (activePanel === 'bridge') {
      loadPlatformData(platform);
      setChatOpen(false);
      setCurrentKey(null);
    }
  }, [activePanel, platform, loadPlatformData]);

  useEffect(() => {
    if (activePanel !== 'bridge' || !currentKey) return;
    loadConversationState(currentKey);
  }, [activePanel, currentKey, currentSessionPath, loadConversationState]);

  // 注册 WS 回调
  useEffect(() => {
    window.__hanaBridgeLoadStatus = loadStatus;
    window.__hanaBridgeOnMessage = (msg) => {
      if (activePanel !== 'bridge') return;
      // 防抖刷新联系人列表
      if (!refreshTimerRef.current) {
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          loadPlatformData(platform);
        }, 500);
      }
      // 追加到当前会话（用 ref 避免闭包捕获陈旧值）
      if (msg.sessionKey === currentKeyRef.current) {
        const role = msg.direction === 'out' ? 'assistant' : 'user';
        setMessages(prev => [...prev, { role, content: msg.text }]);
        // 自动滚到底
        setTimeout(() => {
          const el = messagesRef.current;
          if (el) {
            const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (wasAtBottom) el.scrollTop = el.scrollHeight;
          }
        }, 0);
      }
    };
    return () => {
      delete window.__hanaBridgeLoadStatus;
      delete window.__hanaBridgeOnMessage;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [activePanel, platform, loadStatus, loadPlatformData]);

  const switchTab = useCallback((plat: string) => {
    setPlatform(plat);
    setCurrentKey(null);
    setChatOpen(false);
    localStorage.setItem('hana_bridge_tab', plat);
    loadPlatformData(plat);
  }, [loadPlatformData]);

  const openSession = useCallback(async (sessionKey: string, displayName: string) => {
    setCurrentKey(sessionKey);
    setCurrentName(displayName);
    try {
      const res = await hanaFetch(`/api/bridge/sessions/${encodeURIComponent(sessionKey)}/messages`);
      const data = await res.json();
      setMessages(data.messages || []);
      setChatOpen(true);
      setTimeout(() => {
        if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      }, 0);
    } catch (err) {
      console.error('[bridge] open session failed:', err);
      setChatOpen(false);
    }
  }, []);

  const resetSession = useCallback(async () => {
    if (!currentKey) return;
    try {
      await hanaFetch(`/api/bridge/sessions/${encodeURIComponent(currentKey)}/reset`, { method: 'POST' });
      openSession(currentKey, currentName);
    } catch (err) {
      console.error('[bridge] reset session failed:', err);
    }
  }, [currentKey, currentName, openSession]);

  const linkToCurrentSession = useCallback(async () => {
    if (!currentKey || !currentSessionPath) return;
    setIsLinking(true);
    setLinkError('');
    try {
      const res = await hanaFetch('/api/conversations/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionPath: currentSessionPath,
          sessionKey: currentKey,
          guest: false,
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || '关联失败');
      }
      await loadConversationState(currentKey);
    } catch (err) {
      console.error('[bridge] link conversation failed:', err);
      setLinkError(err instanceof Error ? err.message : '关联失败');
    } finally {
      setIsLinking(false);
    }
  }, [currentKey, currentSessionPath, loadConversationState]);

  const resetSharedConversation = useCallback(async () => {
    if (!currentKey) return;
    setIsResettingConversation(true);
    setLinkError('');
    try {
      const res = await hanaFetch('/api/conversations/bridge/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionKey: currentKey,
          guest: false,
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'reset shared conversation failed');
      }
      await loadConversationState(currentKey);
    } catch (err) {
      console.error('[bridge] reset shared conversation failed:', err);
      setLinkError(err instanceof Error ? err.message : 'reset shared conversation failed');
    } finally {
      setIsResettingConversation(false);
    }
  }, [currentKey, loadConversationState]);

  const close = useCallback(() => setActivePanel(null), [setActivePanel]);

  if (activePanel !== 'bridge') return null;

  const t = window.t ?? ((p: string) => p);
  const sharedConversation =
    !!localBinding?.conversationId &&
    !!bridgeBinding?.conversationId &&
    localBinding.conversationId === bridgeBinding.conversationId;
  const canLinkToCurrentSession = !!currentBridgeSession?.isOwner && !!currentSessionPath && !sharedConversation;
  const canResetSharedConversation = !!currentBridgeSession?.isOwner && !!currentKey;
  const currentLocalLabel = currentLocalSession?.title || currentLocalSession?.firstMessage || '当前对话';
  const tgStatus = statusData.telegram?.status;
  const fsStatus = statusData.feishu?.status;
  const waStatus = statusData.whatsapp?.status;
  const qqStatus = statusData.qq?.status;

  return (
    <div className={`floating-panel bridge-panel-wide${panelClosing ? ' closing' : ''}`} id="bridgePanel">
      <div className="floating-panel-inner">
        <div className="floating-panel-header">
          <div className="bridge-tabs" id="bridgeTabs">
            <button
              className={'bridge-tab' + (platform === 'feishu' ? ' active' : '')}
              onClick={() => switchTab('feishu')}
            >
              <span className={'bridge-tab-dot' + dotClass(fsStatus)} />
              <span>{t('settings.bridge.feishu') || '飞书'}</span>
            </button>
            <button
              className={'bridge-tab' + (platform === 'telegram' ? ' active' : '')}
              onClick={() => switchTab('telegram')}
            >
              <span className={'bridge-tab-dot' + dotClass(tgStatus)} />
              Telegram
            </button>
            <button
              className={'bridge-tab' + (platform === 'whatsapp' ? ' active' : '')}
              onClick={() => switchTab('whatsapp')}
            >
              <span className={'bridge-tab-dot' + dotClass(waStatus)} />
              WhatsApp
            </button>
            <button
              className={'bridge-tab' + (platform === 'qq' ? ' active' : '')}
              onClick={() => switchTab('qq')}
            >
              <span className={'bridge-tab-dot' + dotClass(qqStatus)} />
              QQ
            </button>
          </div>
          <button className="floating-panel-close" onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="bridge-body">
          {showOverlay && (
            <div className="bridge-overlay" id="bridgeOverlay">
              <div className="bridge-overlay-content">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div className="bridge-overlay-text">
                  {t('bridge.notConfigured', { platform: platform === 'telegram' ? 'Telegram' : platform === 'whatsapp' ? 'WhatsApp' : platform === 'qq' ? 'QQ' : (t('settings.bridge.feishu') || '飞书') })}
                </div>
                <button className="bridge-overlay-btn" onClick={() => window.platform.openSettings('bridge')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>{t('bridge.goToSettings') || '前往设置'}</span>
                </button>
              </div>
            </div>
          )}
          <div className="bridge-sidebar" id="bridgeSidebar">
            <div className="bridge-contact-list" id="bridgeContactList">
              {sessions.length === 0 ? (
                <div className="bridge-contact-empty">{t('bridge.noSessions') || '暂无会话'}</div>
              ) : (
                sessions.map(s => {
                  const name = s.displayName || s.chatId;
                  return (
                    <div
                      key={s.sessionKey}
                      className={'bridge-contact-item' + (s.sessionKey === currentKey ? ' active' : '')}
                      onClick={() => openSession(s.sessionKey, name)}
                    >
                      <ContactAvatar name={name} avatarUrl={s.avatarUrl} />
                      <div className="bridge-contact-info">
                        <div className="bridge-contact-name">{name}</div>
                        {s.lastActive && (
                          <div className="bridge-contact-time">
                            {formatSessionDate(new Date(s.lastActive).toISOString())}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className="bridge-chat" id="bridgeChat">
            {chatOpen ? (
              <>
                <div className="bridge-chat-header" id="bridgeChatHeader">
                  <span className="bridge-chat-header-name">{currentName}</span>
                  <div className="bridge-chat-header-actions">
                    <button className="bridge-chat-reset" title={t('bridge.resetContext')} onClick={resetSession}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="bridge-context-card">
                  <div className="bridge-context-card-header">
                    <div>
                      <div className="bridge-context-card-title">共享会话</div>
                      <div className="bridge-context-card-subtitle">
                        {currentBridgeSession?.isOwner
                          ? '所有者会话会继续当前本地对话的共享上下文。'
                          : '访客会话不会接入这条共享时间线。'}
                      </div>
                    </div>
                    {sharedConversation ? (
                      <span className="bridge-context-badge is-linked">已关联</span>
                    ) : (
                      <span className="bridge-context-badge">未关联</span>
                    )}
                  </div>

                  <div className="bridge-context-grid">
                    <div className="bridge-context-item">
                      <span className="bridge-context-label">当前对话</span>
                      <span className="bridge-context-value" title={currentLocalLabel}>{currentLocalLabel}</span>
                      <span className="bridge-context-meta">
                        {localBinding?.conversationId ? shortConversationId(localBinding.conversationId) : '未绑定'}
                      </span>
                    </div>
                    <div className="bridge-context-item">
                      <span className="bridge-context-label">Bridge 会话</span>
                      <span className="bridge-context-value" title={currentName}>{currentName}</span>
                      <span className="bridge-context-meta">
                        {bridgeBinding?.conversationId ? shortConversationId(bridgeBinding.conversationId) : '未绑定'}
                      </span>
                    </div>
                  </div>

                  {canLinkToCurrentSession && (
                    <div className="bridge-context-actions">
                      <button
                        className="bridge-link-btn"
                        onClick={linkToCurrentSession}
                        disabled={isLinking}
                      >
                        {isLinking ? '关联中...' : '关联到当前对话'}
                      </button>
                    </div>
                  )}

                  {canResetSharedConversation && (
                    <div className="bridge-context-actions">
                      <button
                        className="bridge-link-btn bridge-link-btn-secondary"
                        onClick={resetSharedConversation}
                        disabled={isLinking || isResettingConversation}
                      >
                        {isResettingConversation ? '重置中...' : '开始新的共享会话'}
                      </button>
                    </div>
                  )}

                  {linkError && (
                    <div className="bridge-context-error">{linkError}</div>
                  )}

                  <div className="bridge-timeline">
                    <div className="bridge-timeline-header">
                      <span className="bridge-context-label">共享上下文快照</span>
                      {isConversationLoading && <span className="bridge-context-meta">加载中...</span>}
                    </div>
                    {snapshot ? (
                      <div className="bridge-snapshot">
                        <div className="bridge-snapshot-row">
                          <span className="bridge-snapshot-key">当前目标</span>
                          <span className="bridge-snapshot-value">{snapshotText(snapshot.currentObjective)}</span>
                        </div>
                        <div className="bridge-snapshot-row">
                          <span className="bridge-snapshot-key">最新用户消息</span>
                          <span className="bridge-snapshot-value">{snapshotText(snapshot.lastUserMessage)}</span>
                        </div>
                        <div className="bridge-snapshot-row">
                          <span className="bridge-snapshot-key">最新助手消息</span>
                          <span className="bridge-snapshot-value">{snapshotText(snapshot.lastAssistantMessage)}</span>
                        </div>
                        {snapshot.openLoops && snapshot.openLoops.length > 0 && (
                          <div className="bridge-snapshot-tools">
                            <div className="bridge-snapshot-key">未闭合问题</div>
                            <div className="bridge-snapshot-tool-list">
                              {snapshot.openLoops.map(item => (
                                <div key={`loop-${item.seq}`} className="bridge-snapshot-tool">
                                  <span className="bridge-snapshot-tool-name">[{item.source}]</span>
                                  <span className="bridge-snapshot-tool-text">{item.text || '暂无'}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {snapshot.confirmedConstraints && snapshot.confirmedConstraints.length > 0 && (
                          <div className="bridge-snapshot-tools">
                            <div className="bridge-snapshot-key">已确认约束</div>
                            <div className="bridge-snapshot-tool-list">
                              {snapshot.confirmedConstraints.map(item => (
                                <div key={`constraint-${item.seq}`} className="bridge-snapshot-tool">
                                  <span className="bridge-snapshot-tool-name">[{item.source}]</span>
                                  <span className="bridge-snapshot-tool-text">{item.text || '暂无'}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {snapshot.recentDecisions && snapshot.recentDecisions.length > 0 && (
                          <div className="bridge-snapshot-tools">
                            <div className="bridge-snapshot-key">最近决策</div>
                            <div className="bridge-snapshot-tool-list">
                              {snapshot.recentDecisions.map(item => (
                                <div key={`decision-${item.seq}`} className="bridge-snapshot-tool">
                                  <span className="bridge-snapshot-tool-name">[{item.source}]</span>
                                  <span className="bridge-snapshot-tool-text">{item.text || '暂无'}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {snapshot.recentToolResults && snapshot.recentToolResults.length > 0 && (
                          <div className="bridge-snapshot-tools">
                            <div className="bridge-snapshot-key">最近工具结果</div>
                            <div className="bridge-snapshot-tool-list">
                              {snapshot.recentToolResults.map(item => (
                                <div key={`tool-${item.seq}`} className="bridge-snapshot-tool">
                                  <span className="bridge-snapshot-tool-name">
                                    [{item.source}] {item.toolName || 'tool'}
                                  </span>
                                  <span className="bridge-snapshot-tool-text">{item.text || '无文本结果'}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="bridge-timeline-empty">
                        {bridgeBinding?.conversationId
                          ? '这条会话还没有生成快照。'
                          : '先关联或继续对话，才会生成共享上下文快照。'}
                      </div>
                    )}
                  </div>

                  <div className="bridge-timeline">
                    <div className="bridge-timeline-header">
                      <span className="bridge-context-label">最近共享时间线</span>
                      {isConversationLoading && <span className="bridge-context-meta">加载中...</span>}
                    </div>
                    {timelineEvents.length === 0 ? (
                      <div className="bridge-timeline-empty">
                        {bridgeBinding?.conversationId
                          ? '这条共享时间线里还没有事件。'
                          : '先关联或继续对话，才会开始记录共享时间线。'}
                      </div>
                    ) : (
                      <div className="bridge-timeline-list">
                        {timelineEvents.map(event => (
                          <div key={`${event.seq}-${event.sourceType}-${event.sourceKey}`} className="bridge-timeline-item">
                            <div className="bridge-timeline-meta">
                              <span>{timelineSourceLabel(event.sourceType)}</span>
                              <span>#{event.seq}</span>
                            </div>
                            <div className="bridge-timeline-body">
                              {timelineEventText(event)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="bridge-chat-messages" ref={messagesRef} id="bridgeChatMessages">
                  {messages.length === 0 ? (
                    <div className="bridge-chat-no-msg">{t('bridge.noMessages') || '暂无消息'}</div>
                  ) : (
                    messages.map((m, i) => <ChatBubble key={i} message={m} />)
                  )}
                </div>
              </>
            ) : (
              <div className="bridge-chat-empty" id="bridgeChatEmpty">
                <span>{t('bridge.selectChat') || '选择一个对话'}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function shortConversationId(conversationId: string): string {
  return conversationId.length > 8 ? conversationId.slice(0, 8) : conversationId;
}

function timelineSourceLabel(sourceType: string): string {
  if (sourceType === 'local_session') return '本地';
  if (sourceType === 'bridge_owner') return 'Owner 通道';
  if (sourceType === 'bridge_guest') return 'Guest 通道';
  return sourceType;
}

function timelineEventText(event: TimelineEvent): string {
  const prefix = event.messageRole ? `${event.messageRole}: ` : '';
  const text = String(event.text || '').trim();
  if (text) return `${prefix}${text}`;
  return prefix || '事件';
}

function snapshotText(item?: SnapshotItem | null): string {
  if (!item?.text) return '暂无';
  return `[${item.source}] ${item.text}`;
}

function dotClass(status?: string): string {
  if (status === 'connected') return ' bridge-dot-ok';
  if (status === 'error') return ' bridge-dot-err';
  return ' bridge-dot-off';
}

function updateSidebarDot(data: Record<string, { status: string } | undefined>) {
  const dot = document.getElementById('bridgeDot');
  if (!dot) return;
  const anyConnected = data.telegram?.status === 'connected' || data.feishu?.status === 'connected' || data.whatsapp?.status === 'connected' || data.qq?.status === 'connected';
  dot.classList.toggle('connected', anyConnected);
}

function ContactAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const [showImg, setShowImg] = useState(!!avatarUrl);
  return (
    <div className="bridge-contact-avatar">
      {showImg && avatarUrl ? (
        <img
          className="bridge-contact-avatar-img"
          src={avatarUrl}
          alt={name}
          onError={() => setShowImg(false)}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </div>
  );
}

function ChatBubble({ message: m }: { message: BridgeMessage }) {
  if (m.role === 'assistant') {
    const { text } = parseMoodFromContent(m.content);
    const cleaned = (text || m.content).replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
    return (
      <div className="bridge-bubble-row bridge-bubble-in">
        <div className="bridge-bubble" dangerouslySetInnerHTML={{ __html: renderMarkdown(cleaned) }} />
      </div>
    );
  }
  // user: 去掉 [platform 私聊] xxx: 前缀
  let displayText = m.content;
  const prefixMatch = displayText.match(/^\[.+?\]\s*.+?:\s*/);
  if (prefixMatch) displayText = displayText.slice(prefixMatch[0].length);
  return (
    <div className="bridge-bubble-row bridge-bubble-out">
      <div className="bridge-bubble">{displayText}</div>
    </div>
  );
}
