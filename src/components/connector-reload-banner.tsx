// src/components/connector-reload-banner.tsx — shown on the Connectors list while the
// running gateway does not have a change made to its connectors (spec §5.7).
//
// The gateway loads a new, switched or removed connector only on `reload.mcp` or a restart.
// A reload reconnects every connector for every open chat and drops their prompt cache, so
// the screen asks before calling it; this is only the banner.
import { ActivityIndicator, Text, View } from 'react-native';
import { CardButton } from '@/components/card-button';
import { useTheme } from '@/theme';

export function ConnectorReloadBanner({
  running,
  disabledReason,
  note,
  onReload,
}: {
  running: boolean;
  /** Why a reload cannot run now (no chat connected, a turn in progress), or null. */
  disabledReason: string | null;
  note: { tone: 'error' | 'info'; text: string } | null;
  onReload: () => void;
}) {
  const { colors } = useTheme();
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
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>智能体尚未加载你的修改。</Text>
      <Text style={{ color: colors.textDim, fontSize: 13.5 }}>

        重新加载连接器后立即生效，或等待网关重启后生效。
      </Text>
      {running ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator color={colors.textDim} />
          <Text style={{ color: colors.textDim, fontSize: 14 }}>正在重新加载…</Text>
        </View>
      ) : null}
      {disabledReason && !running ? (
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>{disabledReason}</Text>
      ) : null}
      {note ? (
        <Text
          accessibilityLiveRegion="polite"
          selectable={false}
          style={{ color: note.tone === 'error' ? colors.danger : colors.textDim, fontSize: 13.5 }}
        >
          {note.text}
        </Text>
      ) : null}
      <CardButton
        label="立即重新加载"
        a11y="立即重新加载"
        onPress={onReload}
        disabled={running || disabledReason !== null}
        primary
      />
    </View>
  );
}
