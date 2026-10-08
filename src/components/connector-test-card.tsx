// src/components/connector-test-card.tsx — the Test button and its result (spec §5.3).
//
// A failed test shows the gateway's error text. That text is NOT redacted by the
// gateway (docs/contracts/mcp.md), so it is never logged and not selectable. A provider's
// refusal to register the gateway for sign-in is put into words first (lib/mcp).
import { ActivityIndicator, Text, View } from 'react-native';
import type { McpTestOutcome } from '@/api/mcpSession';
import { CardButton } from '@/components/card-button';
import { testFailureLine, testSummary } from '@/lib/mcp';
import { useTheme } from '@/theme';

export type ConnectorTestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; outcome: McpTestOutcome };

function Result({ outcome, explainedAbove }: { outcome: McpTestOutcome; explainedAbove: boolean }) {
  const { colors } = useTheme();
  if (outcome.kind !== 'ok') {
    return (
      <Text selectable={false} style={{ color: colors.danger, fontSize: 14 }}>
        {testFailureLine(outcome.message, !explainedAbove)}
      </Text>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: colors.success, fontSize: 14.5, fontWeight: '600' }}>{testSummary(outcome)}</Text>
      {outcome.tools.map((tool) => (
        <View key={tool.name} style={{ gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '600' }}>{tool.name}</Text>
          {tool.description ? (
            <Text numberOfLines={3} style={{ color: colors.textDim, fontSize: 13.5 }}>
              {tool.description}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function ConnectorTestCard({
  state,
  connected,
  disabled = false,
  explainedAbove = false,
  onTest,
}: {
  state: ConnectorTestState;
  /** False while no chat socket is available: Test cannot run. */
  connected: boolean;
  /** The screen is busy with something a test must not overlap (a sign-in, a removal). */
  disabled?: boolean;
  /** The sign-in card above already explains a refused registration: keep this one to a line. */
  explainedAbove?: boolean;
  onTest: () => void;
}) {
  const { colors } = useTheme();
  const running = state.phase === 'running';
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.border,
        padding: 16,
        gap: 12,
      }}
    >
      <CardButton label="测试连接" a11y="测试连接" onPress={onTest} disabled={running || !connected || disabled} />
      {!connected ? (
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>

          请先返回会话并等待连接成功，再回来测试。
        </Text>
      ) : null}
      {running ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator color={colors.textDim} />
          <Text style={{ color: colors.textDim, fontSize: 14 }}>正在测试…</Text>
        </View>
      ) : null}
      {state.phase === 'done' ? <Result outcome={state.outcome} explainedAbove={explainedAbove} /> : null}
    </View>
  );
}
