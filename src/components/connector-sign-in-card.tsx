// src/components/connector-sign-in-card.tsx — the Sign in button of an OAuth connector, the
// running state with Cancel, and the outcome line (spec §5.3, §5.6).
//
// The note can be gateway text (a provider's refusal), so it is never selectable. The redirect
// address under it is built by the app, and is selectable so it can be copied into the
// provider's settings.
import { ActivityIndicator, Text, View } from 'react-native';
import { CardButton } from '@/components/card-button';
import { oauthPhaseLine, type OauthPhase } from '@/lib/mcp-oauth';
import { useTheme } from '@/theme';

export interface ConnectorSignInNote {
  tone: 'error' | 'info';
  text: string;
  /** The redirect address a provider has to allow, when it refused it. */
  address?: string | null;
}

export function ConnectorSignInCard({
  label,
  phase,
  cancelling,
  note,
  disabled = false,
  onSignIn,
  onCancel,
}: {
  label: '登录' | '重新登录';
  /** Set while a sign-in runs. */
  phase: OauthPhase | null;
  cancelling: boolean;
  note: ConnectorSignInNote | null;
  /** The screen is busy with something that must not overlap a sign-in. */
  disabled?: boolean;
  onSignIn: () => void;
  onCancel: () => void;
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
        padding: 16,
        gap: 12,
      }}
    >
      {phase ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator color={colors.textDim} />
            <Text accessibilityLiveRegion="polite" style={{ color: colors.textDim, fontSize: 14, flexShrink: 1 }}>
              {cancelling ? '正在取消…' : oauthPhaseLine(phase)}
            </Text>
          </View>
          <CardButton label="取消" a11y="取消登录" onPress={onCancel} disabled={cancelling} />
        </>
      ) : (
        <CardButton label={label} a11y={label} onPress={onSignIn} disabled={disabled} primary />
      )}
      {note ? (
        <Text
          accessibilityLiveRegion="polite"
          selectable={false}
          style={{ color: note.tone === 'error' ? colors.danger : colors.textDim, fontSize: 14 }}
        >
          {note.text}
        </Text>
      ) : null}
      {note?.address ? (
        <View style={{ gap: 4 }}>
          <View accessible accessibilityLabel={`回调地址：${note.address}`} style={{ gap: 4 }}>
            <Text style={{ color: colors.textFaint, fontSize: 12.5, fontWeight: '600' }}>回调地址</Text>
            <Text selectable style={{ color: colors.text, fontSize: 14 }}>
              {note.address}
            </Text>
          </View>
          <Text style={{ color: colors.textFaint, fontSize: 12.5 }}>

            这是网关默认回调地址。如果网关配置了其他地址，请允许该地址。
          </Text>
        </View>
      ) : null}
    </View>
  );
}
