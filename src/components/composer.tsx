import { useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Icon } from '@/components/icon';
import { composerMinHeight, valueSetFromJs } from '@/lib/composer-height';
import type { ComposerMode } from '@/lib/turn-controller';
import { useTheme } from '@/theme';
import { fileSize, type StagedFile } from '@/lib/outgoing';

interface ComposerProps {
  value: string;
  onChangeText: (t: string) => void;
  onSend: () => void;
  /** Input disabled entirely (e.g. session not ready). */
  disabled?: boolean;
  /** From `composerMode(turn, hasText, hasImage)` — spec §5.2. */
  mode: ComposerMode;
  /** Running turn: `session.interrupt`. */
  onStop: () => void;
  /** Running turn: `session.steer` with the current text. */
  onSteer: () => void;
  /** Local uri of the staged photo, shown as a removable chip above the input. */
  stagedImageUri?: string | null;
  /** Open the Take Photo / Choose from Library sheet. */
  onAttachPress?: () => void;
  /** Remove the staged photo chip. */
  onRemoveImage?: () => void;
  /** Current model short name — renders the tappable pill when present. */
  modelName?: string | null;
  /** Open the model picker. */
  onModelPress?: () => void;
  sending?: boolean;
  files?: StagedFile[];
  onRemoveFile?: (id: string) => void;
  onQueue?: () => void;
}

/** Floating card composer in the style of the Claude app: input on top,
 * attach + model pill + send on a row beneath. */
export function Composer({
  value,
  onChangeText,
  onSend,
  disabled,
  mode,
  onStop,
  onSteer,
  stagedImageUri,
  onAttachPress,
  onRemoveImage,
  modelName,
  onModelPress,
  sending,
  files = [],
  onRemoveFile,
  onQueue,
}: ComposerProps) {
  const { colors, dark } = useTheme();
  const running = mode.kind === 'stop+steer';
  const stopping = running && !mode.stopEnabled;
  const canSend = !disabled && !sending && mode.kind === 'send' && mode.enabled;
  const canStop = !disabled && running && mode.stopEnabled;
  const canSteer = !disabled && !sending && running && mode.steerEnabled;
  const canQueue = !disabled && !sending && (value.trim().length > 0 || Boolean(stagedImageUri) || files.length > 0);
  const hasText = value.trim().length > 0;

  // Fabric measures a JS-set TextInput against its previous text, so after a
  // send it would keep its grown height and a failed steer's restore would
  // show at one line. Re-render once after a JS-driven value is committed so
  // composerMinHeight() can flip a layout-neutral prop and force a re-measure —
  // see src/lib/composer-height.ts.
  const lastEmittedRef = useRef<string | null>(null);
  const [remeasure, setRemeasure] = useState(false);
  useLayoutEffect(() => {
    const fromJs = valueSetFromJs(value, lastEmittedRef.current);
    lastEmittedRef.current = null; // consumed: a later JS set of the same text still flips
    if (fromJs) setRemeasure((r) => !r); // the follow-up commit IS the fix
  }, [value]);

  return (
    // Bottom spacing is owned by the chat screen, which tracks the keyboard
    // per-frame (useAnimatedKeyboard) so the card rides it smoothly.
    <View style={{ paddingHorizontal: 10, paddingTop: 6 }}>
      <View
        style={{
          backgroundColor: colors.surface,
          borderRadius: 26,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: colors.border,
          paddingHorizontal: 14,
          paddingTop: 6,
          paddingBottom: 10,
          gap: 8,
          boxShadow: dark ? '0 4px 18px rgba(0, 0, 0, 0.35)' : '0 4px 18px rgba(31, 30, 26, 0.08)',
        }}
      >
        {stagedImageUri ? (
          <Animated.View entering={FadeIn.duration(200)} style={{ flexDirection: 'row', paddingTop: 8 }}>
            <View style={{ width: 64, height: 64 }}>
              <Image
                source={{ uri: stagedImageUri }}
                accessibilityLabel="待发送照片"
                contentFit="cover"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  backgroundColor: colors.raised,
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="移除照片"
                onPress={onRemoveImage}
                disabled={sending}
                hitSlop={12}
                style={({ pressed }) => ({
                  position: 'absolute',
                  top: -7,
                  right: -7,
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? colors.raised : colors.surface,
                  borderWidth: 1,
                  borderColor: colors.border,
                })}
              >
                <Icon sf="xmark" size={10} color={colors.text} />
              </Pressable>
            </View>
            {running ? (
              <Text style={{ color: colors.textFaint, fontSize: 12.5, alignSelf: 'center', marginLeft: 10, flexShrink: 1 }}>

                本轮结束后可发送这张照片
              </Text>
            ) : null}
          </Animated.View>
        ) : null}

        {files.length ? (
          <ScrollView style={{ maxHeight: 156 }} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
            {files.map((file) => (
              <View key={file.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
                <Icon sf="doc" size={20} color={colors.textDim} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={2} style={{ color: colors.text, fontSize: 14 }}>{file.name}</Text>
                  <Text style={{ color: file.error ? colors.danger : colors.textFaint, fontSize: 12 }}>
                    {fileSize(file.size)} · {({ ready: '待发送', reading: '读取中', uploading: '上传中', uploaded: '已上传', error: '失败，可重试', unknown: '上传结果未确认' })[file.status]}
                  </Text>
                  {file.error ? <Text numberOfLines={2} style={{ color: colors.danger, fontSize: 12 }}>{file.error}</Text> : null}
                </View>
                {file.status === 'reading' || file.status === 'uploading' ? <ActivityIndicator color={colors.accent} /> : null}
                <Pressable accessibilityRole="button" accessibilityLabel={`移除文件 ${file.name}`} disabled={sending} onPress={() => onRemoveFile?.(file.id)} hitSlop={6} style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon sf="xmark" size={13} color={colors.textDim} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        <TextInput
          value={value}
          onChangeText={(t) => {
            lastEmittedRef.current = t;
            onChangeText(t);
          }}
          editable={!disabled && !sending}
          multiline
          placeholder={running ? '引导当前任务…' : '与 Hermes 对话'}
          placeholderTextColor={colors.placeholder}
          style={{
            color: colors.text,
            fontSize: 17,
            lineHeight: 23,
            minHeight: composerMinHeight(remeasure),
            maxHeight: 120,
            paddingTop: 10,
            paddingBottom: 2,
          }}
        />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="添加附件"
            onPress={onAttachPress}
            disabled={disabled || sending}
            hitSlop={6}
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              borderRadius: 17,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: pressed ? colors.raised : 'transparent',
            })}
          >
            <Icon sf="plus" size={15} color={disabled ? colors.textFaint : colors.text} />
          </Pressable>

          {modelName ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`模型：${modelName}，更换模型`}
              onPress={onModelPress}
              disabled={sending}
              hitSlop={6}
              style={({ pressed }) => ({
                paddingHorizontal: 13,
                height: 32,
                borderRadius: 16,
                justifyContent: 'center',
                backgroundColor: pressed ? colors.userBubble : colors.raised,
                maxWidth: 180,
                flexShrink: 1,
              })}
            >
              <Text numberOfLines={1} style={{ color: colors.text, fontSize: 14, fontWeight: '500' }}>
                {modelName}
              </Text>
            </Pressable>
          ) : null}

          <View style={{ flex: 1 }} />

          {running ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={stopping ? '正在停止回复' : '停止回复'}
                accessibilityState={{ disabled: !canStop, busy: stopping }}
                onPress={onStop}
                disabled={!canStop}
                hitSlop={6}
                style={({ pressed }) => ({
                  height: 36,
                  minWidth: 36,
                  paddingHorizontal: stopping ? 12 : 0,
                  borderRadius: 18,
                  borderCurve: 'continuous',
                  flexDirection: 'row',
                  gap: 6,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? colors.userBubble : colors.raised,
                  opacity: !canStop && !stopping ? 0.5 : 1,
                })}
              >
                {stopping ? (
                  <>
                    <ActivityIndicator size="small" color={colors.textDim} />
                    <Text style={{ color: colors.textDim, fontSize: 14, fontWeight: '500' }}>正在停止…</Text>
                  </>
                ) : (
                  <Icon sf="stop.fill" size={13} color={colors.text} />
                )}
              </Pressable>
              {hasText && !onQueue ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="发送引导消息"
                  accessibilityState={{ disabled: !canSteer }}
                  onPress={onSteer}
                  disabled={!canSteer}
                  hitSlop={6}
                  style={({ pressed }) => ({
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: canSteer ? (pressed ? colors.accentPressed : colors.accent) : colors.raised,
                  })}
                >
                  <Icon sf="arrow.up" size={16} color={canSteer ? colors.onAccent : colors.textFaint} />
                </Pressable>
              ) : null}
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送消息"
              accessibilityState={{ disabled: !canSend }}
              onPress={onSend}
              disabled={!canSend}
              hitSlop={6}
              style={({ pressed }) => ({
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: canSend ? (pressed ? colors.accentPressed : colors.accent) : colors.raised,
              })}
            >
              <Icon sf="arrow.up" size={16} color={canSend ? colors.onAccent : colors.textFaint} />
            </Pressable>
          )}
        </View>
        {running && onQueue ? (
          <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
            <Pressable accessibilityRole="button" accessibilityLabel="加入队列" disabled={!canQueue} onPress={onQueue} style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon sf="text.badge.plus" size={16} color={canQueue ? colors.text : colors.textFaint} />
              <Text style={{ color: canQueue ? colors.text : colors.textFaint, fontSize: 14 }}>加入队列</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="引导当前任务" disabled={!canSteer} onPress={onSteer} style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon sf="arrow.triangle.branch" size={16} color={canSteer ? colors.text : colors.textFaint} />
              <Text style={{ color: canSteer ? colors.text : colors.textFaint, fontSize: 14 }}>引导当前任务</Text>
            </Pressable>
            {sending ? <ActivityIndicator size="small" color={colors.textDim} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
