import { memo, useState } from 'react';
import { ActivityIndicator, LayoutAnimation, Pressable, Share, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { Icon } from '@/components/icon';
import { MarkdownView } from '@/components/markdown-view';
import { bubbleImageSize } from '@/lib/image-attach';
import type { SubagentBatch } from '@/lib/subagent-progress';
import type { ToolOutcome } from '@/lib/tool-outcome';
import type { TodoItem } from '@/lib/todo';
import { useTheme } from '@/theme';
import { fileSize } from '@/lib/outgoing';

export interface ToolInfo {
  id: string;
  name: string;
  /** Human context from the gateway, e.g. the command or file involved. */
  context?: string;
  running: boolean;
  durationS?: number;
  /** One-line human outcome ("Extracted 3 pages"). */
  summary?: string;
  /** Expanded detail: result text / JSON, truncated by the chat screen. */
  detail?: string;
  /** Inline diff for edit tools, when the gateway provides one. */
  diff?: string;
  /** How the finished tool ended, read from its result (absent = ok). */
  outcome?: ToolOutcome;
}

/** The finished-state glyph and what VoiceOver says for each outcome. */
const OUTCOME_MARK = {
  ok: { sf: 'checkmark.circle.fill', label: '已完成' },
  failed: { sf: 'xmark.circle.fill', label: '失败' },
  denied: { sf: 'hand.raised.fill', label: '已拒绝' },
  interrupted: { sf: 'stop.circle.fill', label: '已中断' },
} as const;

export interface ChatItem {
  key: string;
  role: 'user' | 'assistant' | 'tool' | 'status' | 'subagent' | 'todo';
  text: string;
  /** Assistant messages render plain text while streaming, markdown once complete. */
  complete?: boolean;
  /** Assistant reasoning trace, rehydrated from history; rendered as a
   * collapsible disclosure above the prose. History-only (no live event yet). */
  reasoning?: string;
  tool?: ToolInfo;
  /** Live subagent batch — rendered by the chat screen via SubagentMonitorCard. */
  subagent?: SubagentBatch;
  /** Current todo list — rendered by the chat screen via TodoCard. */
  todo?: TodoItem[];
  /** Local uri of a photo sent with this (user) message. */
  imageUri?: string;
  /** Natural dimensions of the attached photo, for aspect-correct layout. */
  imageWidth?: number;
  imageHeight?: number;
  files?: { name: string; size?: number }[];
  /** User message delivered via session.steer into the running turn (spec §5.3). */
  steered?: boolean;
  /** Status rows with special rendering. 'stopped' = the turn ended with status "interrupted". */
  marker?: 'stopped';
}

function ReasoningDisclosure({ text }: { text: string }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ marginBottom: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`思考过程，${expanded ? '收起' : '展开'}`}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
          setExpanded((e) => !e);
        }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
      >
        <Icon sf="brain" size={12} color={colors.textFaint} />
        <Text style={{ color: colors.textFaint, fontSize: 12.5, fontWeight: '600' }}>思考过程</Text>
        <Icon sf={expanded ? 'chevron.up' : 'chevron.down'} size={10} color={colors.textFaint} />
      </Pressable>
      {expanded ? (
        <View style={{ marginTop: 6, opacity: 0.9 }}>
          <MarkdownView text={text} />
        </View>
      ) : null}
    </View>
  );
}

function ToolCallCard({ tool }: { tool: ToolInfo }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(tool.detail || tool.diff);
  const outcome = tool.outcome ?? 'ok';
  const mark = OUTCOME_MARK[outcome];
  const markColor = outcome === 'ok' ? colors.success : outcome === 'failed' ? colors.danger : colors.textDim;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`工具 ${tool.name}，${tool.running ? '运行中' : mark.label}${
        // A summary's closing period would read ".," before the details hint (sim QA nit).
        tool.summary && !tool.running ? `, ${hasDetail ? tool.summary.replace(/\.+$/, '') : tool.summary}` : ''
      }${hasDetail ? '，查看详情' : ''}`}
      onPress={
        hasDetail
          ? () => {
              LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
              setExpanded((e) => !e);
            }
          : undefined
      }
      style={{
        backgroundColor: colors.raised,
        borderRadius: 14,
        borderCurve: 'continuous',
        paddingHorizontal: 12,
        paddingVertical: 9,
        gap: 6,
        alignSelf: 'stretch',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <Icon sf="hammer.fill" size={12} color={colors.accent} />
        <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>{tool.name}</Text>
        {tool.context ? (
          <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 13, flexShrink: 1 }}>
            {tool.context}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        {tool.running ? (
          <ActivityIndicator size="small" color={colors.textDim} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {tool.durationS !== undefined ? (
              <Text style={{ color: colors.textFaint, fontSize: 12, fontVariant: ['tabular-nums'] }}>
                {tool.durationS < 10 ? tool.durationS.toFixed(1) : Math.round(tool.durationS)} 秒
              </Text>
            ) : null}
            <Icon sf={mark.sf} size={13} color={markColor} />
            {hasDetail ? (
              <Icon sf={expanded ? 'chevron.up' : 'chevron.down'} size={11} color={colors.textFaint} />
            ) : null}
          </View>
        )}
      </View>

      {tool.summary && !tool.running ? (
        <Text style={{ color: colors.textDim, fontSize: 12.5 }}>{tool.summary}</Text>
      ) : null}

      {expanded && hasDetail ? (
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: 10,
            borderCurve: 'continuous',
            padding: 10,
          }}
        >
          <Text selectable style={{ color: colors.textDim, fontFamily: 'Menlo', fontSize: 11.5, lineHeight: 17 }}>
            {tool.diff ? tool.diff : tool.detail}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Claude/ChatGPT-style layout: user messages in a soft right-aligned bubble,
 * assistant replies as full-width prose, tools as expandable cards.
 */
export const MessageRow = memo(function MessageRow({ item }: { item: ChatItem }) {
  const { colors } = useTheme();

  if (item.role === 'user') {
    const imageSize = item.imageUri ? bubbleImageSize(item.imageWidth, item.imageHeight) : null;
    return (
      <View style={{ alignItems: 'flex-end', paddingVertical: 6 }}>
        {item.files?.map((file, i) => (
          <View key={i} style={{ maxWidth: '82%', flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, marginBottom: 5, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
            <Icon sf="doc" size={18} color={colors.textDim} />
            <View style={{ flexShrink: 1 }}>
              <Text style={{ color: colors.text, fontSize: 14 }}>{file.name}</Text>
              <Text style={{ color: colors.textFaint, fontSize: 12 }}>{fileSize(file.size)}</Text>
            </View>
          </View>
        ))}
        {item.imageUri && imageSize ? (
          <Image
            source={{ uri: item.imageUri }}
            accessibilityLabel="你发送的照片"
            contentFit="cover"
            style={{
              width: imageSize.width,
              height: imageSize.height,
              borderRadius: 16,
              backgroundColor: colors.raised,
              marginBottom: item.text ? 5 : 0,
            }}
          />
        ) : null}
        {item.text ? (
          <View
            accessible
            accessibilityLabel={item.steered ? `你的引导：${item.text}` : undefined}
            style={{
              maxWidth: '82%',
              backgroundColor: colors.userBubble,
              borderRadius: 20,
              borderCurve: 'continuous',
              paddingHorizontal: 16,
              paddingVertical: 11,
            }}
          >
            <Text selectable style={{ color: colors.text, fontSize: 17, lineHeight: 24 }}>
              {item.text}
            </Text>
          </View>
        ) : null}
        {item.steered ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: 4, paddingRight: 6 }}>
            <Icon sf="arrow.turn.down.right" size={11} color={colors.textFaint} />
            <Text style={{ color: colors.textFaint, fontSize: 12, fontWeight: '600' }}>已引导</Text>
          </View>
        ) : null}
      </View>
    );
  }

  if (item.role === 'assistant') {
    // Markdown isn't selectable, so long-press opens the share sheet
    // (which includes Copy on iOS). Reasoning-only items have empty text.
    return (
      <Pressable
        accessibilityLabel="智能体消息，长按分享"
        onLongPress={
          item.complete && item.text.trim()
            ? () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                Share.share({ message: item.text });
              }
            : undefined
        }
        style={{ paddingVertical: 6 }}
      >
        {item.reasoning ? <ReasoningDisclosure text={item.reasoning} /> : null}
        {item.complete ? (
          item.text.trim() ? <MarkdownView text={item.text} /> : null
        ) : (
          <Text selectable style={{ color: colors.text, fontSize: 17, lineHeight: 27 }}>
            {item.text}
            <Text style={{ color: colors.accent }}>▍</Text>
          </Text>
        )}
      </Pressable>
    );
  }

  if (item.role === 'tool' && item.tool) {
    return (
      <View style={{ paddingVertical: 4 }}>
        <ToolCallCard tool={item.tool} />
      </View>
    );
  }

  // Rendered by the chat screen (they own their components); render nothing here.
  if (item.role === 'subagent' || item.role === 'todo') return null;

  // status
  if (item.marker === 'stopped') {
    return (
      <View
        accessible
        accessibilityLabel="回复已停止"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 }}
      >
        <Icon sf="stop.circle" size={13} color={colors.textDim} />
        <Text style={{ color: colors.textDim, fontSize: 13, fontWeight: '600' }}>已停止</Text>
      </View>
    );
  }
  return (
    <Text style={{ color: colors.textFaint, fontSize: 12.5, paddingVertical: 3 }}>{item.text}</Text>
  );
});
