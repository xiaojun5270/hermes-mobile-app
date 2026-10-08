// src/components/subagent-monitor-card.tsx
import { useEffect, useState } from 'react';
import { LayoutAnimation, Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import type { SubagentBatch, SubagentState } from '@/lib/subagent-progress';
import { useTheme } from '@/theme';

type Colors = ReturnType<typeof useTheme>['colors'];

function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function SubagentRow({
  s,
  now,
  expanded,
  colors,
}: {
  s: SubagentState;
  now: number;
  expanded: boolean;
  colors: Colors;
}) {
  const running = s.status === 'running';
  const elapsed = running ? (now - s.startedAtMs) / 1000 : s.durationSeconds;
  const errored = s.status === 'failed' || s.status === 'timeout';
  const dot = running
    ? colors.accent
    : s.status === 'completed'
      ? colors.success
      : errored
        ? colors.danger
        : colors.textFaint; // stopped / interrupted: neutral, not a failure
  const tokens = running ? 0 : (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
  // Hoisted out of the `sf={…}` attribute so the icon-map usage scanner doesn't
  // mistake a status comparison for an icon name.
  const doneGlyph = s.status === 'completed' ? 'checkmark.circle.fill' : 'xmark.circle';
  // Collapsed row prefers the completion summary once finished, else the latest step.
  const headline = s.status !== 'running' && s.summary ? s.summary : s.activity;
  const fileCount = (s.filesRead?.length ?? 0) + (s.filesWritten?.length ?? 0);
  const footer = [s.model, fileCount > 0 ? `${fileCount} 个文件` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        {running ? (
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} />
        ) : (
          <Icon sf={doneGlyph} size={12} color={dot} />
        )}
        <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 13 }}>
          {s.goal || '子智能体'}
        </Text>
        {elapsed !== undefined ? (
          <Text style={{ color: colors.textFaint, fontSize: 11.5, fontVariant: ['tabular-nums'] }}>
            {fmtElapsed(elapsed)}
          </Text>
        ) : null}
        {tokens > 0 ? (
          <Text style={{ color: colors.textFaint, fontSize: 11.5, fontVariant: ['tabular-nums'] }}>
            {Math.round(tokens / 1000)}k
          </Text>
        ) : null}
      </View>
      {expanded ? (
        // Full step timeline + completion summary + metadata footer.
        <View style={{ gap: 3, marginLeft: 14 }}>
          {s.log.map((line, i) => (
            <Text
              key={`${i}:${line.slice(0, 12)}`}
              numberOfLines={2}
              style={{ color: colors.textFaint, fontSize: 12 }}
            >
              ↳ {line}
            </Text>
          ))}
          {s.status !== 'running' && s.summary ? (
            <Text style={{ color: colors.textDim, fontSize: 12 }}>{s.summary}</Text>
          ) : null}
          {footer ? <Text style={{ color: colors.textFaint, fontSize: 11.5 }}>{footer}</Text> : null}
        </View>
      ) : headline ? (
        // Collapsed: running rows show the current step; finished rows show the summary.
        <Text numberOfLines={1} style={{ color: colors.textFaint, fontSize: 12, marginLeft: 14 }}>
          ↳ {headline}
          {s.toolCount ? ` · ${s.toolCount} 个工具` : ''}
        </Text>
      ) : null}
    </View>
  );
}

export function SubagentMonitorCard({ batch }: { batch: SubagentBatch }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const running = batch.subagents.some((s) => s.status === 'running');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const runningCount = batch.subagents.filter((s) => s.status === 'running').length;
  const doneCount = batch.subagents.length - runningCount;
  const header = running ? `${runningCount} 个运行中` : `${doneCount} 个已完成`;
  const totalCost = batch.subagents.reduce((acc, s) => acc + (s.costUsd ?? 0), 0);

  return (
    <View style={{ paddingVertical: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`子智能体，${header}，${expanded ? '收起' : '展开'}`}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
          setExpanded((e) => !e);
        }}
        style={{
          backgroundColor: colors.raised,
          borderRadius: 14,
          borderCurve: 'continuous',
          paddingHorizontal: 12,
          paddingVertical: 9,
          gap: 8,
          alignSelf: 'stretch',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Icon sf="square.grid.2x2" size={12} color={colors.accent} />
          <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>子智能体</Text>
          <Text style={{ color: colors.textDim, fontSize: 13 }}>{header}</Text>
          <View style={{ flex: 1 }} />
          <Icon sf={expanded ? 'chevron.up' : 'chevron.down'} size={11} color={colors.textFaint} />
        </View>
        <View style={{ gap: 7 }}>
          {batch.subagents.map((s) => (
            <SubagentRow key={s.key} s={s} now={now} expanded={expanded} colors={colors} />
          ))}
        </View>
        {!running && totalCost > 0 ? (
          <Text style={{ color: colors.textFaint, fontSize: 12 }}>总费用约 ${totalCost.toFixed(2)}</Text>
        ) : null}
      </Pressable>
    </View>
  );
}
