// src/app/skills.tsx
//
// Skills browser. Per docs/contracts/skills.md the gateway exposes list +
// enable/disable toggle over REST; pin/unpin is CLI-only and the list payload
// carries no source/pinned fields, so the badges here are category + state.
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Switch, Text, View } from 'react-native';
import { filterSkills, listSkills, sortSkills, summaryLine, toggleSkill, type SkillInfo } from '@/api/skills';
import { AuthError } from '@/api/restClient';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

function CategoryBadge({ category }: { category: string }) {
  const { colors } = useTheme();
  if (!category) return null;
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
      <Text style={{ color: colors.textDim, fontSize: 11.5, fontWeight: '600' }}>{category}</Text>
    </View>
  );
}

function SkillRow({
  skill,
  onPress,
  onToggle,
}: {
  skill: SkillInfo;
  onPress: (skill: SkillInfo) => void;
  onToggle: (skill: SkillInfo) => void;
}) {
  const { colors } = useTheme();
  const line = summaryLine(skill.description);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${skill.name} 技能${skill.category ? `, ${skill.category}` : ''}${skill.enabled ? '' : '，已停用'}`}
      accessibilityHint="查看技能详情"
      onPress={() => onPress(skill)}
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
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{
              color: skill.enabled ? colors.text : colors.textDim,
              fontSize: 16,
              fontWeight: '600',
              flexShrink: 1,
            }}
          >
            {skill.name}
          </Text>
          <CategoryBadge category={skill.category} />
        </View>
        {line ? (
          <Text numberOfLines={1} style={{ color: colors.textFaint, fontSize: 13.5 }}>
            {line}
          </Text>
        ) : null}
      </View>
      <Switch
        value={skill.enabled}
        onValueChange={() => onToggle(skill)}
        accessibilityLabel={`${skill.name} ${skill.enabled ? '已启用，双击停用' : '已停用，双击启用'}`}
        trackColor={{ true: colors.accent }}
        hitSlop={8}
      />
    </Pressable>
  );
}

export default function SkillsScreen() {
  const { colors } = useTheme();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback((e: unknown, message: string) => {
    if (e instanceof AuthError) {
      // Silent re-login already failed inside withAuthRetry — credentials are dead.
      router.replace('/');
      return;
    }
    setError(message);
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setSkills(sortSkills(await withAuthRetry((r) => listSkills(r))));
    } catch (e) {
      handleError(e, '无法连接网关，请检查 VPN 或 Wi-Fi 后下拉重试。');
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  }, [handleError]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const replaceSkill = useCallback((name: string, next: SkillInfo) => {
    setSkills((prev) => prev.map((s) => (s.name === name ? next : s)));
  }, []);

  /** Optimistic enable/disable — flip immediately, revert if the server says no. */
  const toggle = useCallback(
    async (skill: SkillInfo) => {
      const enabling = !skill.enabled;
      setError(null);
      replaceSkill(skill.name, { ...skill, enabled: enabling });
      try {
        const res = await withAuthRetry((r) => toggleSkill(r, skill.name, enabling));
        replaceSkill(skill.name, { ...skill, enabled: res.enabled });
      } catch (e) {
        replaceSkill(skill.name, skill); // revert
        handleError(e, `无法${enabling ? '启用' : '停用'}“${skill.name}”，无法连接网关。`);
      }
    },
    [replaceSkill, handleError],
  );

  const openDetail = useCallback((skill: SkillInfo) => {
    router.push({ pathname: '/skills/[name]', params: { name: skill.name } });
  }, []);

  const rows = useMemo(() => filterSkills(skills, query), [skills, query]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: '技能',
          headerSearchBarOptions: {
            placeholder: '搜索技能',
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
        data={rows}
        keyExtractor={(s) => s.name}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 10 }}
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.textDim} />}
        renderItem={({ item }) => <SkillRow skill={item} onPress={openDetail} onToggle={toggle} />}
        ListEmptyComponent={
          loaded && !refreshing && !error ? (
            <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
              <Icon sf="sparkles" size={44} color={colors.textFaint} />
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>
                {query ? '没有匹配结果' : '尚未安装技能'}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>
                {query
                  ? '没有名称、描述或分类匹配的技能。'
                  : '在网关运行 “hermes skills install” 安装技能后，即可在这里查看。'}
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}
