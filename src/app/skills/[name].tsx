// src/app/skills/[name].tsx
//
// Skill detail. The gateway has no endpoint to read an installed skill's
// SKILL.md body (docs/contracts/skills.md — installed-content read NOT FOUND;
// /api/files/read is locked down for remote clients), so this renders the
// skill's frontmatter metadata — description (markdown), category, state —
// and offers the supported enable/disable toggle.
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { listSkills, toggleSkill, type SkillInfo } from '@/api/skills';
import { AuthError } from '@/api/restClient';
import { Icon } from '@/components/icon';
import { MarkdownView } from '@/components/markdown-view';
import { withAuthRetry } from '@/connection';
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

function MetaRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: 16, minHeight: 44 }}
    >
      <Text style={{ color: colors.text, fontSize: 15.5 }}>{label}</Text>
      <Text style={{ color: colors.textDim, fontSize: 15 }}>{value}</Text>
    </View>
  );
}

export default function SkillDetailScreen() {
  const { colors } = useTheme();
  const { name } = useLocalSearchParams<{ name: string }>();
  const [skill, setSkill] = useState<SkillInfo | null>(null);
  // true until the first fetch settles: the RefreshControl spins on first load.
  const [refreshing, setRefreshing] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback((e: unknown, message: string) => {
    if (e instanceof AuthError) {
      router.replace('/');
      return;
    }
    setError(message);
  }, []);

  // Every setter runs in a promise callback, never synchronously on the mount
  // effect's path. `refresh` (pull-to-refresh) raises the spinner and clears
  // the error itself before calling this; a successful fetch clears a stale
  // error too (e.g. after the `name` param changes).
  const fetchSkill = useCallback(
    () =>
      // No GET /api/skills/{name} exists — fetch the list and pick our row.
      withAuthRetry((r) => listSkills(r))
        .then((skills) => {
          setSkill(skills.find((s) => s.name === name) ?? null);
          setError(null);
        })
        .catch((e: unknown) => {
          handleError(e, '无法连接网关，请检查 VPN 或 Wi-Fi 后下拉重试。');
        })
        .finally(() => {
          setRefreshing(false);
          setLoaded(true);
        }),
    [name, handleError],
  );

  useEffect(() => {
    void fetchSkill();
  }, [fetchSkill]);

  function refresh() {
    setRefreshing(true);
    setError(null);
    void fetchSkill();
  }

  /** Optimistic enable/disable — flip immediately, revert if the server says no. */
  async function toggle(current: SkillInfo) {
    if (busy) return;
    const enabling = !current.enabled;
    setBusy(true);
    setError(null);
    setSkill({ ...current, enabled: enabling });
    try {
      const res = await withAuthRetry((r) => toggleSkill(r, current.name, enabling));
      setSkill({ ...current, enabled: res.enabled });
    } catch (e) {
      setSkill(current); // revert
      handleError(e, `无法${enabling ? '启用' : '停用'}“${current.name}”，无法连接网关。`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textDim} />}
    >
      <Stack.Screen options={{ title: typeof name === 'string' ? name : '技能' }} />

      {error ? (
        <Text selectable style={{ color: colors.danger, fontSize: 14 }}>
          {error}
        </Text>
      ) : null}

      {!loaded ? (
        <Text style={{ color: colors.textFaint, fontSize: 14, textAlign: 'center', paddingTop: 48 }}>正在加载…</Text>
      ) : skill ? (
        <>
          <Card>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: 16, minHeight: 44 }}
            >
              <Text style={{ color: colors.text, fontSize: 15.5 }}>已启用</Text>
              <Switch
                value={skill.enabled}
                disabled={busy}
                onValueChange={() => toggle(skill)}
                accessibilityLabel={`${skill.name} ${skill.enabled ? '已启用，双击停用' : '已停用，双击启用'}`}
                trackColor={{ true: colors.accent }}
                hitSlop={8}
              />
            </View>
            {skill.category ? (
              <>
                <Separator />
                <MetaRow label="分类" value={skill.category} />
              </>
            ) : null}
          </Card>

          {skill.description ? (
            <View
              style={{
                backgroundColor: colors.surface,
                borderRadius: 16,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: colors.border,
                padding: 16,
              }}
            >
              <MarkdownView text={skill.description} />
            </View>
          ) : null}

          <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4 }}>

            网关 API 仅提供技能元数据。如需阅读完整 SKILL.md，请在会话中询问智能体，或在网关上打开文件。
          </Text>
        </>
      ) : !error ? (
        <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
          <Icon sf="questionmark.circle" size={44} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>未找到技能</Text>
          <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>
            “{name}”已从网关卸载，请下拉刷新。
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
