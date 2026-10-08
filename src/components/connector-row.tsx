// src/components/connector-row.tsx — one configured MCP connector in the list (spec §5.2).
import { Pressable, Switch, Text, View } from 'react-native';
import type { McpServer } from '@/api/mcp';
import { connectorBadges, serverCapabilities, serverSubtitle } from '@/lib/mcp';
import { useTheme } from '@/theme';

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
      <Text style={{ color: colors.textDim, fontSize: 11.5, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function ConnectorRow({
  server,
  status,
  onPress,
  onToggle,
}: {
  server: McpServer;
  /** The runtime status line, or null when it is not available. */
  status: string | null;
  onPress: (server: McpServer) => void;
  onToggle: (server: McpServer) => void;
}) {
  const { colors } = useTheme();
  const caps = serverCapabilities(server);
  const subtitle = serverSubtitle(server);
  const badges = connectorBadges(server);
  // The label replaces the pressable's children for VoiceOver, so the badges and the note go into it.
  const a11y = [
    `${server.name} 连接器`,
    subtitle,
    ...badges,
    status,
    server.enabled ? null : '已停用',
    caps.manageable ? null : '无法在应用中修改',
  ]
    .filter(Boolean)
    .join(', ');
  // The card is a plain View with two siblings — the pressable text and the switch — so
  // VoiceOver can reach the switch. (An accessible Pressable would swallow a Switch inside it.)
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.border,
        padding: 14,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityHint="查看连接器详情"
        onPress={() => onPress(server)}
        style={({ pressed }) => ({ flex: 1, gap: 4, minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.55 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{
              color: server.enabled ? colors.text : colors.textDim,
              fontSize: 16,
              fontWeight: '600',
              flexShrink: 1,
            }}
          >
            {server.name}
          </Text>
          {badges.map((label) => (
            <Badge key={label} label={label} />
          ))}
        </View>
        {subtitle ? (
          <Text numberOfLines={1} style={{ color: colors.textFaint, fontSize: 13.5 }}>
            {subtitle}
          </Text>
        ) : null}
        {status ? (
          <Text numberOfLines={1} style={{ color: status === '失败' ? colors.danger : colors.textDim, fontSize: 13 }}>
            {status}
          </Text>
        ) : null}
        {!caps.manageable ? (
          <Text style={{ color: colors.textFaint, fontSize: 12.5 }}>

            名称包含“/”，无法在应用中修改。
          </Text>
        ) : null}
      </Pressable>
      {caps.canSwitch ? (
        <Switch
          value={server.enabled}
          onValueChange={() => onToggle(server)}
          accessibilityLabel={`${server.name} ${server.enabled ? '已启用，双击停用' : '已停用，双击启用'}`}
          trackColor={{ true: colors.accent }}
          hitSlop={8}
        />
      ) : null}
    </View>
  );
}
