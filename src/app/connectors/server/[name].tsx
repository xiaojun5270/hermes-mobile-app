// src/app/connectors/server/[name].tsx
//
// One MCP connector (spec §5.3): what it is, its on/off switch, Test, Sign in and Remove.
// Test really connects on the gateway, over the active chat's socket. Only
// the latest test counts: a result that arrives after a newer one started is
// dropped. Remote servers are tested when the screen opens; a local (stdio)
// one only on demand, because a test starts its process on the gateway.
//
// Sign in, the switch and Remove never overlap: the gateway snapshots the connector's
// config when a sign-in starts and saves that snapshot when it ends, which would silently
// undo a switch made in between. A sign-in owns the screen until it ends; so does a removal.
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { listMcpServers, removeMcpServer, setMcpServerEnabled, type McpServer } from '@/api/mcp';
import type { McpRuntimeRow } from '@/api/mcpSession';
import { consumeSignInRequest, dropSignInRequest, gatewayBaseUrl, useConnectorSignIn } from '@/components/connector-sign-in';
import { ConnectorSignInCard, type ConnectorSignInNote } from '@/components/connector-sign-in-card';
import { ConnectorTestCard, type ConnectorTestState } from '@/components/connector-test-card';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import {
  authLabel,
  connectorError,
  explainOauthRefusal,
  removeConfirmation,
  runtimeRowsByName,
  serverCapabilities,
  signInLabel,
  signInProblem,
  statusLine,
  type ConnectorAction,
} from '@/lib/mcp';
import { getProfileState, subscribeProfiles } from '@/profile-store';
import { getSessionMcpTarget, markMcpChanged, subscribeSessionMcpTarget } from '@/session-mcp-store';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

function Card({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

function Separator() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 16 }} />;
}

/** Label above value: connector addresses are too long for a one-line row. */
function Field({ label, value, selectable = false }: { label: string; value: string; selectable?: boolean }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={{ padding: 16, gap: 4, minHeight: 44 }}>
      <Text style={{ color: colors.textFaint, fontSize: 12.5, fontWeight: '600' }}>{label}</Text>
      <Text selectable={selectable} style={{ color: colors.text, fontSize: 15 }}>
        {value}
      </Text>
    </View>
  );
}

export default function ConnectorDetailScreen() {
  const { colors } = useTheme();
  const { name } = useLocalSearchParams<{ name: string }>();
  const profiles = useSyncExternalStore(subscribeProfiles, getProfileState);
  const target = useSyncExternalStore(subscribeSessionMcpTarget, getSessionMcpTarget);
  const connected = target?.connected ?? false;
  const profile = profiles.selected;
  const [server, setServer] = useState<McpServer | null>(null);
  const [row, setRow] = useState<McpRuntimeRow | undefined>(undefined);
  // true until the first fetch settles: the RefreshControl spins on first load.
  const [refreshing, setRefreshing] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectorTestState>({ phase: 'idle' });
  const testSeq = useRef(0);
  const autoTested = useRef(false);
  // A pull and a switch can overlap. Only the newest read may write state, and a switch
  // drops every read that started before it.
  const readGen = useRef(0);
  const readsInFlight = useRef(0);
  const { phase: signInPhase, cancelling, signIn, cancel: cancelSignIn } = useConnectorSignIn(profile);
  const signingIn = signInPhase !== null;
  const [signInNote, setSignInNote] = useState<ConnectorSignInNote | null>(null);
  const [removing, setRemoving] = useState(false);
  const signInChecked = useRef(false);
  // After an await, a screen that was left must not navigate or write: `dismissTo` would
  // replace whatever route is current by then.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A "sign in on open" request this screen could not use (its read failed, or the
      // connector is not OAuth) must not start a sign-in on some later visit.
      if (typeof name === 'string') dropSignInRequest(name);
    };
  }, [name]);
  // A late answer may navigate only while this screen is the one he is looking at. Mounted is
  // not enough: a chat pushed on top (a notification tap) leaves this screen mounted, and
  // `dismissTo` would then pop that chat.
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );

  /** `keepError`: a message is already on screen for the action that led here — leave it. */
  const fail = useCallback((e: unknown, action: ConnectorAction, keepError = false) => {
    const mapped = connectorError(e, action);
    if (mapped.kind === 'auth') {
      if (mounted.current) router.replace('/');
    } else if (!keepError) setError(mapped.message);
    return mapped.kind;
  }, []);

  /** Runtime status over the chat socket; a no-op without one. Never rejects. */
  const loadStatus = useCallback(() => {
    const t = getSessionMcpTarget();
    if (!t?.connected || typeof name !== 'string') return Promise.resolve();
    return t.status(profile).then((rows) => setRow(runtimeRowsByName(rows, profile !== null).get(name)));
  }, [name, profile]);

  // Every setter runs in a promise callback, never synchronously on the mount effect's path.
  // `keepError`: a re-read after a failed switch must not wipe that failure's message.
  const fetchServer = useCallback(
    (keepError = false) => {
      const gen = ++readGen.current;
      readsInFlight.current += 1;
      // No GET for one server exists — fetch the list and pick our row.
      return withAuthRetry((r) => listMcpServers(r, profile))
        .then((list) => {
          if (gen !== readGen.current) return; // superseded by a newer read or by a switch
          setServer(list.find((s) => s.name === name) ?? null);
          if (!keepError) setError(null);
          void loadStatus(); // not awaited: the screen must not wait on the chat socket
        })
        .catch((e: unknown) => {
          if (gen === readGen.current) fail(e, 'list', keepError);
        })
        .finally(() => {
          readsInFlight.current -= 1;
          // Only the newest read settles the spinner; it always does, so the spinner cannot stick.
          if (gen === readGen.current) {
            setRefreshing(false);
            setLoaded(true);
          }
        });
    },
    [name, profile, fail, loadStatus],
  );

  useEffect(() => {
    void fetchServer();
  }, [fetchServer]);

  // The chat socket came up (or back): fill in the status line. No REST refetch.
  useEffect(() => {
    if (!connected) return;
    void loadStatus();
  }, [connected, loadStatus]);

  function refresh() {
    setRefreshing(true);
    setError(null);
    void fetchServer();
  }

  /** Run a test. Only the latest one may write its result. */
  const runTest = useCallback(() => {
    const t = getSessionMcpTarget();
    if (!t?.connected || typeof name !== 'string') return Promise.resolve();
    const seq = ++testSeq.current;
    return Promise.resolve()
      .then(() => {
        setTest({ phase: 'running' });
        return t.test(name, profile);
      })
      .then((outcome) => {
        if (seq !== testSeq.current) return;
        setTest({ phase: 'done', outcome });
        // This test is newer than any sign-in that failed before it: that failure's note may
        // no longer be true (the provider's settings were changed in between).
        setSignInNote((note) => (note?.tone === 'error' ? null : note));
      });
  }, [name, profile]);

  /** Run a sign-in. It owns the screen until it ends; its result replaces any test's. */
  const startSignIn = useCallback(() => {
    if (typeof name !== 'string') return Promise.resolve();
    testSeq.current += 1; // a test already in flight must not overwrite what follows
    return Promise.resolve()
      .then(() => {
        setTest({ phase: 'idle' }); // that superseded test will never report: do not leave "Testing…"
        setSignInNote(null);
        return signIn(name);
      })
      .then((outcome) => {
        if (!mounted.current) return;
        if (outcome.kind === 'approved') {
          testSeq.current += 1;
          setTest({
            phase: 'done',
            outcome: { kind: 'ok', tools: outcome.tools, prompts: 0, resources: 0, tokensPresent: true },
          });
          setSignInNote({ tone: 'info', text: '已登录。' });
          markMcpChanged(); // the running gateway reconnects it only if it was already loaded
        } else if (outcome.kind === 'cancelled') {
          setSignInNote({ tone: 'info', text: '已取消登录。' });
          void runTest(); // a sign-in that did complete on the gateway still shows
        } else {
          setSignInNote({ tone: 'error', ...signInProblem(outcome.message, gatewayBaseUrl(), name) });
        }
        void fetchServer(true); // the gateway re-saves the connector when a sign-in ends
      })
      .catch((e: unknown) => {
        if (mounted.current) fail(e, 'signin');
      });
  }, [name, signIn, runTest, fetchServer, fail]);

  const caps = server ? serverCapabilities(server) : null;
  const autoTest = caps?.autoTest ?? false;
  const canSignIn = caps?.canSignIn ?? false;

  // An add screen asked for a sign-in as soon as this connector opens (a one-shot, in memory).
  // Declared before the automatic test so that test is skipped: the sign-in's result replaces it.
  useEffect(() => {
    if (!canSignIn || signInChecked.current || typeof name !== 'string') return;
    signInChecked.current = true;
    if (!consumeSignInRequest(name)) return;
    autoTested.current = true;
    void startSignIn();
  }, [canSignIn, name, startSignIn]);

  // Remote connectors are tested once, as soon as both the server and a chat socket are known.
  useEffect(() => {
    if (!autoTest || !connected || autoTested.current || !getSessionMcpTarget()?.connected) return;
    autoTested.current = true;
    void runTest();
  }, [autoTest, connected, runTest]);

  /** Optimistic on/off — flip immediately, revert if the gateway says no. */
  async function toggle(current: McpServer) {
    if (busy || signingIn || removing) return;
    const hadRead = readsInFlight.current > 0;
    readGen.current += 1; // a read already in flight predates this write: drop its result
    const enabling = !current.enabled;
    setBusy(true);
    setError(null);
    setServer({ ...current, enabled: enabling });
    let failed: ReturnType<typeof fail> | null = null;
    try {
      const res = await withAuthRetry((r) => setMcpServerEnabled(r, current.name, enabling, profile));
      setServer({ ...current, enabled: res.enabled });
      markMcpChanged(); // the running gateway does not have this yet: the list offers a reload
    } catch (e) {
      setServer(current); // revert
      failed = fail(e, 'switch');
    } finally {
      setBusy(false);
    }
    if (failed === 'auth') return;
    // A failed write may still have landed, and a dropped read never reported: show the truth.
    if (failed || hadRead) void fetchServer(failed !== null);
  }

  /** Remove the connector. The alert has already asked. */
  async function remove(current: McpServer) {
    if (busy || signingIn || removing) return;
    readGen.current += 1; // a read already in flight predates this write: drop its result
    setRemoving(true);
    setError(null);
    try {
      await withAuthRetry((r) => removeMcpServer(r, current.name, profile));
      markMcpChanged(); // the running gateway still has it loaded
    } catch (e) {
      if (!mounted.current) return;
      const kind = fail(e, 'remove');
      // `gone`: it was removed elsewhere in the meantime — the same end state, so leave as well.
      if (kind !== 'gone') {
        setRemoving(false);
        if (kind !== 'auth') void fetchServer(true);
        return;
      }
    }
    if (focused.current) router.dismissTo('/connectors');
    else if (mounted.current) {
      // He is elsewhere: do not pull him back. When he returns this reads "Connector not found".
      setRemoving(false);
      void fetchServer(true);
    }
  }

  function confirmRemove(current: McpServer) {
    const { title, message } = removeConfirmation(current.name);
    Alert.alert(title, message, [
      { text: '取消', style: 'cancel' },
      { text: '移除', style: 'destructive', onPress: () => void remove(current) },
    ]);
  }

  const status = server && connected ? statusLine(server, row) : null;
  const lastOutcome = test.phase === 'done' ? test.outcome : null;
  // A test already shows that the provider refuses to register the gateway: the sign-in card
  // says what to do (and gives the address to allow) without a sign-in attempt first. A
  // finished test is never older than the stored note (a sign-in resets the test), so it wins.
  const refusedTest =
    canSignIn && lastOutcome && lastOutcome.kind !== 'ok' && typeof name === 'string' && explainOauthRefusal(lastOutcome.message)
      ? signInProblem(lastOutcome.message, gatewayBaseUrl(), name)
      : null;
  const shownSignInNote: ConnectorSignInNote | null = refusedTest ? { tone: 'error', ...refusedTest } : signInNote;

  return (
    <ScrollView
      testID="connector-detail"
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textDim} />}
    >
      <Stack.Screen options={{ title: typeof name === 'string' ? name : '连接器' }} />

      {error ? (
        <Text selectable style={{ color: colors.danger, fontSize: 14 }}>
          {error}
        </Text>
      ) : null}

      {!loaded ? (
        <Text style={{ color: colors.textFaint, fontSize: 14, textAlign: 'center', paddingTop: 48 }}>正在加载…</Text>
      ) : server && caps ? (
        <>
          <Card>
            {caps.canSwitch ? (
              <>
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: 16, minHeight: 44 }}
                >
                  <Text style={{ color: colors.text, fontSize: 15.5 }}>已启用</Text>
                  <Switch
                    value={server.enabled}
                    disabled={busy || signingIn || removing}
                    onValueChange={() => toggle(server)}
                    accessibilityLabel="已启用"
                    trackColor={{ true: colors.accent }}
                    hitSlop={8}
                  />
                </View>
                <Separator />
              </>
            ) : null}
            {server.url ? (
              <Field label="地址" value={server.url} selectable />
            ) : (
              <Field label="命令" value={[server.command ?? '', ...server.args].join(' ').trim() || '未知'} selectable />
            )}
            <Separator />
            <Field label="身份验证" value={authLabel(server) ?? '无'} />
            {status ? (
              <>
                <Separator />
                <Field label="状态" value={status} />
              </>
            ) : null}
            {server.plugin ? (
              <>
                <Separator />
                <Field label="提供方" value={`插件：${server.plugin}`} />
              </>
            ) : null}
          </Card>

          {caps.canSignIn ? (
            <ConnectorSignInCard
              label={signInLabel(lastOutcome)}
              phase={signInPhase}
              cancelling={cancelling}
              note={shownSignInNote}
              disabled={busy || removing}
              onSignIn={() => void startSignIn()}
              onCancel={cancelSignIn}
            />
          ) : null}

          {caps.canTest ? (
            <ConnectorTestCard
              state={test}
              connected={connected}
              disabled={signingIn || removing}
              explainedAbove={refusedTest !== null}
              onTest={() => void runTest()}
            />
          ) : null}

          {caps.canRemove ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="移除连接器"
              accessibilityState={{ disabled: busy || signingIn || removing }}
              disabled={busy || signingIn || removing}
              onPress={() => confirmRemove(server)}
              style={({ pressed }) => ({
                minHeight: 44,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 12,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: pressed ? colors.surface : 'transparent',
                opacity: busy || signingIn || removing ? 0.45 : 1,
              })}
            >
              <Text style={{ color: colors.danger, fontSize: 15, fontWeight: '600' }}>
                {removing ? '正在移除…' : '移除连接器'}
              </Text>
            </Pressable>
          ) : null}

          <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4 }}>
            {!caps.manageable
              ? '连接器名称包含“/”，无法在应用中修改。 '
              : server.source === 'plugin'
                ? '此连接器由插件提供，请在插件设置中修改。 '
                : server.transport === 'stdio'
                  ? '本地连接器在网关运行，可以在这里启停和测试，编辑需在网关进行。 '
                  : ''}

            重新加载连接器或重启网关后，智能体才会使用修改后的配置。
          </Text>
        </>
      ) : !error ? (
        <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
          <Icon sf="questionmark.circle" size={44} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>未找到连接器</Text>
          <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>
            “{name}”已从网关配置中移除，请下拉刷新。
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
