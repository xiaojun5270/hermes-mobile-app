import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AuthError } from '@/api/restClient';
import { Icon } from '@/components/icon';
import { connect, restore } from '@/connection';
import { getColdStartRoute, maybeRegisterPush } from '@/notifications';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

export default function ConnectScreen() {
  const { colors } = useTheme();
  const [url, setUrl] = useState('http://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);
  const [restoring, setRestoring] = useState(true);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    restore()
      .then(async (ok) => {
        if (ok) {
          // If a notification cold-started the app, land on its session;
          // else the chat home. Sequenced here (after restore) so this
          // replace is the deep-link target, not a clobbered /chat/new.
          const route = (await getColdStartRoute()) ?? '/chat/new';
          router.replace(route as Parameters<typeof router.replace>[0]);
          // Refresh a stale (>7 days) push registration; never prompts here.
          void maybeRegisterPush({ softAsk: false });
        }
      })
      .catch((e) => {
        // Device-mode restore throws AuthError(REPAIR_MESSAGE) when the
        // pairing is revoked — surface that verbatim so the fix is obvious.
        if (e instanceof AuthError) setError(e.message);
        else setError('无法恢复连接，请检查 VPN 或 Wi-Fi。');
      })
      .finally(() => {
        setBusy(false);
        setRestoring(false);
      });
  }, []);

  async function onConnect() {
    setBusy(true);
    setError(null);
    try {
      await connect(url.trim(), username.trim(), password);
      router.replace('/chat/new');
    } catch (e) {
      if (e instanceof AuthError) setError('用户名或密码不正确。');
      else setError('无法连接网关，请检查地址和网络。');
    } finally {
      setBusy(false);
    }
  }

  if (restoring && !error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.textDim} />
      </View>
    );
  }

  const inputStyle = {
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  } as const;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, gap: 28 }}
        style={{ backgroundColor: colors.bg }}
      >
        <View style={{ alignItems: 'center', gap: 20 }}>
          <Image
            source={require('../../assets/images/hermesagent-text.png')}
            accessibilityLabel="Hermes 智能体"
            contentFit="contain"
            tintColor={colors.text}
            style={{ height: 64, width: (64 * 52) / 24 }}
          />
          <Text style={{ color: colors.textDim, fontSize: 15, textAlign: 'center' }}>

            随身使用你的智能体。{'\n'}通过你的私有网络连接。
          </Text>
        </View>

        {error ? (
          <Text selectable style={{ color: colors.danger, fontSize: 14.5, textAlign: 'center' }}>
            {error}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="扫码配对"
          onPress={() => router.push('/pair')}
          disabled={busy}
          style={({ pressed }) => ({
            backgroundColor: colors.inverseSurface,
            opacity: busy ? 0.6 : pressed ? 0.85 : 1,
            borderRadius: 999,
            minHeight: 52,
            flexDirection: 'row',
            gap: 8,
            alignItems: 'center',
            justifyContent: 'center',
          })}
        >
          <Icon sf="qrcode.viewfinder" size={20} color={colors.onInverse} />
          <Text style={{ color: colors.onInverse, fontSize: 16.5, fontWeight: '600' }}>扫码配对</Text>
        </Pressable>

        {showPasswordForm ? (
          <View style={{ gap: 16 }}>
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
              <TextInput
                style={inputStyle}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="网关地址，例如 http://100.x.y.z:9119"
                placeholderTextColor={colors.textFaint}
              />
              <View style={{ height: 1, backgroundColor: colors.border }} />
              <TextInput
                style={inputStyle}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="username"
                placeholder="用户名"
                placeholderTextColor={colors.textFaint}
              />
              <View style={{ height: 1, backgroundColor: colors.border }} />
              <TextInput
                style={inputStyle}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                textContentType="password"
                placeholder="密码"
                placeholderTextColor={colors.textFaint}
                onSubmitEditing={onConnect}
              />
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="使用用户名和密码连接"
              onPress={onConnect}
              disabled={busy}
              style={({ pressed }) => ({
                borderRadius: 999,
                backgroundColor: pressed ? colors.userBubble : colors.raised,
                opacity: busy ? 0.6 : 1,
                minHeight: 50,
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              {busy ? (
                <ActivityIndicator color={colors.textDim} />
              ) : (
                <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>连接</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="改用密码连接"
            onPress={() => setShowPasswordForm(true)}
            style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ color: colors.textDim, fontSize: 15.5 }}>改用密码连接</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
