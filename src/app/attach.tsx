import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, Text, View } from 'react-native';
import { getModelInfo, modelDisplayName } from '@/api/models';
import { requestAttach, type AttachAction } from '@/attach-bus';
import { Icon } from '@/components/icon';
import { withAuthRetry } from '@/connection';
import { showProfilePicker } from '@/lib/profile-picker';
import { activeProfileLabel, getProfileState, subscribeProfiles } from '@/profile-store';
import { useTheme } from '@/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export { RouteError as ErrorBoundary } from '@/components/route-error';

/** Give the sheet time to dismiss before presenting a system picker or
 * pushing a screen — overlapping presentations get cancelled by iOS. */
const DISMISS_MS = 420;

function Tile({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        height: 92,
        borderRadius: 18,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: pressed ? colors.userBubble : colors.raised,
      })}
    >
      <Icon sf={icon} size={26} color={colors.text} />
      <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

function Row({
  icon,
  label,
  value,
  last,
  onPress,
}: {
  icon: string;
  label: string;
  value?: string | null;
  last?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}: ${value}` : label}
      onPress={onPress}
      style={({ pressed }) => ({ backgroundColor: pressed ? colors.raised : 'transparent' })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 16, height: 52 }}>
        <Icon sf={icon} size={20} color={colors.text} />
        <Text style={{ flex: 1, color: colors.text, fontSize: 16.5 }}>{label}</Text>
        {value ? (
          <Text numberOfLines={1} style={{ color: colors.textFaint, fontSize: 15.5, maxWidth: 150 }}>
            {value}
          </Text>
        ) : null}
        <Icon sf="chevron.right" size={12} color={colors.textFaint} />
      </View>
      {!last ? <View style={{ height: 1, marginLeft: 49, backgroundColor: colors.border }} /> : null}
    </Pressable>
  );
}

/** Add-to-chat sheet, in the style of the Claude app: photo sources up top,
 * then the chat's knobs (model, profile) and hermes destinations. */
export default function AttachSheet() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const profiles = useSyncExternalStore(subscribeProfiles, getProfileState);
  const [modelName, setModelName] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    withAuthRetry((r) => getModelInfo(r))
      .then((info) => {
        if (!stale) setModelName(modelDisplayName(info.model));
      })
      .catch(() => {
        // offline — row just shows no value
      });
    return () => {
      stale = true;
    };
  }, []);

  const attach = (action: AttachAction) => {
    router.back();
    setTimeout(() => requestAttach(action), DISMISS_MS);
  };

  const go = (push: () => void) => {
    router.back();
    setTimeout(push, DISMISS_MS);
  };

  return (
    <View style={{ backgroundColor: colors.bg }}>
      {/* Header: close + centered title. paddingTop clears the sheet's
          grabber — with fitToContents the sheet sizes itself to this
          view's natural height, so there's no flex:1 wrapper competing
          with it for space (that competition was the root cause of the
          missing header / dead space bug). */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 24, paddingBottom: 4 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭"
          hitSlop={8}
          onPress={() => router.back()}
          style={({ pressed }) => ({
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? colors.raised : colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
          })}
        >
          <Icon sf="xmark" size={13} color={colors.text} />
        </Pressable>
        <Text style={{ flex: 1, textAlign: 'center', color: colors.text, fontSize: 17, fontWeight: '600' }}>

          添加到会话
        </Text>
        {/* Spacer balancing the close button so the title stays centered. */}
        <View style={{ width: 34 }} />
      </View>

      <View style={{ padding: 14, paddingBottom: Math.max(14, insets.bottom), gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Tile icon="camera.fill" label="拍照" onPress={() => attach('camera')} />
          <Tile icon="photo.on.rectangle" label="照片" onPress={() => attach('library')} />
          <Tile icon="doc.fill" label="文件" onPress={() => attach('files')} />
        </View>

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
          <Row
            icon="cpu"
            label="模型"
            value={modelName}
            onPress={() => go(() => router.push('/models'))}
          />
          <Row
            icon="person.crop.circle"
            label="配置档案"
            value={activeProfileLabel(profiles)}
            last
            onPress={profiles.names.length > 1 ? showProfilePicker : () => go(() => router.push('/settings'))}
          />
        </View>

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
          <Row
            icon="calendar.badge.plus"
            label="创建定时任务"
            onPress={() => go(() => router.push('/cron-edit'))}
          />
          <Row icon="sparkles" label="技能" onPress={() => go(() => router.push('/skills'))} />
          <Row
            icon="books.vertical"
            label="记忆"
            last
            onPress={() => go(() => router.push('/memory'))}
          />
        </View>
      </View>
    </View>
  );
}
