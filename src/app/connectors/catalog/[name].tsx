// src/app/connectors/catalog/[name].tsx
//
// One catalog entry (spec §5.4): what it is, where the agent will connect, how it signs in,
// and Add. Credentials an entry asks for are typed into ConnectorSecretForm, which owns them
// and runs Face ID before they are sent (spec §5.9).
//
// Installing makes the gateway connect to the server, so it can take most of a minute. If
// the answer is lost, the catalog is read again before another attempt is allowed. Sign-in
// for an OAuth entry is not started here: the connector's own screen owns it.
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import {
  McpAlreadyAddedError,
  McpPreflightError,
  installMcpCatalogEntry,
  listMcpCatalog,
  type McpCatalogEntry,
} from '@/api/mcp';
import { CardButton } from '@/components/card-button';
import { ConnectorSecretForm, type SubmitResult } from '@/components/connector-secret-form';
import { gatewayBaseUrl, requestSignInOnOpen } from '@/components/connector-sign-in';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import { catalogAuthLabel, connectorError, gatewaySupportsOauth, secretFieldsForEntry } from '@/lib/mcp';
import { getProfileState, subscribeProfiles } from '@/profile-store';
import { markMcpChanged } from '@/session-mcp-store';
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

/** Leave the add screens: the list, with the new connector's detail on top of it. */
function openConnector(name: string): void {
  router.dismissTo('/connectors');
  router.push({ pathname: '/connectors/server/[name]', params: { name } });
}

export default function CatalogEntryScreen() {
  const { colors } = useTheme();
  const { name } = useLocalSearchParams<{ name: string }>();
  const profiles = useSyncExternalStore(subscribeProfiles, getProfileState);
  const profile = profiles.selected;
  const [entry, setEntry] = useState<McpCatalogEntry | null>(null);
  // true until the first fetch settles: the RefreshControl spins on first load.
  const [refreshing, setRefreshing] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After an await, a screen that was left must not navigate or write state.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  /** This entry as the gateway has it now; null when it is not in the catalog. Rejects on failure. */
  const readEntry = useCallback(
    () =>
      withAuthRetry((r) => listMcpCatalog(r, profile)).then(
        (catalog) => (catalog.entries ?? []).find((e) => e.name === name) ?? null,
      ),
    [name, profile],
  );

  // Every setter runs in a promise callback, never synchronously on the mount effect's path.
  const fetchEntry = useCallback(
    () =>
      readEntry()
        .then((found) => {
          if (!mounted.current) return;
          setEntry(found);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!mounted.current) return;
          const mapped = connectorError(e, 'catalog');
          if (mapped.kind === 'auth') router.replace('/');
          else setError(mapped.message);
        })
        .finally(() => {
          if (!mounted.current) return;
          setRefreshing(false);
          setLoaded(true);
        }),
    [readEntry],
  );

  useEffect(() => {
    void fetchEntry();
  }, [fetchEntry]);

  function refresh() {
    setRefreshing(true);
    setError(null);
    void fetchEntry();
  }

  /** The connector exists on the gateway because of this screen: note it, then go to it. */
  function finish(added: McpCatalogEntry) {
    markMcpChanged(); // the running gateway does not have it yet: the list offers a reload
    if (!focused.current) {
      // He is elsewhere: do not pull him back, and do not queue a sign-in page for later.
      if (mounted.current) void fetchEntry(); // this screen then reads "Already added / Open"
      return;
    }
    if (added.auth_type === 'oauth') requestSignInOnOpen(added.name);
    openConnector(added.name);
  }

  /** ConnectorSecretForm hands over the typed values here, after Face ID. They go into the
   * request and nowhere else. */
  async function install(current: McpCatalogEntry, env: Record<string, string>): Promise<SubmitResult> {
    const handled: SubmitResult = { ok: false, message: '' };
    try {
      await withAuthRetry((r) => installMcpCatalogEntry(r, current.name, env, profile));
    } catch (e) {
      if (!mounted.current) return handled;
      const mapped = connectorError(e, 'install');
      if (mapped.kind === 'auth') {
        router.replace('/');
        return handled;
      }
      // The fast request failed: nothing was sent, so nothing can have been stored or installed.
      if (e instanceof McpPreflightError) return { ok: false, message: mapped.message };
      // Someone else added it in the meantime: show that, do not adopt it as ours.
      if (e instanceof McpAlreadyAddedError) {
        void fetchEntry();
        return { ok: false, message: mapped.message };
      }
      // The answer may have been lost after the gateway installed it: look before he retries.
      const now = await readEntry().catch(() => null);
      if (!mounted.current) return handled;
      if (now?.installed) {
        finish(now);
        return { ok: true };
      }
      if (now) setEntry(now);
      const stored = Object.keys(env).length > 0 ? ' 你输入的内容可能已保存到网关。' : '';
      return { ok: false, message: `${mapped.message}${stored}` };
    }
    finish(current);
    return { ok: true };
  }

  const source = entry?.source && /^https:\/\//i.test(entry.source) ? entry.source : null;
  const base = gatewayBaseUrl();
  // The sign-in that follows an OAuth entry cannot work on a plain-HTTP gateway: say so before adding.
  const oauthBlocked = entry?.auth_type === 'oauth' && !(base && gatewaySupportsOauth(base));

  return (
    <ScrollView
      testID="connector-catalog-entry"
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
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
      ) : entry ? (
        <>
          {entry.description ? (
            <Text style={{ color: colors.text, fontSize: 15.5, marginHorizontal: 4 }}>{entry.description}</Text>
          ) : null}

          <Card>
            <Field label="地址" value={entry.url ?? '未知'} selectable />
            <Separator />
            <Field label="登录" value={catalogAuthLabel(entry)} />
          </Card>

          {source ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="关于此连接器"
              onPress={() => void Linking.openURL(source)}
              style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', marginHorizontal: 4, opacity: pressed ? 0.5 : 1 })}
            >
              <Text style={{ color: colors.accent, fontSize: 15 }}>关于此连接器</Text>
            </Pressable>
          ) : null}

          {entry.installed ? (
            <View style={{ gap: 10 }}>
              <Text style={{ color: colors.textDim, fontSize: 14.5, marginHorizontal: 4 }}>已添加</Text>
              <CardButton label="打开" a11y="打开连接器" onPress={() => openConnector(entry.name)} primary />
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {oauthBlocked ? (
                <Text accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 13.5, marginHorizontal: 4 }}>

                  OAuth 登录需要网关使用 HTTPS 地址。
                </Text>
              ) : null}
              <ConnectorSecretForm
                fields={secretFieldsForEntry(entry)}
                submitLabel="添加连接器"
                busyLabel="正在添加，可能需要一分钟…"
                beforeSubmit={() => !oauthBlocked}
                onSubmit={(env) => install(entry, env)}
              />
            </View>
          )}

          <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4 }}>

            添加后，网关上的智能体可以连接上述地址。重新加载连接器或重启网关后生效。
          </Text>
        </>
      ) : !error ? (
        <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
          <Icon sf="questionmark.circle" size={44} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>目录中未找到</Text>
          <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>
            “{name}”不在网关目录中，请下拉刷新。
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
