// src/app/connectors.tsx
//
// MCP connectors configured on the gateway (docs/contracts/mcp.md, spec §5.2).
// The list and the on/off switch are REST. The status line comes from the
// active chat's socket (session-mcp-store) and is simply absent without one.
// The running gateway picks a change up only on a reload or a restart, so after a change
// the list offers Reload now (spec §5.7).
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { listMcpServers, setMcpServerEnabled, type McpServer } from '@/api/mcp';
import type { McpRuntimeRow } from '@/api/mcpSession';
import { CardButton } from '@/components/card-button';
import { ConnectorReloadBanner } from '@/components/connector-reload-banner';
import { ConnectorRow } from '@/components/connector-row';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import { connectorError, needsReload, runtimeRowsByName, statusLine, type ConnectorAction } from '@/lib/mcp';
import { getProfileState, subscribeProfiles } from '@/profile-store';
import {
  clearMcpChanged,
  getMcpChangePending,
  mcpChangeMark,
  getSessionMcpTarget,
  markMcpChanged,
  subscribeMcpChange,
  subscribeSessionMcpTarget,
} from '@/session-mcp-store';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

const RELOAD_NOTE = '重新加载或重启网关后，智能体才会使用修改后的配置。';

export default function ConnectorsScreen() {
  const { colors } = useTheme();
  const profiles = useSyncExternalStore(subscribeProfiles, getProfileState);
  const target = useSyncExternalStore(subscribeSessionMcpTarget, getSessionMcpTarget);
  const connected = target?.connected ?? false;
  const pending = useSyncExternalStore(subscribeMcpChange, getMcpChangePending);
  const profile = profiles.selected;
  const [servers, setServers] = useState<McpServer[]>([]);
  const [rows, setRows] = useState<Map<string, McpRuntimeRow>>(() => new Map());
  // true until the first fetch settles: the RefreshControl spins on first load.
  const [refreshing, setRefreshing] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadNote, setReloadNote] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  // Reads and writes overlap here: a silent re-read on focus, a pull, a switch. Only the
  // newest read may write state, and a switch drops every read that started before it.
  const readGen = useRef(0);
  const readsInFlight = useRef(0);
  const switching = useRef(new Set<string>());
  const reloadLatch = useRef(false); // one alert, one reload: from the press until it ends

  /** Show a failure; returns its kind so the caller can react. `keepError`: a message is
   * already on screen for the action that led here (a failed switch) — leave it. */
  const fail = useCallback((e: unknown, action: ConnectorAction, keepError = false) => {
    const mapped = connectorError(e, action);
    if (mapped.kind === 'auth') {
      // Silent re-login already failed inside withAuthRetry — credentials are dead.
      router.replace('/');
    } else if (mapped.kind === 'unsupported') {
      setUnsupported(mapped.message);
    } else if (!keepError) {
      setError(mapped.message);
    }
    return mapped.kind;
  }, []);

  /** Runtime status over the chat socket; a no-op without one. Never rejects. */
  const loadStatus = useCallback(() => {
    const t = getSessionMcpTarget();
    if (!t?.connected) return Promise.resolve();
    return t.status(profile).then((r) => setRows(runtimeRowsByName(r, profile !== null)));
  }, [profile]);

  /** The REST list, then the status lines. Never clears `error` itself, so a caller's message
   * survives a successful re-read; with `keepError` it survives a failed one too. */
  const fetchList = useCallback(
    async (keepError = false) => {
      const gen = ++readGen.current;
      readsInFlight.current += 1;
      try {
        const list = await withAuthRetry((r) => listMcpServers(r, profile));
        if (gen !== readGen.current) return; // superseded by a newer read or by a switch
        setServers(list);
        setUnsupported(null);
        void loadStatus(); // not awaited: the spinner must not wait on the chat socket
      } catch (e) {
        if (gen === readGen.current) fail(e, 'list', keepError);
      } finally {
        readsInFlight.current -= 1;
        // Only the newest read settles the spinner; it always does, so the spinner cannot stick.
        if (gen === readGen.current) {
          setRefreshing(false);
          setLoaded(true);
        }
      }
    },
    [profile, loadStatus, fail],
  );

  /** Pull to refresh. */
  const load = useCallback(() => {
    setRefreshing(true);
    setError(null);
    return fetchList();
  }, [fetchList]);

  // Re-read on every focus (a change made on the detail screen shows on return), without
  // raising the spinner: started from code on a re-focus, it leaves the list pushed down.
  useFocusEffect(
    useCallback(() => {
      setError(null);
      setReloadNote(null); // a change may have been made on another screen since
      void fetchList();
    }, [fetchList]),
  );

  // The chat socket came up (or back) after the list loaded: fill in the status lines.
  useEffect(() => {
    if (!connected) return;
    void loadStatus();
  }, [connected, loadStatus]);

  const replaceServer = useCallback((name: string, next: McpServer) => {
    setServers((prev) => prev.map((s) => (s.name === name ? next : s)));
  }, []);

  /** Optimistic on/off — flip immediately, revert if the gateway says no. */
  const toggle = useCallback(
    async (server: McpServer) => {
      if (switching.current.has(server.name)) return; // one write per connector at a time
      switching.current.add(server.name);
      const hadRead = readsInFlight.current > 0;
      readGen.current += 1; // a read already in flight predates this write: drop its result
      const enabling = !server.enabled;
      setError(null);
      setReloadNote(null); // "Reloaded." is about the state before this change
      replaceServer(server.name, { ...server, enabled: enabling });
      let failed: ReturnType<typeof fail> | null = null;
      try {
        const res = await withAuthRetry((r) => setMcpServerEnabled(r, server.name, enabling, profile));
        replaceServer(server.name, { ...server, enabled: res.enabled });
        markMcpChanged(); // the running gateway does not have this yet
      } catch (e) {
        replaceServer(server.name, server); // revert
        failed = fail(e, 'switch');
      } finally {
        switching.current.delete(server.name);
      }
      if (failed === 'auth') return;
      // A failed write may still have landed, and a dropped read never reported: show the truth.
      if (failed || hadRead) void fetchList(failed !== null);
    },
    [replaceServer, fail, fetchList, profile],
  );

  /** Reload the gateway's connectors over the chat socket. The alert has already asked. */
  const runReload = useCallback(async () => {
    const t = getSessionMcpTarget();
    if (!t?.connected || t.streaming) {
      reloadLatch.current = false;
      return;
    }
    const mark = mcpChangeMark(); // a change made while the reload runs must stay pending
    setReloading(true);
    setReloadNote(null);
    const outcome = await t.reload();
    reloadLatch.current = false;
    setReloading(false);
    if (outcome.kind === 'error') {
      setReloadNote({ tone: 'error', text: outcome.message });
      return;
    }
    if (outcome.kind === 'unknown') {
      setReloadNote({
        tone: 'error',
        text: '重新加载时连接中断，结果未确认，请检查连接器状态。',
      });
    } else {
      clearMcpChanged(mark);
      setReloadNote({ tone: 'info', text: outcome.thisChatOnly ? '已重新加载，仅对此会话生效。' : '已重新加载。' });
    }
    void fetchList(); // the list and the status lines, as the gateway has them now
  }, [fetchList]);

  /** A reload reaches every open chat and drops their prompt cache, so ask first. */
  const confirmReload = useCallback(() => {
    if (reloadLatch.current) return;
    reloadLatch.current = true;
    const release = () => {
      reloadLatch.current = false;
    };
    Alert.alert(
      '重新加载连接器？',
      '这会重新连接网关上所有打开会话的连接器，包括其他设备正在运行的会话。各会话下次发送消息时会重新发送完整上下文，费用可能增加。',
      [
        { text: '取消', style: 'cancel', onPress: release },
        { text: '重新加载', onPress: () => void runReload() },
      ],
      { onDismiss: release }, // Android: dismissed by tapping outside
    );
  }, [runReload]);

  const openDetail = useCallback((server: McpServer) => {
    router.push({ pathname: '/connectors/server/[name]', params: { name: server.name } });
  }, []);

  const profileName = profile ?? profiles.serverCurrent;
  // Shown after a change made here, and whenever the status rows say the running gateway
  // and the config disagree (which also covers a change made before the app restarted).
  const mismatch = connected && servers.some((s) => needsReload(s, rows.get(s.name)));
  const showBanner = !unsupported && (pending || mismatch);
  const reloadBlocked = !connected
    ? '请先返回会话并等待连接成功，再回来重新加载。'
    : target?.streaming
      ? '请等待当前任务结束。'
      : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: 'MCP 连接器',
          headerRight: unsupported
            ? undefined
            : () => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="添加连接器"
                  hitSlop={4}
                  onPress={() => router.push('/connectors/add')}
                  style={({ pressed }) => ({ padding: 10, opacity: pressed ? 0.5 : 1 })}
                >
                  <Icon sf="plus" size={22} color={colors.accent} />
                </Pressable>
              ),
        }}
      />

      {error ? (
        <Text selectable style={{ color: colors.danger, fontSize: 14, paddingHorizontal: 16, paddingTop: 8 }}>
          {error}
        </Text>
      ) : null}

      <FlatList
        testID="connectors-list"
        data={unsupported ? [] : servers}
        keyExtractor={(s) => s.name}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.textDim} />}
        renderItem={({ item }) => (
          <ConnectorRow
            server={item}
            status={connected ? statusLine(item, rows.get(item.name)) : null}
            onPress={openDetail}
            onToggle={toggle}
          />
        )}
        ListHeaderComponent={
          <View style={{ gap: 10 }}>
            {profiles.names.length > 1 && profileName && !unsupported ? (
              <Text style={{ color: colors.textFaint, fontSize: 13, marginHorizontal: 4 }}>配置档案： {profileName}</Text>
            ) : null}
            {showBanner ? (
              <ConnectorReloadBanner
                running={reloading}
                disabledReason={reloadBlocked}
                note={reloadNote}
                onReload={confirmReload}
              />
            ) : reloadNote ? (
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: reloadNote.tone === 'error' ? colors.danger : colors.textDim, fontSize: 13.5, marginHorizontal: 4 }}
              >
                {reloadNote.text}
              </Text>
            ) : null}
          </View>
        }
        ListFooterComponent={
          servers.length > 0 && !unsupported ? (
            <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4, marginTop: 6 }}>
              {RELOAD_NOTE}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          unsupported ? (
            <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
              <Icon sf="powerplug" size={44} color={colors.textFaint} />
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', textAlign: 'center' }}>

                连接器不可用
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>{unsupported}</Text>
            </View>
          ) : loaded && !refreshing && !error ? (
            <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
              <Icon sf="powerplug" size={44} color={colors.textFaint} />
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>暂无连接器</Text>
              <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>

                连接器可为网关上的智能体提供更多工具，可从目录或通过地址添加。
              </Text>
              <CardButton label="添加连接器" a11y="添加第一个连接器" onPress={() => router.push('/connectors/add')} primary />
            </View>
          ) : null
        }
      />
    </View>
  );
}
