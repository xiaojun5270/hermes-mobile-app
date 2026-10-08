// src/app/memory-file.tsx
//
// Viewer/editor for one built-in memory file (MEMORY.md or USER.md), reached
// from the Memory screen as /memory-file?name=MEMORY.md. Backed by the
// hermes-mobile plugin's /api/plugins/mobile/memory/files routes: GET for the
// whole file, PUT {content} for an atomic replace (≤ 256 KiB → 413 above).
//
// View mode renders the markdown; Edit switches to a monospace multiline
// input. Leaving with unsaved changes (Cancel, header back) asks for
// confirmation before discarding; the back swipe is off while there are any.
import { Stack, router, useLocalSearchParams } from 'expo-router';
// Deprecated in SDK 56 ("copy the helper into your codebase"), with no numeric successor:
// useAnimatedHeaderHeight is an Animated.Value, which keyboardVerticalOffset cannot take.
// Revisit on the next SDK bump.
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  formatBytes,
  isMemoryFileName,
  memoryFileLabel,
  memoryFileTooLarge,
  memoryWriteErrorMessage,
  readMemoryFile,
  utf8ByteLength,
  writeMemoryFile,
  MEMORY_FILE_MAX_BYTES,
  type MemoryFileName,
} from '@/api/memory';
import { AuthError } from '@/api/restClient';
import { useDiscardGuard } from '@/components/discard-guard';
import { Icon } from '@/components/icon';
import { MarkdownView } from '@/components/markdown-view';
import { withAuthRetry } from '@/connection';
import { useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

const DISCARD_MESSAGE = '此文件有尚未保存的修改。';

function HeaderButton({
  label,
  bold,
  disabled,
  onPress,
}: {
  label: string;
  bold?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ paddingHorizontal: 6, paddingVertical: 10, opacity: disabled ? 0.4 : pressed ? 0.5 : 1 })}
    >
      <Text style={{ color: colors.accent, fontSize: 17, fontWeight: bold ? '600' : '400' }}>{label}</Text>
    </Pressable>
  );
}

export default function MemoryFileScreen() {
  const { colors } = useTheme();
  const headerHeight = useHeaderHeight();
  const { bottom: bottomInset } = useSafeAreaInsets();
  const params = useLocalSearchParams<{ name?: string }>();
  const rawName = typeof params.name === 'string' ? params.name : '';
  const name: MemoryFileName | null = isMemoryFileName(rawName) ? rawName : null;

  const [content, setContent] = useState<string | null>(null); // null = not loaded yet
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // true until the first fetch settles: the RefreshControl spins on first load.
  const [refreshing, setRefreshing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const dirty = editing && content != null && draft !== content;

  // An expired session sends you to sign in. Unsaved edits are dropped first and the replace runs
  // from an effect of the commit where they are gone, so the discard guard's listener can never
  // see a stale `dirty` and intercept it ("Discard changes?" before login, where Keep editing
  // leaves you on a dead session).
  const toSignIn = useCallback(() => {
    setEditing(false);
    setSignedOut(true);
  }, []);
  useEffect(() => {
    if (signedOut) router.replace('/');
  }, [signedOut]);

  // Every setter runs in a promise callback, never synchronously on the mount
  // effect's path. `refresh` (pull-to-refresh) raises the spinner and clears
  // the error itself before calling this.
  const fetchFile = useCallback(() => {
    if (!name) return Promise.resolve();
    return withAuthRetry((r) => readMemoryFile(r, name))
      .then((res) => {
        setContent(res.content);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof AuthError) {
          toSignIn();
          return;
        }
        setError(memoryWriteErrorMessage(e));
      })
      .finally(() => setRefreshing(false));
  }, [name, toSignIn]);

  useEffect(() => {
    void fetchFile();
  }, [fetchFile]);

  function refresh() {
    setRefreshing(true);
    setError(null);
    void fetchFile();
  }

  // Header back / router.back with unsaved edits asks first (see discard-guard for why it must
  // be usePreventRemove, not a bare beforeRemove listener).
  useDiscardGuard(dirty, DISCARD_MESSAGE);

  function startEditing() {
    if (content == null) return;
    setDraft(content);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    if (!dirty) {
      setEditing(false);
      setError(null);
      return;
    }
    Alert.alert('放弃修改？', DISCARD_MESSAGE, [
      { text: '继续编辑', style: 'cancel' },
      {
        text: '放弃修改',
        style: 'destructive',
        onPress: () => {
          setEditing(false);
          setError(null);
        },
      },
    ]);
  }

  async function save() {
    if (!name || saving) return;
    if (memoryFileTooLarge(draft)) {
      setError(
        `文件过大，${formatBytes(utf8ByteLength(draft))} 超过 ${formatBytes(MEMORY_FILE_MAX_BYTES)} 限制。`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await withAuthRetry((r) => writeMemoryFile(r, name, draft));
      setContent(draft);
      setEditing(false);
    } catch (e) {
      if (e instanceof AuthError) {
        toSignIn();
        return;
      }
      setError(memoryWriteErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const title = name ? memoryFileLabel(name) : '记忆文件';
  const draftBytes = editing ? utf8ByteLength(draft) : 0;
  const overCap = editing && draftBytes > MEMORY_FILE_MAX_BYTES;

  return (
    <KeyboardAvoidingView
      testID="memory-file-keyboard-avoider"
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}
      // It compares its parent-relative frame with the keyboard's screen Y, and this screen's
      // content starts below the native header: without the offset the last lines, the caret and
      // the size counter sit behind the keyboard. Less the home-indicator inset, which the size
      // counter already pads and the keyboard covers: no gap above the keyboard.
      keyboardVerticalOffset={headerHeight - bottomInset}
    >
      <Stack.Screen
        options={{
          title,
          gestureEnabled: !dirty,
          headerRight: () =>
            !name || content == null ? null : editing ? (
              <View style={{ flexDirection: 'row', gap: 4 }}>
                <HeaderButton label="取消" disabled={saving} onPress={cancelEditing} />
                <HeaderButton label={saving ? '正在保存…' : '保存'} bold disabled={saving || !dirty} onPress={save} />
              </View>
            ) : (
              <HeaderButton label="编辑" onPress={startEditing} />
            ),
        }}
      />

      {!name ? (
        <View style={{ alignItems: 'center', gap: 14, paddingTop: 96, paddingHorizontal: 32 }}>
          <Icon sf="questionmark.folder" size={44} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>未知文件</Text>
          <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>

            这里只能打开 MEMORY.md 和 USER.md。
          </Text>
        </View>
      ) : editing ? (
        <View style={{ flex: 1 }}>
          {error ? (
            <Text selectable style={{ color: colors.danger, fontSize: 14, paddingHorizontal: 20, paddingTop: 12 }}>
              {error}
            </Text>
          ) : null}
          <TextInput
            accessibilityLabel={`${title}内容`}
            multiline
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            value={draft}
            onChangeText={setDraft}
            editable={!saving}
            style={{
              flex: 1,
              color: colors.text,
              fontFamily: 'Menlo',
              fontSize: 13.5,
              lineHeight: 19,
              paddingHorizontal: 20,
              paddingTop: 12,
              paddingBottom: 12,
            }}
          />
          <Text
            accessibilityLabel={`文件大小 ${formatBytes(draftBytes)}，上限 ${formatBytes(MEMORY_FILE_MAX_BYTES)}`}
            style={{
              color: overCap ? colors.danger : colors.textFaint,
              fontSize: 12,
              textAlign: 'right',
              paddingHorizontal: 20,
              paddingTop: 6,
              paddingBottom: 6 + bottomInset, // clear of the home indicator
            }}
          >
            {`${formatBytes(draftBytes)} / ${formatBytes(MEMORY_FILE_MAX_BYTES)}`}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textDim} />}
        >
          {error ? (
            <Text selectable style={{ color: colors.danger, fontSize: 14, marginBottom: 12 }}>
              {error}
            </Text>
          ) : null}
          {content == null ? (
            !error ? (
              <Text style={{ color: colors.textFaint, fontSize: 14, textAlign: 'center', paddingTop: 48 }}>

                正在加载…
              </Text>
            ) : null
          ) : content.trim() === '' ? (
            <View style={{ alignItems: 'center', gap: 14, paddingTop: 72, paddingHorizontal: 16 }}>
              <Icon sf="doc.text" size={40} color={colors.textFaint} />
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>暂无内容</Text>
              <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>

                智能体会在对话中填写，也可以自行编辑。
              </Text>
            </View>
          ) : (
            <MarkdownView text={content} />
          )}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
