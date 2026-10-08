import Constants from 'expo-constants';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import { connectionInfo, disconnect } from '@/connection';
import { getPushStatus, requestPushPermission, type PushStatus } from '@/notifications';
import { useTheme } from '@/theme';

function pushLabel(s: PushStatus): string {
  switch (s.state) {
    case 'registered': return '已开启';
    case 'denied': return '已关闭';
    case 'no-project-id': return '未设置';
    case 'unavailable': return '不可用';
    case 'error': return '正在重试';
    default: return '已关闭';
  }
}

export { RouteError as ErrorBoundary } from '@/components/route-error';

function NavRow({ icon, label, href }: { icon: string; label: string; href: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.push(href as any)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 16,
        minHeight: 52,
        backgroundColor: pressed ? colors.raised : 'transparent',
      })}
    >
      <Icon sf={icon} size={20} color={colors.accent} />
      <Text style={{ color: colors.text, fontSize: 15.5, flex: 1 }}>{label}</Text>
      <Icon sf="chevron.right" size={13} color={colors.textFaint} />
    </Pressable>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, gap: 16 }}>
      <Text style={{ color: colors.textDim, fontSize: 15 }}>{label}</Text>
      <Text selectable numberOfLines={1} style={{ color: colors.text, fontSize: 15, flexShrink: 1 }}>
        {value}
      </Text>
    </View>
  );
}

function SectionLabel({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <Text
      style={{
        color: colors.textFaint,
        fontSize: 13,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        paddingHorizontal: 4,
        marginBottom: -10,
      }}
    >
      {children}
    </Text>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
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
      {children}
    </View>
  );
}

function Divider() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}

function PushRow({
  push,
  registering,
  onTap,
}: {
  push: PushStatus;
  registering: boolean;
  onTap: () => void;
}) {
  const { colors } = useTheme();
  const tappable = push.state !== 'registered'
    && push.state !== 'no-project-id'
    && push.state !== 'unavailable';
  const label = pushLabel(push);

  const content = (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, gap: 16 }}>
      <Text style={{ color: colors.textDim, fontSize: 15 }}>通知</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
        {registering ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Text
            selectable={!tappable}
            numberOfLines={1}
            style={{ color: tappable ? colors.accent : colors.text, fontSize: 15, flexShrink: 1 }}
          >
            {label}
          </Text>
        )}
        {tappable && !registering ? (
          <Icon sf="chevron.right" size={13} color={colors.textFaint} />
        ) : null}
      </View>
    </View>
  );

  if (!tappable) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`通知：${label}，${push.state === 'denied' && push.canAskAgain === false ? '打开系统设置' : '开启通知'}`}
      onPress={onTap}
      disabled={registering}
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.raised : 'transparent',
      })}
    >
      {content}
    </Pressable>
  );
}

type Info = Awaited<ReturnType<typeof connectionInfo>>;

export default function SettingsScreen() {
  const { colors } = useTheme();
  const [info, setInfo] = useState<Info>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const [push, setPush] = useState<PushStatus>(() => getPushStatus());
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    connectionInfo().then(setInfo);
  }, []);

  // When permission was denied at the OS level, the only recovery is the system
  // Settings app — so re-check on foreground. Linking.openSettings() resolves
  // when iOS *switches* apps, not when the user returns, so a synchronous
  // re-check after it would read the pre-toggle (still-denied) value; the
  // AppState 'active' edge is the real "user came back" signal.
  useEffect(() => {
    if (push.state !== 'denied') return;
    const sub = AppState.addEventListener('change', async (next) => {
      if (next !== 'active') return;
      let started = false;
      try {
        const perms = await Notifications.getPermissionsAsync();
        if (!perms.granted || !mounted.current) return;
        started = true;
        setRegistering(true);
        const result = await requestPushPermission();
        if (mounted.current) setPush(result);
      } catch {
        if (mounted.current) setPush(getPushStatus());
      } finally {
        if (started && mounted.current) setRegistering(false);
      }
    });
    return () => sub.remove();
  }, [push.state]);

  async function onDisconnect() {
    await disconnect();
    router.dismissAll();
    router.replace('/');
  }

  async function onNotificationsTap() {
    if (push.state === 'denied' && push.canAskAgain === false) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      // Hand off to iOS Settings; the AppState 'active' listener above
      // re-registers if the user flips the toggle and returns.
      try {
        await Linking.openSettings();
      } catch {
        // openSettings can reject if no settings deep-link is available; the
        // listener still covers the return path, so there is nothing to do.
      }
      return;
    }
    void Haptics.selectionAsync().catch(() => {});
    setRegistering(true);
    try {
      const result = await requestPushPermission();
      if (mounted.current) {
        setPush(result);
        if (result.state === 'registered') {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        } else if (result.state === 'error') {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        }
      }
    } finally {
      if (mounted.current) setRegistering(false);
    }
  }

  const deviceMode = info?.mode === 'device';

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 20, paddingTop: 28 }}
    >
      <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700' }}>设置</Text>

      <SectionLabel>连接</SectionLabel>
      <Card>
        <Row label="网关" value={info?.baseUrl ?? '—'} />
        {deviceMode ? (
          <>
            <Divider />
            <Row label="设备" value={info?.deviceId ?? '—'} />
            <Divider />
            <PushRow push={push} registering={registering} onTap={onNotificationsTap} />
          </>
        ) : (
          <>
            <Divider />
            <Row label="用户" value={info?.username || '—'} />
          </>
        )}
        <Divider />
        <Row label="版本" value={Constants.expoConfig?.version ?? 'dev'} />
      </Card>

      {deviceMode && push.note && !registering ? (
        <Text style={{ color: colors.textFaint, fontSize: 13, paddingHorizontal: 4, marginTop: -12 }}>
          {push.note}
        </Text>
      ) : null}

      <SectionLabel>管理</SectionLabel>
      <Card>
        <NavRow icon="clock.arrow.circlepath" label="定时任务" href="/cron" />
        <Divider />
        <NavRow icon="brain" label="记忆" href="/memory" />
        <Divider />
        <NavRow icon="sparkles" label="技能" href="/skills" />
        <Divider />
        <NavRow icon="cpu" label="模型" href="/models" />
      </Card>

      <SectionLabel>危险操作</SectionLabel>
      <Pressable
        onPress={onDisconnect}
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.raised : colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 16,
          borderCurve: 'continuous',
          paddingVertical: 15,
          alignItems: 'center',
        })}
      >
        <Text style={{ color: colors.danger, fontSize: 16, fontWeight: '600' }}>断开连接</Text>
      </Pressable>

      <Text style={{ color: colors.textFaint, fontSize: 12.5, textAlign: 'center' }}>

        hermes-agent 的非官方开源客户端。{'\n'}仅连接你自己的网关。
      </Text>
    </ScrollView>
  );
}
