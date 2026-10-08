import { Pressable, ScrollView, Text, View } from 'react-native';
import { Icon } from './icon';
import { useTheme } from '@/theme';
import { queueEditable, type QueueEntry } from '@/lib/outgoing';

export function MessageQueue({ entries, remoteText, disabled, onCancel, onRestore, onRetry, paused, onContinue }: {
  entries: QueueEntry[];
  remoteText?: string;
  disabled?: boolean;
  onCancel: (id: string) => void;
  onRestore: (id: string) => void;
  onRetry: (id: string) => void;
  paused?: boolean;
  onContinue?: () => void;
}) {
  const { colors } = useTheme();
  if (!entries.length && !remoteText) return null;
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
      <Text style={{ color: colors.textDim, fontSize: 13, paddingBottom: 4 }}>排队消息</Text>
      {paused ? (
        <Pressable accessibilityRole="button" accessibilityLabel="继续队列" disabled={disabled} onPress={onContinue} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 }}>
          <Icon sf="play.circle.fill" size={16} color={colors.accent} />
          <Text style={{ color: colors.text, fontSize: 14 }}>继续队列</Text>
        </Pressable>
      ) : null}
      <ScrollView style={{ maxHeight: 150 }} keyboardShouldPersistTaps="handled">
        {remoteText ? <Text style={{ color: colors.textFaint, fontSize: 12 }} numberOfLines={2}>网关队首（不可撤回）：{remoteText}</Text> : null}
        {entries.map((entry, index) => {
          const editable = !disabled && queueEditable(entry);
          return (
            <View key={entry.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontSize: 13 }} numberOfLines={2}>{index + 1}. {entry.draft.text || '附件消息'}</Text>
                {entry.draft.files.map((f) => <Text key={f.id} numberOfLines={1} style={{ color: colors.textDim, fontSize: 12 }}>{f.name}</Text>)}
                {entry.draft.image ? <Text style={{ color: colors.textDim, fontSize: 12 }}>照片</Text> : null}
                <Text style={{ color: entry.error ? colors.danger : colors.textFaint, fontSize: 12 }}>
                  {({ pending: '本地待发送', sending: '发送中', accepted: '网关已接受，不可撤回', error: '发送失败', unknown: '提交结果未确认，已暂停重发', upload_unknown: '上传未确认，未提交；可撤销文件消息' })[entry.state]}
                  {entry.error ? `：${entry.error}` : ''}
                </Text>
              </View>
              {entry.state === 'error' ? <Pressable accessibilityRole="button" accessibilityLabel={`重试排队消息 ${index + 1}`} disabled={disabled} onPress={() => onRetry(entry.id)} style={{ padding: 8 }}><Icon sf="arrow.clockwise" size={16} color={colors.text} /></Pressable> : null}
              <Pressable accessibilityRole="button" accessibilityLabel={`将排队消息 ${index + 1}恢复为草稿`} disabled={!editable} onPress={() => onRestore(entry.id)} style={{ padding: 8 }}>
                <Icon sf="square.and.pencil" size={16} color={editable ? colors.text : colors.textFaint} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`取消排队消息 ${index + 1}`} disabled={!editable} onPress={() => onCancel(entry.id)} style={{ padding: 8 }}>
                <Icon sf="xmark" size={14} color={editable ? colors.text : colors.textFaint} />
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
