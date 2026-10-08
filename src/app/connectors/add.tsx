// src/app/connectors/add.tsx
//
// Add a connector (spec §5.4): the gateway's curated catalog, plus a "Custom server" row
// for adding one by URL. Only remote entries that need no local install are listed; stdio
// servers are not added from the app. An entry that is already configured opens its
// connector instead.
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { listMcpCatalog, type McpCatalogEntry } from '@/api/mcp';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import { catalogAuthLabel, connectorError, filterCatalog, remoteCatalogEntries } from '@/lib/mcp';
import { getProfileState, subscribeProfiles } from '@/profile-store';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

function Badge({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.raised,
        borderRadius: 6,
        borderCurve: 'continuous',
        paddingHorizontal: 6,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color: colors.textDim, fontSize: 11.5, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

function CatalogRow({ entry, onPress }: { entry: McpCatalogEntry; onPress: (entry: McpCatalogEntry) => void }) {
  const { colors } = useTheme();
  const auth = catalogAuthLabel(entry);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${auth}${entry.installed ? '，已添加' : ''}`}
      accessibilityHint={entry.installed ? '打开连接器' : '查看将添加的内容'}
      onPress={() => onPress(entry)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.raised : colors.surface,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.border,
        padding: 14,
        minHeight: 44,
        gap: 4,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 16, fontWeight: '600', flexShrink: 1 }}>
          {entry.name}
        </Text>
        {entry.installed ? <Badge label="已添加" /> : null}
      </View>
      {entry.description ? (
        <Text numberOfLines={2} style={{ color: colors.textDim, fontSize: 13.5 }}>
          {entry.description}
        </Text>
      ) : null}
      <Text style={{ color: colors.textFaint, fontSize: 12.5 }}>{auth}</Text>
    </Pressable>
  );
}

function CustomRow() {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="自定义服务器，通过地址添加"
      onPress={() => router.push('/connectors/custom')}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? colors.raised : colors.surface,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.border,
        padding: 14,
        minHeight: 44,
      })}
    >
      <Icon sf="plus" size={18} color={colors.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>自定义服务器</Text>
        <Text style={{ color: colors.textDim, fontSize: 13.5 }}>通过地址添加</Text>
      </View>
    </Pressable>
  );
}

export default function AddConnectorScreen() {
  const { colors } = useTheme();
  const profiles = useSyncExternalStore(subscribeProfiles, getProfileState);
  const profile = profiles.selected;
  const [entries, setEntries] = useState<McpCatalogEntry[]>([]);
  const [query, setQuery] = useState('');
  // true until the first fetch settles: the RefreshControl spins on first load.
  const [refreshing, setRefreshing] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const readGen = useRef(0); // only the newest read may write state
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchCatalog = useCallback(async () => {
    const gen = ++readGen.current;
    try {
      const catalog = await withAuthRetry((r) => listMcpCatalog(r, profile));
      if (gen !== readGen.current) return;
      setEntries(remoteCatalogEntries(catalog.entries ?? []));
      setUnsupported(null);
    } catch (e) {
      if (gen !== readGen.current || !mounted.current) return;
      const mapped = connectorError(e, 'catalog');
      if (mapped.kind === 'auth') router.replace('/');
      else if (mapped.kind === 'unsupported') setUnsupported(mapped.message);
      else setError(mapped.message);
    } finally {
      if (gen === readGen.current) {
        setRefreshing(false);
        setLoaded(true);
      }
    }
  }, [profile]);

  /** Pull to refresh. */
  const load = useCallback(() => {
    setRefreshing(true);
    setError(null);
    return fetchCatalog();
  }, [fetchCatalog]);

  // Re-read on focus without the spinner (see the Connectors list): "Added" is then right
  // after returning from an install made elsewhere.
  useFocusEffect(
    useCallback(() => {
      setError(null);
      void fetchCatalog();
    }, [fetchCatalog]),
  );

  const open = useCallback((entry: McpCatalogEntry) => {
    if (entry.installed) router.push({ pathname: '/connectors/server/[name]', params: { name: entry.name } });
    else router.push({ pathname: '/connectors/catalog/[name]', params: { name: entry.name } });
  }, []);

  const rows = filterCatalog(entries, query);
  const empty = (title: string, text: string) => (
    <View style={{ alignItems: 'center', gap: 10, paddingTop: 48, paddingHorizontal: 32 }}>
      <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
      <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>{text}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: '添加连接器',
          headerSearchBarOptions: {
            placeholder: '搜索目录',
            onChangeText: (e) => setQuery(e.nativeEvent.text),
            hideWhenScrolling: true,
          },
        }}
      />

      {error ? (
        <Text selectable style={{ color: colors.danger, fontSize: 14, paddingHorizontal: 16, paddingTop: 8 }}>
          {error}
        </Text>
      ) : null}

      <FlatList
        testID="connectors-catalog"
        data={unsupported ? [] : rows}
        keyExtractor={(e) => e.name}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 10 }}
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.textDim} />}
        renderItem={({ item }) => <CatalogRow entry={item} onPress={open} />}
        // A server of his own can be added even when the catalog is empty or did not load.
        ListHeaderComponent={unsupported ? null : <CustomRow />}
        ListEmptyComponent={
          unsupported
            ? empty('连接器不可用', unsupported)
            : loaded && !refreshing && !error
              ? query
                ? empty('没有匹配结果', '目录中没有匹配的连接器。')
                : empty('目录中暂无连接器', '网关目录为空，仍可通过地址添加服务器。')
              : null
        }
      />
    </View>
  );
}
