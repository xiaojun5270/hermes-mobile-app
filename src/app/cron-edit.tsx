// src/app/cron-edit.tsx — create / edit a cron job (docs/contracts/cron.md).
// No params → create (POST). ?id=&profile= → edit (PUT updates / DELETE).
// Schedules are natural-language strings parsed by the gateway; 400 details
// from the parser are surfaced inline.
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { scheduleLabel, scheduleWire } from '@/lib/zh-cn';
import {
  createCronJob,
  deleteCronJob,
  getCronJob,
  listDeliveryTargets,
  pauseCronJob,
  resumeCronJob,
  updateCronJob,
  type CronJob,
  type DeliveryTarget,
} from '@/api/cron';
import { AuthError, HttpError } from '@/api/restClient';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import {
  SCHEDULE_PRESETS,
  buildCronUpdates,
  initialScheduleText,
  schedulePreview,
  validateCronForm,
  type CronFormErrors,
} from '@/lib/cron-form';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

const FALLBACK_TARGETS: DeliveryTarget[] = [{ id: 'local', name: '本地（仅保存）' }];

function FieldLabel({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <Text
      style={{
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        marginLeft: 4,
      }}
    >
      {children}
    </Text>
  );
}

function FieldError({ message }: { message: string }) {
  const { colors } = useTheme();
  return (
    <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13, marginLeft: 4 }}>
      {message}
    </Text>
  );
}

function FormInput({
  value,
  onChangeText,
  placeholder,
  label,
  multiline,
  invalid,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  label: string;
  multiline?: boolean;
  invalid?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textFaint}
      accessibilityLabel={label}
      multiline={multiline}
      autoCapitalize="none"
      autoCorrect={!!multiline}
      style={{
        backgroundColor: colors.surface,
        borderRadius: 12,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: invalid ? colors.danger : colors.border,
        color: colors.text,
        fontSize: 15.5,
        paddingHorizontal: 14,
        paddingVertical: 12,
        minHeight: multiline ? 120 : 44,
        textAlignVertical: multiline ? 'top' : 'center',
      }}
    />
  );
}

export default function CronEditScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ id?: string; profile?: string }>();
  const jobId = typeof params.id === 'string' && params.id ? params.id : null;
  const profile = typeof params.profile === 'string' && params.profile ? params.profile : undefined;
  const editing = jobId !== null;

  const [job, setJob] = useState<CronJob | null>(null);
  const [targets, setTargets] = useState<DeliveryTarget[]>(FALLBACK_TARGETS);
  const [loaded, setLoaded] = useState(!editing);

  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [savedSchedule, setSavedSchedule] = useState('');
  const [prompt, setPrompt] = useState('');
  const [deliver, setDeliver] = useState('local');
  const [enabled, setEnabled] = useState(true);

  const [fieldErrors, setFieldErrors] = useState<CronFormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleError = useCallback((e: unknown, fallback: string) => {
    if (e instanceof AuthError) {
      router.replace('/');
      return;
    }
    setError(e instanceof HttpError && e.message ? e.message : fallback);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Delivery targets are cosmetic — fall back to "local" if they fail.
      try {
        const { targets: t } = await withAuthRetry((r) => listDeliveryTargets(r));
        if (!cancelled && t.length) setTargets(t);
      } catch {
        // keep FALLBACK_TARGETS
      }
      if (!jobId) return;
      try {
        const j = await withAuthRetry((r) => getCronJob(r, jobId, profile));
        if (cancelled) return;
        setJob(j);
        setName(j.name ?? '');
        const saved = initialScheduleText(j);
        setSchedule(saved);
        setSavedSchedule(saved);
        setPrompt(j.prompt ?? '');
        setDeliver(j.deliver || 'local');
        setEnabled(j.enabled);
        setLoaded(true);
      } catch (e) {
        if (cancelled) return;
        setLoaded(true);
        handleError(e, '无法连接网关，任务加载失败，请返回后重试。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, profile, handleError]);

  const save = useCallback(async () => {
    const errors = validateCronForm({ schedule, prompt });
    setFieldErrors(errors);
    setError(null);
    if (errors.schedule || errors.prompt) return;
    setBusy(true);
    try {
      if (!editing) {
        const created = await withAuthRetry((r) =>
          createCronJob(r, { prompt: prompt.trim(), schedule: scheduleWire(schedule), name: name.trim(), deliver }),
        );
        if (!enabled) await withAuthRetry((r) => pauseCronJob(r, created.id, created.profile));
      } else if (job) {
        const updates = buildCronUpdates(job, savedSchedule, { name, schedule, prompt, deliver });
        if (Object.keys(updates).length) {
          await withAuthRetry((r) => updateCronJob(r, job.id, job.profile, updates));
        }
        if (enabled !== job.enabled) {
          await withAuthRetry((r) =>
            enabled ? resumeCronJob(r, job.id, job.profile) : pauseCronJob(r, job.id, job.profile),
          );
        }
      }
      router.back();
    } catch (e) {
      // Schedule-parse rejections arrive as 400s with a server `detail`.
      handleError(e, '无法连接网关，保存失败，请检查 VPN 或 Wi-Fi 后重试。');
    } finally {
      setBusy(false);
    }
  }, [editing, job, name, schedule, savedSchedule, prompt, deliver, enabled, handleError]);

  const confirmDelete = useCallback(() => {
    if (!job) return;
    Alert.alert(
      `删除“${job.name || job.id}”?`,
      '将从网关删除任务及其计划，保留历史运行会话。此操作无法撤销。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await withAuthRetry((r) => deleteCronJob(r, job.id, job.profile));
              router.back();
            } catch (e) {
              handleError(e, '无法连接网关，删除失败。');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [job, handleError]);

  const canSave = loaded && !busy && (!editing || job !== null);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 10, paddingBottom: 48 }}
    >
      <Stack.Screen
        options={{
          title: editing ? '编辑任务' : '新建任务',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={editing ? '保存修改' : '创建任务'}
              accessibilityState={{ disabled: !canSave }}
              disabled={!canSave}
              onPress={save}
              hitSlop={4}
              style={({ pressed }) => ({
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 8,
                opacity: !canSave ? 0.4 : pressed ? 0.5 : 1,
              })}
            >
              <Text style={{ color: colors.accent, fontSize: 17, fontWeight: '600' }}>
                {busy ? '正在保存…' : '保存'}
              </Text>
            </Pressable>
          ),
        }}
      />

      {error ? (
        <Text selectable accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14 }}>
          {error}
        </Text>
      ) : null}

      {!loaded ? (
        <Text style={{ color: colors.textFaint, fontSize: 14, textAlign: 'center', paddingTop: 48 }}>正在加载…</Text>
      ) : (
        <>
          <FieldLabel>名称</FieldLabel>
          <FormInput value={name} onChangeText={setName} placeholder="早间摘要（可选）" label="任务名称" />

          <View style={{ height: 8 }} />
          <FieldLabel>运行计划</FieldLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {SCHEDULE_PRESETS.map((preset) => {
              const active = schedule.trim() === preset;
              return (
                <Pressable
                  key={preset}
                  accessibilityRole="button"
                  accessibilityLabel={`使用计划 ${scheduleLabel(preset)}`}
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    setSchedule(preset);
                    setFieldErrors((prev) => ({ ...prev, schedule: undefined }));
                  }}
                  hitSlop={6}
                  style={({ pressed }) => ({
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                    minHeight: 32,
                    borderRadius: 16,
                    borderCurve: 'continuous',
                    borderWidth: 1,
                    borderColor: active ? colors.accent : colors.border,
                    backgroundColor: active ? colors.raised : colors.surface,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text style={{ color: active ? colors.accent : colors.textDim, fontSize: 13.5 }}>{scheduleLabel(preset)}</Text>
                </Pressable>
              );
            })}
          </View>
          <FormInput
            value={scheduleLabel(schedule)}
            onChangeText={(t) => {
              setSchedule(t);
              if (fieldErrors.schedule) setFieldErrors((prev) => ({ ...prev, schedule: undefined }));
            }}
            placeholder="运行计划，例如 0 9 * * *"
            label="运行计划"
            invalid={!!fieldErrors.schedule}
          />
          {fieldErrors.schedule ? (
            <FieldError message={fieldErrors.schedule} />
          ) : (
            <Text style={{ color: colors.textFaint, fontSize: 12.5, marginLeft: 4 }}>
              {schedulePreview(schedule, savedSchedule)}
            </Text>
          )}

          <View style={{ height: 8 }} />
          <FieldLabel>任务内容</FieldLabel>
          <FormInput
            value={prompt}
            onChangeText={(t) => {
              setPrompt(t);
              if (fieldErrors.prompt) setFieldErrors((prev) => ({ ...prev, prompt: undefined }));
            }}
            placeholder="每次运行需要智能体做什么？"
            label="任务内容"
            multiline
            invalid={!!fieldErrors.prompt}
          />
          {fieldErrors.prompt ? <FieldError message={fieldErrors.prompt} /> : null}

          <View style={{ height: 8 }} />
          <FieldLabel>结果发送方式</FieldLabel>
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
            {targets.map((t, i) => {
              const selected = deliver === t.id;
              const unconfigured = t.home_target_set === false;
              return (
                <View key={t.id}>
                  {i > 0 ? <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 16 }} /> : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`通过以下方式发送：${t.name}`}
                    accessibilityState={{ selected }}
                    onPress={() => setDeliver(t.id)}
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
                      <Text style={{ color: colors.text, fontSize: 15.5, fontWeight: selected ? '600' : '400' }}>
                        {t.name}
                      </Text>
                      {unconfigured ? (
                        <Text style={{ color: colors.textFaint, fontSize: 13 }}>
                          {t.home_env_var ? `请在网关配置 ${t.home_env_var} 后再使用。` : '网关尚未配置。'}
                        </Text>
                      ) : null}
                    </View>
                    {selected ? (
                      <Icon sf="checkmark" size={17} color={colors.accent} />
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </View>

          <View style={{ height: 8 }} />
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: 16,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: colors.border,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 16,
              minHeight: 44,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 15.5 }}>已启用</Text>
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              accessibilityLabel={enabled ? '任务已启用，双击暂停' : '任务已暂停，双击启用'}
              trackColor={{ true: colors.accent }}
              hitSlop={8}
            />
          </View>

          {editing && job ? (
            <>
              <View style={{ height: 16 }} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`删除 ${job.name || '任务'}`}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={confirmDelete}
                style={({ pressed }) => ({
                  backgroundColor: colors.surface,
                  borderRadius: 16,
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderColor: colors.border,
                  padding: 16,
                  minHeight: 44,
                  alignItems: 'center',
                  opacity: busy ? 0.5 : pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: colors.danger, fontSize: 15.5, fontWeight: '500' }}>删除任务…</Text>
              </Pressable>
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
