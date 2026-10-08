import { router, usePathname, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  AppState,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getActiveProfile, listProfiles, listSessionsForProfile } from '@/api/profiles';
import { searchSessions, type SearchResult } from '@/api/search';
import { deleteSession, renameSession, setSessionArchived } from '@/api/sessions';
import type { SessionSummary } from '@/api/types';
import { Icon } from '@/components/icon';
import { PromptDialog } from '@/components/prompt-dialog';
import { SearchResultRow } from '@/components/search-result-row';
import { SessionRow } from '@/components/session-row';
import { AuthError } from '@/api/restClient';
import { withAuthRetry } from '@/connection';
import { getStartedDraft } from '@/draft-chat-store';
import { chatOnScreen } from '@/lib/chat-route';
import {
  activeProfileLabel,
  canServerSearch,
  getProfileState,
  hydrateProfileStore,
  setServerProfiles,
  subscribeProfiles,
} from '@/profile-store';
import { showProfilePicker } from '@/lib/profile-picker';
import { closeSidebar } from '@/sidebar-store';
import { getPinState, hydratePinStore, pinSession, setPinsCollapsed, subscribePins, unpinSession } from '@/pin-store';
import { sessionPinId } from '@/lib/session-utils';
import { searchView, type SearchHits } from '@/lib/sidebar-search';
import { serif, useTheme } from '@/theme';

const isIOS = process.env.EXPO_OS === 'ios';
const SEARCH_DEBOUNCE_MS = 300;

type Row =
  | { kind: 'session'; session: SessionSummary }
  | { kind: 'hit'; hit: SearchResult };

function NavItem({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 13,
        paddingHorizontal: 16,
        paddingVertical: 12.5,
        borderRadius: 10,
        borderCurve: 'continuous',
        backgroundColor: pressed ? colors.raised : 'transparent',
      })}
    >
      <Icon sf={icon} size={20} color={colors.text} />
      <Text style={{ color: colors.text, fontSize: 16.5 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * Slide-over sidebar in the style of the Claude app: wordmark + avatar,
 * search, destination list, recents, and a floating New chat pill. Rendered
 * by SidebarHost behind the main content; `open` drives data loading.
 */
export function Sidebar({ open, width }: { open: boolean; width: number }) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // Last server FTS answer, tagged with the query it answers so stale results
  // never render while a newer request is still in flight. Pending/visible
  // state is derived from it at render time (searchView).
  const [hits, setHits] = useState<SearchHits | null>(null);
  // Android rename dialog target (iOS uses Alert.prompt instead).
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const profiles = useSyncExternalStore(subscribeProfiles, getProfileState);
  const pinState = useSyncExternalStore(subscribePins, getPinState);
  const activeProfile = profiles.selected; // null = server default (no param sent)

  const handleLoadError = useCallback((e: unknown) => {
    if (e instanceof AuthError) {
      // Silent re-login already failed inside withAuthRetry — credentials are dead.
      closeSidebar();
      router.replace('/');
      return;
    }
    setError('无法连接网关，请检查 VPN 或 Wi-Fi 后下拉重试。');
  }, []);

  // Every setter runs in a promise callback, never synchronously on the
  // drawer-open effect's path. Reads the selected profile from the store after
  // hydrating (not the render-time `activeProfile`), so it doesn't depend on it;
  // the drawer-open effect lists `activeProfile` to reload on a switch.
  const load = useCallback(
    (opts?: { silent?: boolean }) =>
      hydrateProfileStore()
        .then(() => {
          if (!opts?.silent) setRefreshing(true);
          setError(null);
          return hydratePinStore();
        })
        .then(() =>
          withAuthRetry((r) =>
            listSessionsForProfile(r, getProfileState().selected, 0, showArchived ? 'only' : 'exclude'),
          ),
        )
        .then((res) => {
          const pinIds = new Set(getPinState().ids);
          setSessions((prev) => {
            if (prev.length === 0 || pinIds.size === 0) return res.sessions;
            const incomingIds = new Set(res.sessions.map((s) => s.id));
            const survivors = prev.filter(
              (s) => !incomingIds.has(s.id) &&
                (pinIds.has(s.id) || (s._lineage_root_id && pinIds.has(s._lineage_root_id))),
            );
            return [...res.sessions, ...survivors];
          });
          setTotal(res.total);
        })
        .catch(handleLoadError)
        .finally(() => {
          setRefreshing(false);
          setLoaded(true);
        }),
    [handleLoadError, showArchived],
  );

  // Pull-to-refresh: raise the spinner and clear the error in the handler.
  const refresh = useCallback(() => {
    setRefreshing(true);
    setError(null);
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (loadingMore || refreshing || query || sessions.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await withAuthRetry((r) =>
        listSessionsForProfile(r, activeProfile, sessions.length, showArchived ? 'only' : 'exclude'),
      );
      setTotal(res.total);
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...res.sessions.filter((s) => !seen.has(s.id))];
      });
    } catch (e) {
      handleLoadError(e);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, refreshing, query, sessions, total, handleLoadError, activeProfile, showArchived]);

  // Refresh whenever the drawer opens (and on archive/profile switches while open).
  useEffect(() => {
    if (open) void load();
  }, [open, load, activeProfile, showArchived]);

  // Reflect out-of-band activity (web dashboard, another device): when the app
  // returns to the foreground with the drawer open, silently re-pull the list.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && open) void load({ silent: true });
    });
    return () => sub.remove();
  }, [open, load]);

  // Profile discovery: the switcher appears only when the server knows more
  // than one profile. Failures keep it hidden — never blocking.
  useEffect(() => {
    if (!open) return;
    (async () => {
      await hydrateProfileStore();
      try {
        const [list, active] = await Promise.all([
          withAuthRetry((r) => listProfiles(r)),
          withAuthRetry((r) => getActiveProfile(r)),
        ]);
        setServerProfiles(
          list.profiles.map((p) => p.name),
          active.current || null,
        );
      } catch {
        // offline or older server — single-profile behavior
      }
    })();
  }, [open]);

  // Debounced server-side full-text search. While a request is in flight the
  // list keeps showing the instant client-side filter below.
  // FTS has no profile param (docs/contracts/sessions-extra.md) — it answers
  // for the backend's own profile only, so skip it for other targets and let
  // the client-side filter stand.
  const serverSearchOk = canServerSearch(profiles);
  // The effect only schedules the request; every setter runs in its callbacks.
  useEffect(() => {
    const q = query.trim();
    if (!q || !serverSearchOk) return;
    let stale = false;
    const timer = setTimeout(() => {
      withAuthRetry((r) => searchSessions(r, q)).then(
        (res) => {
          if (!stale) setHits({ q, results: res.results });
        },
        (e: unknown) => {
          if (stale) return;
          // Answered (failed) → no longer pending; the client-side filter stands.
          setHits({ q, results: null });
          if (e instanceof AuthError) {
            closeSidebar();
            router.replace('/');
          }
          // Otherwise a network/server hiccup: silently fall back to the client-side filter.
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, serverSearchOk]);
  const search = searchView(query, hits, serverSearchOk);
  const serverHits = search.results;

  const handleActionError = useCallback((e: unknown, what: string) => {
    if (e instanceof AuthError) {
      closeSidebar();
      router.replace('/');
      return;
    }
    Alert.alert(`${what}失败`, e instanceof Error ? e.message : '无法连接网关。');
  }, []);

  const toggleArchived = useCallback(
    async (session: SessionSummary) => {
      try {
        await withAuthRetry((r) => setSessionArchived(r, session.id, !showArchived, activeProfile));
        unpinSession(sessionPinId(session));
        // The session leaves the current view either way (archived from active,
        // restored from archived).
        setSessions((prev) => prev.filter((s) => s.id !== session.id));
        setTotal((t) => Math.max(0, t - 1));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e) {
        handleActionError(e, showArchived ? '取消归档' : '归档');
      }
    },
    [handleActionError, activeProfile, showArchived],
  );

  const confirmDelete = useCallback(
    (session: SessionSummary) => {
      const title = session.title?.trim() || session.preview?.trim() || '此会话';
      Alert.alert(
        '删除会话？',
        `“${title}”将从网关永久删除。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: async () => {
              try {
                await withAuthRetry((r) => deleteSession(r, session.id, activeProfile));
                unpinSession(sessionPinId(session));
                setSessions((prev) => prev.filter((s) => s.id !== session.id));
                setTotal((t) => Math.max(0, t - 1));
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              } catch (e) {
                handleActionError(e, '删除');
              }
            },
          },
        ],
      );
    },
    [handleActionError, activeProfile],
  );

  const applyRename = useCallback(
    async (session: SessionSummary, value: string) => {
      const title = value.trim();
      try {
        const res = await withAuthRetry((r) => renameSession(r, session.id, title, activeProfile));
        setSessions((prev) =>
          prev.map((s) => (s.id === session.id ? { ...s, title: res.title?.trim() || null } : s)),
        );
      } catch (e) {
        handleActionError(e, '重命名');
      }
    },
    [handleActionError, activeProfile],
  );

  const promptRename = useCallback(
    (session: SessionSummary) => {
      if (isIOS) {
        // Alert.prompt is iOS-only; Android renders the PromptDialog below.
        Alert.prompt(
          '重命名会话',
          '留空可清除标题。',
          [
            { text: '取消', style: 'cancel' },
            { text: '保存', onPress: (value?: string) => void applyRename(session, value ?? '') },
          ],
          'plain-text',
          session.title ?? '',
        );
        return;
      }
      setRenameTarget(session);
    },
    [applyRename],
  );

  const openChat = useCallback(
    (sessionId: string) => {
      closeSidebar();
      if (chatOnScreen(pathname, getStartedDraft()) !== sessionId) router.replace(`/chat/${sessionId}`);
    },
    [pathname],
  );

  const newChat = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeSidebar();
    // Only an unstarted draft is already a new chat: a lazily created chat keeps /chat/new.
    if (chatOnScreen(pathname, getStartedDraft()) !== 'new') router.replace('/chat/new');
  }, [pathname]);

  const pushRoute = useCallback((route: Href) => {
    closeSidebar();
    router.push(route);
  }, []);

  const sessionByAnyId = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const s of sessions) {
      map.set(s.id, s);
      if (s._lineage_root_id && !map.has(s._lineage_root_id)) {
        map.set(s._lineage_root_id, s);
      }
    }
    return map;
  }, [sessions]);

  const pinnedSessions = useMemo(() => {
    const seen = new Set<string>();
    const out: SessionSummary[] = [];
    for (const pinId of pinState.ids) {
      const session = sessionByAnyId.get(pinId);
      if (session && !seen.has(session.id)) {
        seen.add(session.id);
        out.push(session);
      }
    }
    return out;
  }, [pinState.ids, sessionByAnyId]);

  const pinnedLiveIdSet = useMemo(
    () => new Set(pinnedSessions.map((s) => s.id)),
    [pinnedSessions],
  );

  const titleById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const s of sessions) map.set(s.id, s.title?.trim() || s.preview?.trim() || null);
    return map;
  }, [sessions]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim();
    // Server FTS results, once they answer the live query.
    if (serverHits) {
      return serverHits.map((hit) => ({ kind: 'hit' as const, hit }));
    }
    // No query, request still in flight, failed, or server search unavailable
    // → instant client-side filter.
    const lower = q.toLowerCase();
    const list = !lower
      ? sessions
      : sessions.filter(
          (s) =>
            (s.title ?? '').toLowerCase().includes(lower) ||
            (s.preview ?? '').toLowerCase().includes(lower),
        );
    return list
      .filter((s) => !pinnedLiveIdSet.has(s.id))
      .map((session) => ({ kind: 'session' as const, session }));
  }, [sessions, query, serverHits, pinnedLiveIdSet]);

  const searching = query.trim().length > 0;
  const profileInitial = (activeProfileLabel(profiles) || 'H')[0]?.toUpperCase() ?? 'H';

  return (
    <View style={{ width, flex: 1, paddingTop: insets.top + 10 }}>
      {/* Wordmark + avatar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 20,
          paddingRight: 14,
          paddingBottom: 10,
        }}
      >
        <Text style={{ fontFamily: serif, fontSize: 27, color: colors.text, letterSpacing: 0.2 }}>
          Hermes
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="设置"
          hitSlop={6}
          onPress={() => pushRoute('/settings')}
          style={({ pressed }) => ({
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? colors.raised : colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
          })}
        >
          <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>{profileInitial}</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginHorizontal: 14,
          marginBottom: 8,
          paddingHorizontal: 12,
          height: 40,
          borderRadius: 20,
          backgroundColor: colors.raised,
        }}
      >
        <Icon sf="magnifyingglass" size={16} color={colors.textFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索会话"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          style={{ flex: 1, color: colors.text, fontSize: 16, height: 40 }}
        />
      </View>

      {/* Destinations (hidden while searching to give results room) */}
      {!searching ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 4 }}>
          <NavItem icon="bubble.left.and.bubble.right" label="会话" onPress={newChat} />
          <NavItem icon="clock.arrow.circlepath" label="定时任务" onPress={() => pushRoute('/cron')} />
          <NavItem icon="books.vertical" label="记忆" onPress={() => pushRoute('/memory')} />
          <NavItem icon="sparkles" label="技能" onPress={() => pushRoute('/skills')} />
          <NavItem icon="powerplug" label="MCP 连接器" onPress={() => pushRoute('/connectors')} />
          <NavItem icon="cpu" label="模型" onPress={() => pushRoute('/models')} />
        </View>
      ) : null}

      {/* Pinned section — hidden when searching or in archived view */}
      {!searching && !showArchived && pinnedSessions.length > 0 ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pinState.collapsed ? '展开置顶会话' : '收起置顶会话'}
            accessibilityState={{ expanded: !pinState.collapsed }}
            onPress={() => setPinsCollapsed(!pinState.collapsed)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              paddingLeft: 20,
              paddingRight: 10,
              paddingTop: 8,
              paddingBottom: 2,
              gap: 8,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Icon sf={pinState.collapsed ? 'chevron.right' : 'chevron.down'} size={12} color={colors.textFaint} />
            <Text style={{ flex: 1, color: colors.textFaint, fontSize: 13.5, fontWeight: '500' }}>

              置顶
            </Text>
          </Pressable>
          {!pinState.collapsed ? pinnedSessions.map((session) => (
            <SessionRow
              key={session.id}
              compact
              session={session}
              pinned
              onPress={() => openChat(session.id)}
              onPin={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); unpinSession(sessionPinId(session)); }}
              onRename={() => promptRename(session)}
              onArchive={() => toggleArchived(session)}
              onDelete={() => confirmDelete(session)}
            />
          )) : null}
        </View>
      ) : null}

      {/* Recents header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 20,
          paddingRight: 10,
          paddingTop: 8,
          paddingBottom: 2,
          gap: 8,
        }}
      >
        <Text style={{ flex: 1, color: colors.textFaint, fontSize: 13.5, fontWeight: '500' }}>
          {searching ? '搜索结果' : showArchived ? '已归档' : '最近会话'}
        </Text>
        {profiles.names.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`当前配置档案：${activeProfileLabel(profiles)}，切换配置档案`}
            hitSlop={8}
            onPress={showProfilePicker}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              maxWidth: 110,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 999,
              backgroundColor: colors.raised,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Icon sf="person.crop.circle" size={13} color={colors.accent} />
            <Text numberOfLines={1} style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>
              {activeProfileLabel(profiles)}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showArchived ? '显示未归档会话' : '显示已归档会话'}
          accessibilityState={{ selected: showArchived }}
          hitSlop={8}
          onPress={() => {
            Haptics.selectionAsync();
            setSessions([]);
            setTotal(0);
            setLoaded(false);
            setShowArchived((v) => !v);
          }}
          style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.5 : 1 })}
        >
          <Icon
            sf={showArchived ? 'archivebox.fill' : 'archivebox'}
            size={17}
            color={showArchived ? colors.accent : colors.textFaint}
          />
        </Pressable>
      </View>

      {error ? (
        <Text selectable style={{ color: colors.danger, fontSize: 13.5, paddingHorizontal: 20, paddingTop: 6 }}>
          {error}
        </Text>
      ) : null}

      <Animated.FlatList
        data={rows}
        keyExtractor={(row, index) =>
          row.kind === 'session' ? `s:${row.session.id}` : `h:${row.hit.session_id}:${index}`
        }
        // Remaining rows slide up smoothly when one is archived or deleted.
        itemLayoutAnimation={LinearTransition.duration(220)}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: insets.bottom + 92 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textDim} />}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) =>
          item.kind === 'hit' ? (
            <SearchResultRow
              hit={item.hit}
              title={titleById.get(item.hit.session_id)}
              onPress={() => openChat(item.hit.session_id)}
            />
          ) : (
            <SessionRow
              compact
              session={item.session}
              onPin={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); pinSession(sessionPinId(item.session)); }}
              pinned={false}
              onPress={() => openChat(item.session.id)}
              onRename={!showArchived ? () => promptRename(item.session) : undefined}
              onArchive={() => toggleArchived(item.session)}
              archiveLabel={showArchived ? '取消归档' : '归档'}
              onDelete={() => confirmDelete(item.session)}
            />
          )
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore || (search.pending && rows.length > 0) ? (
            <Text style={{ color: colors.textFaint, fontSize: 13, textAlign: 'center', padding: 14 }}>
              {loadingMore ? '正在加载…' : '正在搜索…'}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          loaded && !refreshing ? (
            <Text style={{ color: colors.textFaint, fontSize: 14, paddingHorizontal: 16, paddingTop: 18 }}>
              {searching
                ? search.pending
                  ? '正在搜索…'
                  : '没有匹配结果'
                : showArchived
                  ? '暂无归档会话'
                  : '暂无会话'}
            </Text>
          ) : null
        }
      />

      {/* Floating New chat pill */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: insets.bottom + 18,
          alignItems: 'center',
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建会话"
          onPress={newChat}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            paddingHorizontal: 22,
            height: 48,
            borderRadius: 24,
            backgroundColor: colors.inverseSurface,
            opacity: pressed ? 0.85 : 1,
            boxShadow: dark ? '0 6px 22px rgba(0, 0, 0, 0.5)' : '0 6px 22px rgba(24, 24, 23, 0.3)',
          })}
        >
          <Icon sf="plus" size={16} color={colors.onInverse} />
          <Text style={{ color: colors.onInverse, fontSize: 16, fontWeight: '600' }}>新建会话</Text>
        </Pressable>
      </View>

      {/* Android rename dialog — mounted fresh per target so the input
          re-seeds from the session title. Dead-code-eliminated on iOS. */}
      {!isIOS && renameTarget ? (
        <PromptDialog
          visible
          title="重命名会话"
          initialValue={renameTarget.title ?? ''}
          onSubmit={(value) => {
            const target = renameTarget;
            setRenameTarget(null);
            void applyRename(target, value);
          }}
          onCancel={() => setRenameTarget(null)}
        />
      ) : null}
    </View>
  );
}
