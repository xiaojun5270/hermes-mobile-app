// src/app/models.tsx
//
// Model switcher. Per docs/contracts/models.md: GET /api/model/info (current),
// GET /api/model/options (grouped picker w/ pricing + capability hints),
// POST /api/model/set scope=main. The set endpoint writes the backend
// process's own profile (the default profile) and applies to NEW sessions
// only — running chats keep their model.
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import {
  capabilityBadges,
  formatContext,
  getModelInfo,
  getModelOptions,
  hintBadges,
  isModelUnavailable,
  modelDisplayName,
  pricingLine,
  setMainModel,
  type ModelInfo,
  type ModelOptionsResponse,
  type ProviderRow,
} from '@/api/models';
import { AuthError } from '@/api/restClient';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import { useTheme } from '@/theme';
import {
  getSessionModelTarget,
  subscribeSessionModelTarget,
  type SessionModelTarget,
} from '@/session-model-store';

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

function SectionTitle({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <Text style={{ color: colors.textDim, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginLeft: 4 }}>
      {children}
    </Text>
  );
}

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
      <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

function CurrentModelCard({ info, current }: { info: ModelInfo | null; current: Selection | null }) {
  const { colors } = useTheme();
  const model = current?.model ?? info?.model ?? '';
  const provider = current?.provider ?? info?.provider ?? '';
  const badges = capabilityBadges(info?.capabilities);
  const context = formatContext(info?.effective_context_length ?? 0);
  const detail = [provider || null, context].filter(Boolean).join(' · ');
  return (
    <Card>
      <View
        accessibilityLabel={`当前模型 ${modelDisplayName(model)}${detail ? `, ${detail}` : ''}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, minHeight: 44 }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            borderCurve: 'continuous',
            backgroundColor: colors.raised,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon sf="cpu" size={20} color={colors.accent} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={1} style={{ color: colors.text, fontSize: 16.5, fontWeight: '600' }}>
            {modelDisplayName(model)}
          </Text>
          {detail ? (
            <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 13 }}>
              {detail}
            </Text>
          ) : null}
          {badges.length > 0 ? (
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 3 }}>
              {badges.map((b) => (
                <Badge key={b} label={b} />
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

function ModelRow({
  modelId,
  selected,
  disabled,
  unavailable,
  pricing,
  badges,
  onPress,
}: {
  modelId: string;
  selected: boolean;
  disabled: boolean;
  unavailable: boolean;
  pricing: string | null;
  badges: string[];
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const name = modelDisplayName(modelId);
  const hintParts = [unavailable ? '当前套餐不可用' : null, pricing, ...badges].filter(Boolean) as string[];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`切换到 ${name}${hintParts.length ? `, ${hintParts.join(', ')}` : ''}`}
      accessibilityState={{ selected, disabled: disabled || unavailable }}
      disabled={disabled || unavailable}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 16,
        minHeight: 44,
        backgroundColor: pressed ? colors.raised : 'transparent',
        opacity: unavailable ? 0.4 : disabled && !selected ? 0.6 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 15.5, fontWeight: selected ? '600' : '400' }}>
          {name}
        </Text>
        {name !== modelId ? (
          <Text numberOfLines={1} style={{ color: colors.textFaint, fontSize: 12.5 }}>
            {modelId}
          </Text>
        ) : null}
        {hintParts.length > 0 ? (
          <Text numberOfLines={1} style={{ color: unavailable ? colors.textFaint : colors.textDim, fontSize: 12.5 }}>
            {hintParts.join('  ·  ')}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <Icon sf="checkmark" size={17} color={colors.accent} />
      ) : null}
    </Pressable>
  );
}

function UnconfiguredRow({ row }: { row: ProviderRow }) {
  const { colors } = useTheme();
  const hint = row.warning || (row.key_env ? `请在网关配置 ${row.key_env}以启用此功能。` : '网关尚未配置。');
  return (
    <View
      accessibilityLabel={`${row.name}，尚未配置。 ${hint}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, minHeight: 44 }}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: colors.textDim, fontSize: 15.5 }}>{row.name}</Text>
        <Text numberOfLines={2} style={{ color: colors.textFaint, fontSize: 12.5 }}>
          {hint}
        </Text>
      </View>
      <Icon sf="key" size={15} color={colors.textFaint} />
    </View>
  );
}

interface Selection {
  provider: string;
  model: string;
}

export default function ModelsScreen() {
  const { colors } = useTheme();
  const { scope } = useLocalSearchParams<{ scope?: string }>();
  const target = useSyncExternalStore(subscribeSessionModelTarget, getSessionModelTarget);
  // Session mode only when opened from a chat that actually has a live session.
  const sessionMode = scope === 'session' && !!target && target.sessionId.length > 0;
  const sessionModelId = sessionMode ? target!.modelId : null;
  const sessionStreaming = sessionMode && !!target!.streaming;
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [options, setOptions] = useState<ModelOptionsResponse | null>(null);
  const [current, setCurrent] = useState<Selection | null>(null);
  // true until the first fetch settles: the RefreshControl spins on first load.
  const [refreshing, setRefreshing] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleError = useCallback((e: unknown, fallback: string) => {
    if (e instanceof AuthError) {
      router.replace('/');
      return;
    }
    setError(e instanceof Error && e.message ? e.message : fallback);
  }, []);

  // Every setter runs in a promise callback, never synchronously on the mount
  // effect's path. `refresh` (pull-to-refresh) raises the spinner and clears
  // the error itself before calling this.
  const fetchModels = useCallback(
    () =>
      Promise.all([
        withAuthRetry((r) => getModelInfo(r)),
        withAuthRetry((r) => getModelOptions(r)),
      ])
        .then(([i, o]) => {
          setInfo(i);
          setOptions(o);
          setCurrent({ provider: o.provider || i.provider, model: o.model || i.model });
        })
        .catch((e: unknown) => {
          handleError(e, '无法连接网关，请检查 VPN 或 Wi-Fi 后下拉重试。');
        })
        .finally(() => {
          setRefreshing(false);
          setLoaded(true);
        }),
    [handleError],
  );

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  function refresh() {
    setRefreshing(true);
    setError(null);
    void fetchModels();
  }

  async function applySwitch(provider: string, model: string, confirmExpensive: boolean, previous: Selection | null) {
    try {
      const res = await withAuthRetry((r) => setMainModel(r, provider, model, confirmExpensive));
      if (!res.ok && res.confirm_required) {
        Alert.alert('高费用模型', res.confirm_message || '此模型费用可能较高，是否继续？', [
          { text: '取消', style: 'cancel', onPress: () => setCurrent(previous) },
          { text: '仍然切换', style: 'destructive', onPress: () => applySwitch(provider, model, true, previous) },
        ]);
        return;
      }
      if (!res.ok) {
        setCurrent(previous);
        setError('网关未接受模型切换。');
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (res.stale_aux && res.stale_aux.length > 0) {
        setNotice(
          `已切换。${res.stale_aux.length} 个辅助任务配置仍使用其他提供商，可在桌面端管理。`,
        );
      } else {
        setNotice(null);
      }
      // Refresh the info card (context length / capabilities) in the background.
      withAuthRetry((r) => getModelInfo(r))
        .then(setInfo)
        .catch(() => {});
    } catch (e) {
      setCurrent(previous);
      handleError(e, `无法切换到${modelDisplayName(model)}。`);
    } finally {
      setBusy(false);
    }
  }

  function requestSwitch(provider: ProviderRow, modelId: string) {
    if (busy || !current) return;
    if (current.provider === provider.slug && current.model === modelId) return;
    Alert.alert(
      '切换模型？',
      `新会话将通过 ${provider.name} 使用 ${modelDisplayName(modelId)}。正在进行的会话保持当前模型。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '切换',
          onPress: () => {
            const previous = current;
            setBusy(true);
            setError(null);
            setNotice(null);
            setCurrent({ provider: provider.slug, model: modelId }); // optimistic
            applySwitch(provider.slug, modelId, false, previous);
          },
        },
      ],
    );
  }

  function requestSessionSwitch(provider: ProviderRow, modelId: string) {
    const t = target;
    if (busy || !t) return;
    if (t.streaming) {
      Alert.alert('Hermes 正在回复', '请先停止当前任务，再切换此会话的模型。');
      return;
    }
    // Compare on the display name: session.info.model and /api/model/options
    // ids may differ in provider-namespacing, but their trailing segment matches.
    if (t.modelId && modelDisplayName(modelId) === modelDisplayName(t.modelId)) return;
    Alert.alert(
      '切换此会话的模型？',
      `此会话将通过 ${provider.name} 使用 ${modelDisplayName(modelId)}。其他会话和新会话不受影响。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '切换', onPress: () => void applySessionSwitch(t, provider.slug, modelId, false) },
      ],
    );
  }

  async function applySessionSwitch(
    t: SessionModelTarget,
    provider: string,
    model: string,
    confirmExpensive: boolean,
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const outcome = await t.switchModel(provider, model, confirmExpensive);
    setBusy(false);
    switch (outcome.kind) {
      case 'ok':
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back(); // back to the chat; the pill updates from session.info
        break;
      case 'confirm':
        Alert.alert('高费用模型', outcome.message, [
          { text: '取消', style: 'cancel' },
          {
            text: '仍然切换',
            style: 'destructive',
            onPress: () => void applySessionSwitch(t, provider, model, true),
          },
        ]);
        break;
      case 'busy':
        Alert.alert('Hermes 正在回复', '请先停止当前任务，再切换此会话的模型。');
        break;
      case 'error':
        setError(outcome.message || '网关未接受模型切换。');
        break;
    }
  }

  const configured = options?.providers.filter((p) => p.authenticated && p.models.length > 0) ?? [];
  const unconfigured = options?.providers.filter((p) => !p.authenticated) ?? [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textDim} />}
    >
      <Stack.Screen options={{ title: sessionMode ? '切换模型' : '模型' }} />

      {error ? (
        <Text selectable style={{ color: colors.danger, fontSize: 14 }}>
          {error}
        </Text>
      ) : null}
      {notice ? (
        <Text style={{ color: colors.success, fontSize: 13.5 }}>{notice}</Text>
      ) : null}

      {!loaded ? (
        <Text style={{ color: colors.textFaint, fontSize: 14, textAlign: 'center', paddingTop: 48 }}>正在加载…</Text>
      ) : options || info ? (
        <>
          <SectionTitle>{sessionMode ? '此会话' : '当前'}</SectionTitle>
          <CurrentModelCard
            info={sessionMode ? null : info}
            current={sessionMode ? { provider: '', model: sessionModelId ?? '' } : current}
          />
          <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4 }}>
            {sessionMode
              ? '仅切换此会话。新会话使用默认模型，可在设置中修改。'
              : '修改仅用于网关默认配置档案的新会话，正在进行的会话保持当前模型。'}
          </Text>
          {sessionStreaming ? (
            <Text style={{ color: colors.textDim, fontSize: 12.5, marginHorizontal: 4 }}>

              Hermes 正在回复，请先停止当前任务再切换模型。
            </Text>
          ) : null}

          {configured.map((p) => (
            <View key={p.slug} style={{ gap: 12 }}>
              <View style={{ height: 8 }} />
              <SectionTitle>{p.free_tier ? `${p.name} （免费额度）` : p.name}</SectionTitle>
              <Card>
                {p.models.map((m, idx) => (
                  <View key={m}>
                    {idx > 0 ? <Separator /> : null}
                    <ModelRow
                      modelId={m}
                      selected={
                        sessionMode
                          ? !!sessionModelId && modelDisplayName(m) === modelDisplayName(sessionModelId)
                          : current?.provider === p.slug && current?.model === m
                      }
                      disabled={busy || sessionStreaming}
                      unavailable={isModelUnavailable(p, m)}
                      pricing={pricingLine(p.pricing?.[m])}
                      badges={hintBadges(p.capabilities?.[m])}
                      onPress={() => (sessionMode ? requestSessionSwitch(p, m) : requestSwitch(p, m))}
                    />
                  </View>
                ))}
              </Card>
              {p.total_models > p.models.length ? (
                <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4 }}>
                  精选 {p.models.length} 个，共 {p.total_models} 个模型。
                </Text>
              ) : null}
            </View>
          ))}

          {unconfigured.length > 0 ? (
            <>
              <View style={{ height: 8 }} />
              <SectionTitle>未配置</SectionTitle>
              <Card>
                {unconfigured.map((p, idx) => (
                  <View key={p.slug}>
                    {idx > 0 ? <Separator /> : null}
                    <UnconfiguredRow row={p} />
                  </View>
                ))}
              </Card>
            </>
          ) : null}
        </>
      ) : !error ? (
        <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
          <Icon sf="cpu" size={44} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>模型不可用</Text>
          <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>

            网关未返回模型选项，请下拉重试。
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
