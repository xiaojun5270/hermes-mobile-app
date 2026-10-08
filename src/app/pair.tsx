// src/app/pair.tsx — QR device pairing (docs/contracts/pairing.md)
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, router } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Icon } from '@/components/icon';
import { connectWithDevice } from '@/connection';
import { maybeRegisterPush } from '@/notifications';
import { PairingParseError, PairingPayload, pairingHost, parsePairingPayload } from '@/lib/pairing';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

export default function PairScreen() {
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [pending, setPending] = useState<PairingPayload | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanLocked = useRef(false); // QR fires repeatedly; latch the first hit

  function handlePayload(text: string) {
    try {
      setPending(parsePairingPayload(text));
      setError(null);
    } catch (e) {
      scanLocked.current = false;
      setError(e instanceof PairingParseError ? e.message : '无法读取配对码。');
    }
  }

  function onScanned({ data }: { data: string }) {
    if (scanLocked.current || pending || busy) return;
    scanLocked.current = true;
    handlePayload(data);
  }

  function rescan() {
    scanLocked.current = false;
    setPending(null);
    setError(null);
  }

  async function onConfirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await connectWithDevice(pending.url, pending.rt, pending.deviceId);
      router.replace('/chat/new');
      // Fresh pairing is the one moment we soft-ask for notification
      // permission; fire-and-forget so navigation never waits on it.
      void maybeRegisterPush({ softAsk: true });
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : '无法连接网关，请检查地址和网络。',
      );
      // The scanned RT is single-use only on success — a failed refresh means
      // it is dead either way, so force a fresh scan rather than a retry.
      scanLocked.current = false;
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const canUseCamera = permission?.granted === true;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: '设备配对' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, gap: 20 }}
        style={{ backgroundColor: colors.bg }}
      >
        <Text style={{ color: colors.textDim, fontSize: 15, lineHeight: 21 }}>
          在网关运行 <Text style={{ color: colors.text, fontWeight: '600' }}>hermes mobile pair</Text>，然后扫描显示的二维码。
        </Text>

        {/* Scanner / confirm card */}
        <View
          style={{
            borderRadius: 20,
            borderCurve: 'continuous',
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          {pending ? (
            <View style={{ padding: 20, gap: 16, alignItems: 'center' }}>
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 16,
                  borderCurve: 'continuous',
                  backgroundColor: colors.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon sf="checkmark.seal.fill" size={26} color={colors.onAccent} />
              </View>
              <View style={{ alignItems: 'center', gap: 4 }}>
                <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>与此网关配对？</Text>
                <Text selectable style={{ color: colors.textDim, fontSize: 15, textAlign: 'center' }}>
                  {pairingHost(pending.url)}
                </Text>
                <Text style={{ color: colors.textFaint, fontSize: 13 }}>设备 {pending.deviceId}</Text>
              </View>
              <View style={{ alignSelf: 'stretch', gap: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`连接到 ${pairingHost(pending.url)}`}
                  onPress={onConfirm}
                  disabled={busy}
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? colors.accentPressed : colors.accent,
                    opacity: busy ? 0.6 : 1,
                    borderRadius: 999,
                    minHeight: 50,
                    alignItems: 'center',
                    justifyContent: 'center',
                  })}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text style={{ color: colors.onAccent, fontSize: 16.5, fontWeight: '600' }}>连接</Text>
                  )}
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="取消并重新扫描"
                  onPress={rescan}
                  disabled={busy}
                  style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ color: colors.textDim, fontSize: 15.5 }}>重新扫描</Text>
                </Pressable>
              </View>
            </View>
          ) : canUseCamera ? (
            <CameraView
              style={{ height: 320 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScanned}
              accessibilityLabel="扫描配对二维码的相机取景框"
            />
          ) : (
            <View style={{ padding: 24, gap: 14, alignItems: 'center' }}>
              <Icon sf="qrcode.viewfinder" size={44} color={colors.textFaint} />
              <Text style={{ color: colors.textDim, fontSize: 15, textAlign: 'center' }}>
                {permission?.canAskAgain === false
                  ? '相机权限未开启，请在系统设置中启用，或在下方粘贴配对码。'
                  : 'Hermes 需要相机权限来扫描配对二维码。'}
              </Text>
              {permission?.canAskAgain !== false ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="允许访问相机"
                  onPress={() => requestPermission()}
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? colors.accentPressed : colors.accent,
                    borderRadius: 999,
                    minHeight: 44,
                    paddingHorizontal: 24,
                    alignItems: 'center',
                    justifyContent: 'center',
                  })}
                >
                  <Text style={{ color: colors.onAccent, fontSize: 15.5, fontWeight: '600' }}>允许使用相机</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>

        {error ? (
          <Text selectable style={{ color: colors.danger, fontSize: 14.5, textAlign: 'center' }}>
            {error}
          </Text>
        ) : null}

        {/* Manual-paste fallback (simulators, no-qrcode-package gateways) */}
        {!pending ? (
          <View style={{ gap: 10 }}>
            <Text style={{ color: colors.textFaint, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6 }}>

              或粘贴配对码
            </Text>
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
                style={{ color: colors.text, fontSize: 15, paddingHorizontal: 16, paddingVertical: 14, minHeight: 72 }}
                value={pasted}
                onChangeText={setPasted}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                placeholder='{"url":"http://…:9119","rt":"…","device_id":"…"}'
                placeholderTextColor={colors.textFaint}
                accessibilityLabel="JSON 配对码"
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="使用粘贴的配对码"
              onPress={() => handlePayload(pasted)}
              disabled={!pasted.trim() || busy}
              style={({ pressed }) => ({
                opacity: !pasted.trim() || busy ? 0.5 : pressed ? 0.7 : 1,
                minHeight: 44,
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>使用配对码</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
