// src/app/memory.tsx
//
// Memory admin screen. The dashboard core exposes status / provider
// selection / reset; whole-file viewing+editing of MEMORY.md and USER.md
// rides on the hermes-mobile plugin's /api/plugins/mobile/memory routes.
// When those routes 404 (plugin missing or too old) the file list degrades
// to read-only sizes with an update hint.
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import {
  BUILT_IN_PROVIDER,
  formatBytes,
  getMemoryStatus,
  isMemoryFileName,
  isMemoryPluginMissing,
  listMemoryFiles,
  memoryFileLabel,
  providerLabel,
  resetMemory,
  setMemoryProvider,
  type MemoryFileInfo,
  type MemoryResetTarget,
  type MemoryStatus,
} from '@/api/memory';
import { timeAgo } from '@/lib/format';
import { AuthError } from '@/api/restClient';
import { Icon } from '@/components/icon';
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

function SectionTitle({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <Text style={{ color: colors.textDim, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginLeft: 4 }}>
      {children}
    </Text>
  );
}

function ProviderRow({
  label,
  description,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  description?: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`使用${label}存储记忆`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 16,
        minHeight: 44,
        backgroundColor: pressed ? colors.raised : 'transparent',
        opacity: disabled && !selected ? 0.5 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: colors.text, fontSize: 15.5, fontWeight: selected ? '600' : '400' }}>{label}</Text>
        {description ? (
          <Text numberOfLines={2} style={{ color: colors.textFaint, fontSize: 13 }}>
            {description}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <Icon sf="checkmark" size={17} color={colors.accent} />
      ) : null}
    </Pressable>
  );
}

function EditableFileRow({ file }: { file: MemoryFileInfo }) {
  const { colors } = useTheme();
  const label = isMemoryFileName(file.name) ? memoryFileLabel(file.name) : file.name;
  const detail = file.exists ? `${formatBytes(file.size)} · ${timeAgo(file.mtime)}` : '暂无内容';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}，${detail}，打开文件查看或编辑`}
      onPress={() => router.push({ pathname: '/memory-file', params: { name: file.name } })}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 16,
        minHeight: 44,
        backgroundColor: pressed ? colors.raised : 'transparent',
      })}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: colors.text, fontSize: 15.5 }}>{label}</Text>
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>{file.name}</Text>
      </View>
      <Text style={{ color: file.exists ? colors.textDim : colors.textFaint, fontSize: 14 }}>{detail}</Text>
      <Icon sf="chevron.right" size={12} color={colors.textFaint} />
    </Pressable>
  );
}

function FileRow({ label, file, size }: { label: string; file: string; size: number }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel={`${label}, ${formatBytes(size)}`}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: 16, minHeight: 44 }}
    >
      <View style={{ gap: 3, flexShrink: 1 }}>
        <Text style={{ color: colors.text, fontSize: 15.5 }}>{label}</Text>
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>{file}</Text>
      </View>
      <Text style={{ color: size > 0 ? colors.textDim : colors.textFaint, fontSize: 15 }}>{formatBytes(size)}</Text>
    </View>
  );
}

function DangerRow({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        padding: 16,
        minHeight: 44,
        justifyContent: 'center',
        backgroundColor: pressed ? colors.raised : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text style={{ color: colors.danger, fontSize: 15.5, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

const RESET_LABELS: Record<MemoryResetTarget, { action: string; detail: string }> = {
  memory: { action: '重置智能体记忆', detail: '这将永久删除网关上的 MEMORY.md。' },
  user: { action: '重置用户档案', detail: '这将永久删除网关上的 USER.md。' },
  all: { action: '重置全部记忆', detail: '这将永久删除网关上的 MEMORY.md 和 USER.md。' },
};

type FilesState =
  | { kind: 'loading' }
  | { kind: 'ok'; files: MemoryFileInfo[] }
  | { kind: 'missing' } // plugin routes 404 — plugin absent or predates the memory API
  | { kind: 'error'; message: string };

export default function MemoryScreen() {
  const { colors } = useTheme();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [filesState, setFilesState] = useState<FilesState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback((e: unknown, fallback: string) => {
    if (e instanceof AuthError) {
      router.replace('/');
      return;
    }
    setError(e instanceof Error && e.message ? e.message : fallback);
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    // Settle handlers attached immediately so a fast plugin-route failure
    // never sits as an unhandled rejection while the status call runs.
    const filesReq: Promise<FilesState | null> = withAuthRetry((r) => listMemoryFiles(r)).then(
      (res): FilesState => ({ kind: 'ok', files: res.files }),
      (e): FilesState | null => {
        if (e instanceof AuthError) return null; // status handler redirects
        if (isMemoryPluginMissing(e)) return { kind: 'missing' };
        return { kind: 'error', message: '无法加载记忆文件，请下拉重试。' };
      },
    );
    try {
      setStatus(await withAuthRetry((r) => getMemoryStatus(r)));
    } catch (e) {
      handleError(e, '无法连接网关，请检查 VPN 或 Wi-Fi 后下拉重试。');
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
    const nextFiles = await filesReq;
    if (nextFiles) setFilesState(nextFiles);
  }, [handleError]);

  // Focus, not mount: refreshes sizes/mtimes after editing a file.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function selectProvider(provider: string) {
    if (!status || busy || provider === status.active) return;
    setBusy(true);
    setError(null);
    try {
      const res = await withAuthRetry((r) => setMemoryProvider(r, provider));
      setStatus({ ...status, active: res.active });
    } catch (e) {
      handleError(e, `无法切换到${providerLabel(provider)}。`);
    } finally {
      setBusy(false);
    }
  }

  function confirmReset(target: MemoryResetTarget) {
    const { action, detail } = RESET_LABELS[target];
    Alert.alert(`${action}?`, `${detail} 此操作无法撤销。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => doReset(target) },
    ]);
  }

  async function doReset(target: MemoryResetTarget) {
    setBusy(true);
    setError(null);
    try {
      await withAuthRetry((r) => resetMemory(r, target));
      setStatus(await withAuthRetry((r) => getMemoryStatus(r)));
    } catch (e) {
      handleError(e, '重置失败，网关未接受请求。');
    } finally {
      setBusy(false);
    }
  }

  const builtinActive = status?.active === BUILT_IN_PROVIDER;
  const builtinEmpty =
    status != null && status.builtin_files.memory === 0 && status.builtin_files.user === 0;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.textDim} />}
    >
      <Stack.Screen options={{ title: '记忆' }} />

      {error ? (
        <Text selectable style={{ color: colors.danger, fontSize: 14 }}>
          {error}
        </Text>
      ) : null}

      {!loaded ? (
        <Text style={{ color: colors.textFaint, fontSize: 14, textAlign: 'center', paddingTop: 48 }}>正在加载…</Text>
      ) : status ? (
        <>
          <SectionTitle>存储方式</SectionTitle>
          <Card>
            <ProviderRow
              label="内置文件"
              description="网关 memories 文件夹中的 Markdown 文件。"
              selected={builtinActive}
              disabled={busy}
              onPress={() => selectProvider(BUILT_IN_PROVIDER)}
            />
            {status.providers.map((p) => (
              <View key={p.name}>
                <Separator />
                <ProviderRow
                  label={providerLabel(p.name)}
                  description={p.configured ? p.description : `${p.description} （未配置）`.trim()}
                  selected={status.active === p.name}
                  disabled={busy}
                  onPress={() => selectProvider(p.name)}
                />
              </View>
            ))}
          </Card>

          <View style={{ height: 8 }} />
          <SectionTitle>内置文件</SectionTitle>
          {filesState.kind === 'ok' ? (
            <>
              <Card>
                {filesState.files.map((f, i) => (
                  <View key={f.name}>
                    {i > 0 ? <Separator /> : null}
                    <EditableFileRow file={f} />
                  </View>
                ))}
              </Card>
              <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4 }}>
                {filesState.files.every((f) => !f.exists)
                  ? '记忆为空，智能体会在对话中填写，也可以打开文件自行编辑。'
                  : '打开文件即可查看或编辑。'}
              </Text>
            </>
          ) : (
            <>
              <Card>
                <FileRow label="智能体记忆" file="MEMORY.md" size={status.builtin_files.memory} />
                <Separator />
                <FileRow label="用户档案" file="USER.md" size={status.builtin_files.user} />
              </Card>
              {filesState.kind === 'missing' ? (
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, minHeight: 44 }}>
                    <Icon sf="arrow.down.circle" size={22} color={colors.textDim} />
                    <Text style={{ flex: 1, color: colors.textDim, fontSize: 14, lineHeight: 19 }}>

                      请更新 hermes-mobile 插件后再编辑记忆。
                    </Text>
                  </View>
                </Card>
              ) : filesState.kind === 'error' ? (
                <Text style={{ color: colors.danger, fontSize: 12.5, marginHorizontal: 4 }}>{filesState.message}</Text>
              ) : null}
              <Text style={{ color: colors.textFaint, fontSize: 12.5, marginHorizontal: 4 }}>
                {builtinEmpty
                  ? '记忆为空，智能体会在对话中填写。'
                  : '可在会话中请智能体查看或更新记忆。'}
              </Text>
            </>
          )}

          <View style={{ height: 8 }} />
          <SectionTitle>危险操作</SectionTitle>
          <Card>
            <DangerRow label="重置智能体记忆…" disabled={busy} onPress={() => confirmReset('memory')} />
            <Separator />
            <DangerRow label="重置用户档案…" disabled={busy} onPress={() => confirmReset('user')} />
            <Separator />
            <DangerRow label="重置全部记忆…" disabled={busy} onPress={() => confirmReset('all')} />
          </Card>
        </>
      ) : !error ? (
        <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
          <Icon sf="brain" size={44} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>记忆不可用</Text>
          <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>

            网关未返回记忆状态，请下拉重试。
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
