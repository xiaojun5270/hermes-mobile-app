import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { SessionSummary } from '@/api/types';
import { Icon } from '@/components/icon';
import { timeAgo } from '@/lib/format';
import { useTheme } from '@/theme';

const ACTION_WIDTH = 74;
const COMPACT_ACTION_WIDTH = 56;

function SwipeAction({
  icon,
  label,
  background,
  tint,
  accessibilityLabel,
  onPress,
  compact,
}: {
  icon: string;
  label: string;
  background: string;
  tint: string;
  accessibilityLabel: string;
  onPress: () => void;
  /** Icon-only, for short rows where icon + label would overflow. */
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        width: compact ? COMPACT_ACTION_WIDTH : ACTION_WIDTH,
        backgroundColor: background,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon sf={icon} size={20} color={tint} />
      {compact ? null : <Text style={{ color: tint, fontSize: 12, fontWeight: '600' }}>{label}</Text>}
    </Pressable>
  );
}

export const SessionRow = memo(function SessionRow({
  session,
  onPress,
  onPin,
  pinned,
  onRename,
  onArchive,
  archiveLabel = '归档',
  onDelete,
  compact,
}: {
  session: SessionSummary;
  onPress: () => void;
  /** When provided, swiping left reveals a Pin/Unpin action. */
  onPin?: () => void;
  /** Whether the session is currently pinned. */
  pinned?: boolean;
  /** When provided, swiping left reveals a Rename action. */
  onRename?: () => void;
  /** When provided, swiping left reveals an Archive/Unarchive action. */
  onArchive?: () => void;
  archiveLabel?: '归档' | '取消归档';
  /** When provided, swiping left reveals a destructive Delete action. */
  onDelete?: () => void;
  /** Sidebar style: a single title line, like the Claude/ChatGPT drawers. */
  compact?: boolean;
}) {
  const { colors } = useTheme();
  const title = session.title?.trim() || session.preview?.trim() || '未命名会话';
  const preview = session.title?.trim() ? session.preview?.trim() : undefined;
  const swipeable = Boolean(onPin || onRename || onArchive || onDelete);

  const row = compact ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`会话：${title}`}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 16,
        paddingVertical: 13,
        borderRadius: 10,
        borderCurve: 'continuous',
        // Opaque over the swipe actions, identical to the sidebar background.
        backgroundColor: pressed ? colors.raised : swipeable ? colors.sidebarBg : 'transparent',
      })}
    >
      <Text numberOfLines={1} style={{ color: colors.text, fontSize: 16.5, letterSpacing: -0.1 }}>
        {title}
      </Text>
    </Pressable>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`会话：${title}`}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 3,
        // Opaque over the swipe actions, identical to the screen background.
        backgroundColor: pressed ? colors.raised : swipeable ? colors.bg : 'transparent',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text
          numberOfLines={1}
          style={{ flex: 1, color: colors.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 }}
        >
          {title}
        </Text>
        <Text style={{ color: colors.textFaint, fontSize: 13, fontVariant: ['tabular-nums'] }}>
          {timeAgo(session.last_active)}
        </Text>
      </View>
      {preview ? (
        <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 14.5 }}>
          {preview}
        </Text>
      ) : null}
      <Text style={{ color: colors.textFaint, fontSize: 12.5, fontVariant: ['tabular-nums'] }}>
        {session.message_count} 条消息
      </Text>
    </Pressable>
  );

  if (!swipeable) return row;

  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={(compact ? COMPACT_ACTION_WIDTH : ACTION_WIDTH) / 2}
      overshootRight={false}
      renderRightActions={(_progress, _translation, methods: SwipeableMethods) => (
        <View style={{ flexDirection: 'row' }}>
          {onPin ? (
            <SwipeAction
              icon={pinned ? 'pin.slash.fill' : 'pin.fill'}
              label={pinned ? '取消置顶' : '置顶'}
              compact={compact}
              background={pinned ? colors.raised : colors.accent}
              tint={pinned ? colors.text : colors.onAccent}
              accessibilityLabel={`${pinned ? '取消置顶' : '置顶'}会话：${title}`}
              onPress={() => { methods.close(); onPin(); }}
            />
          ) : null}
          {onRename ? (
            <SwipeAction
              icon="pencil"
              label="重命名"
              compact={compact}
              background={colors.raised}
              tint={colors.text}
              accessibilityLabel={`重命名会话：${title}`}
              onPress={() => {
                methods.close();
                onRename();
              }}
            />
          ) : null}
          {onArchive ? (
            <SwipeAction
              icon={archiveLabel === '归档' ? 'archivebox.fill' : 'tray.and.arrow.up.fill'}
              label={archiveLabel}
              compact={compact}
              background={colors.accent}
              tint={colors.onAccent}
              accessibilityLabel={`${archiveLabel}会话：${title}`}
              onPress={() => {
                methods.close();
                onArchive();
              }}
            />
          ) : null}
          {onDelete ? (
            <SwipeAction
              icon="trash.fill"
              label="删除"
              compact={compact}
              background={colors.danger}
              tint={colors.onDanger}
              accessibilityLabel={`删除会话：${title}`}
              onPress={() => {
                methods.close();
                onDelete();
              }}
            />
          ) : null}
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  );
});
