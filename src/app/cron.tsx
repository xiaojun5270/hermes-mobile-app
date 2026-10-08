import * as Haptics from 'expo-haptics';
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Switch, Text, View } from 'react-native';
import {
  getRunMessages,
  lastAssistantText,
  listCronJobs,
  listCronRuns,
  pauseCronJob,
  resumeCronJob,
  scheduleDisplay,
  triggerCronJob,
  type CronJob,
} from '@/api/cron';
import { AuthError } from '@/api/restClient';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import { isoToUnix, timeAgo, timeUntil } from '@/lib/format';
import { scheduleLabel } from '@/lib/zh-cn';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

const MONO = process.env.EXPO_OS === 'ios' ? 'Menlo' : 'monospace';

/** Job ids are unique per profile; jobs from every profile share one list. */
function jobKey(job: Pick<CronJob, 'id' | 'profile'>): string {
  return `${job.profile}:${job.id}`;
}

type OutputState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; text: string };

function JobCard({
  job,
  queued,
  expanded,
  output,
  onToggle,
  onRunNow,
  onEdit,
  onToggleOutput,
}: {
  job: CronJob;
  queued: boolean;
  expanded: boolean;
  output: OutputState | undefined;
  onToggle: (job: CronJob) => void;
  onRunNow: (job: CronJob) => void;
  onEdit: (job: CronJob) => void;
  onToggleOutput: (job: CronJob) => void;
}) {
  const { colors } = useTheme();
  const lastRun = isoToUnix(job.last_run_at);
  const nextRun = isoToUnix(job.next_run_at);
  const failed = job.last_status === 'error';

  const lastLine = lastRun !== null ? `上次运行：${timeAgo(lastRun)}` : '尚未运行';
  const nextLine = job.enabled
    ? nextRun !== null
      ? ` · 下次 ${timeUntil(nextRun)}`
      : ''
    : ' · 已暂停';

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.border,
        padding: 14,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text
            numberOfLines={1}
            style={{ color: job.enabled ? colors.text : colors.textDim, fontSize: 16, fontWeight: '600' }}
          >
            {job.name || job.id}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 13.5 }}>
            {scheduleLabel(scheduleDisplay(job))}
            {job.profile_name && !job.is_default_profile ? `  ·  ${job.profile_name}` : ''}
          </Text>
        </View>
        <Switch
          value={job.enabled}
          onValueChange={() => onToggle(job)}
          accessibilityLabel={`${job.name || '任务'} ${job.enabled ? '已启用，双击暂停' : '已暂停，双击恢复'}`}
          trackColor={{ true: colors.accent }}
          hitSlop={8}
        />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor:
              job.last_status === 'success' ? colors.success : failed ? colors.danger : colors.textFaint,
          }}
        />
        <Text numberOfLines={1} style={{ color: failed ? colors.danger : colors.textFaint, fontSize: 13 }}>
          {failed ? `失败，${lastLine}` : lastLine}
          {nextLine}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`运行 ${job.name || '任务'}，立即运行`}
          onPress={() => onRunNow(job)}
          disabled={queued}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            minHeight: 44,
            paddingRight: 12,
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Icon
            sf={queued ? 'checkmark.circle.fill' : 'play.circle.fill'}
            size={22}
            color={queued ? colors.success : colors.accent}
          />
          <Text style={{ color: queued ? colors.success : colors.accent, fontSize: 15, fontWeight: '600' }}>
            {queued ? '已排队' : '立即运行'}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`编辑 ${job.name || '任务'}`}
          onPress={() => onEdit(job)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            minHeight: 44,
            paddingHorizontal: 12,
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Icon sf="pencil" size={16} color={colors.textDim} />
          <Text style={{ color: colors.textDim, fontSize: 14 }}>编辑</Text>
        </Pressable>

        {job.last_run_at ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? '隐藏最近结果' : '查看最近结果'}
            onPress={() => onToggleOutput(job)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              minHeight: 44,
              paddingLeft: 12,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Text style={{ color: colors.textDim, fontSize: 14 }}>最近结果</Text>
            <Icon sf={expanded ? 'chevron.up' : 'chevron.down'} size={13} color={colors.textDim} />
          </Pressable>
        ) : null}
      </View>

      {expanded ? (
        <View
          style={{
            backgroundColor: colors.raised,
            borderRadius: 10,
            borderCurve: 'continuous',
            padding: 10,
            gap: 6,
          }}
        >
          {failed && job.last_error ? (
            <Text selectable style={{ color: colors.danger, fontSize: 12.5 }}>
              {job.last_error}
            </Text>
          ) : null}
          {!output || output.status === 'loading' ? (
            <Text style={{ color: colors.textFaint, fontSize: 12.5 }}>正在加载结果…</Text>
          ) : output.status === 'error' ? (
            <Text style={{ color: colors.danger, fontSize: 12.5 }}>{output.message}</Text>
          ) : (
            <Text
              selectable
              numberOfLines={14}
              style={{ color: colors.text, fontFamily: MONO, fontSize: 12, lineHeight: 17 }}
            >
              {output.text || '最近一次运行没有记录结果。'}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

export default function CronScreen() {
  const { colors } = useTheme();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [outputs, setOutputs] = useState<Record<string, OutputState>>({});

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
      setJobs(await withAuthRetry((r) => listCronJobs(r)));
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

  const replaceJob = useCallback((key: string, next: CronJob) => {
    setJobs((prev) => prev.map((j) => (jobKey(j) === key ? next : j)));
  }, []);

  /** Optimistic pause/resume — flip immediately, revert if the server says no. */
  const toggle = useCallback(
    async (job: CronJob) => {
      const key = jobKey(job);
      const enabling = !job.enabled;
      setError(null);
      replaceJob(key, { ...job, enabled: enabling, state: enabling ? 'scheduled' : 'paused' });
      try {
        const updated = await withAuthRetry((r) =>
          enabling ? resumeCronJob(r, job.id, job.profile) : pauseCronJob(r, job.id, job.profile),
        );
        replaceJob(key, updated);
      } catch (e) {
        replaceJob(key, job); // revert
        handleError(e, `无法${enabling ? '恢复' : '暂停'}“${job.name || job.id}”，无法连接网关。`);
      }
    },
    [replaceJob, handleError],
  );

  const runNow = useCallback(
    async (job: CronJob) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const key = jobKey(job);
      setError(null);
      try {
        // Trigger sets next_run_at=now; the scheduler picks it up on its next tick.
        const updated = await withAuthRetry((r) => triggerCronJob(r, job.id, job.profile));
        replaceJob(key, updated);
        setQueued((prev) => ({ ...prev, [key]: true }));
        setTimeout(
          () =>
            setQueued((prev) => {
              const next = { ...prev };
              delete next[key];
              return next;
            }),
          3000,
        );
      } catch (e) {
        handleError(e, `无法运行“${job.name || job.id}”，无法连接网关。`);
      }
    },
    [replaceJob, handleError],
  );

  const edit = useCallback((job: CronJob) => {
    router.push({ pathname: '/cron-edit', params: { id: job.id, profile: job.profile } });
  }, []);

  const toggleOutput = useCallback(
    async (job: CronJob) => {
      const key = jobKey(job);
      const opening = !expanded[key];
      setExpanded((prev) => ({ ...prev, [key]: opening }));
      if (!opening || outputs[key]?.status === 'done') return;

      setOutputs((prev) => ({ ...prev, [key]: { status: 'loading' } }));
      try {
        // Last output = final assistant message of the most recent run session.
        const { runs } = await withAuthRetry((r) => listCronRuns(r, job.id, job.profile, 1));
        if (!runs[0]) {
          setOutputs((prev) => ({ ...prev, [key]: { status: 'done', text: '' } }));
          return;
        }
        const { messages } = await withAuthRetry((r) => getRunMessages(r, runs[0].id, job.profile));
        setOutputs((prev) => ({ ...prev, [key]: { status: 'done', text: lastAssistantText(messages) } }));
      } catch (e) {
        if (e instanceof AuthError) {
          router.replace('/');
          return;
        }
        setOutputs((prev) => ({ ...prev, [key]: { status: 'error', message: '无法加载结果，请下拉重试。' } }));
      }
    },
    [expanded, outputs],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: '定时任务',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="新建定时任务"
              hitSlop={4}
              onPress={() => router.push('/cron-edit')}
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
        data={jobs}
        keyExtractor={jobKey}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.textDim} />}
        renderItem={({ item }) => (
          <JobCard
            job={item}
            queued={!!queued[jobKey(item)]}
            expanded={!!expanded[jobKey(item)]}
            output={outputs[jobKey(item)]}
            onToggle={toggle}
            onRunNow={runNow}
            onEdit={edit}
            onToggleOutput={toggleOutput}
          />
        )}
        ListEmptyComponent={
          loaded && !refreshing && !error ? (
            <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
              <Icon sf="clock.arrow.2.circlepath" size={44} color={colors.textFaint} />
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>暂无定时任务</Text>
              <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>

                可创建周期任务，或在网关运行 “hermes cron add”。
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}
