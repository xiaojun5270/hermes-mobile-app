import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/theme';

/** Android stand-in for Alert.prompt (iOS-only API). Mount fresh per use —
 * the input state initializes from `initialValue` once. */
export function PromptDialog({
  visible,
  title,
  initialValue,
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  const [value, setValue] = useState(initialValue);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.45)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 28,
        }}
        onPress={onCancel}
      >
        <Pressable
          onPress={() => {}}
          style={{
            alignSelf: 'stretch',
            backgroundColor: colors.surface,
            borderRadius: 16,
            borderCurve: 'continuous',
            padding: 18,
            gap: 12,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>{title}</Text>
          <TextInput
            autoFocus
            defaultValue={initialValue}
            onChangeText={setValue}
            onSubmitEditing={() => onSubmit(value)}
            style={{
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 8,
              color: colors.text,
              fontSize: 16,
            }}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 18 }}>
            <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8}>
              <Text style={{ color: colors.textDim, fontSize: 16 }}>取消</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => onSubmit(value)} hitSlop={8}>
              <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>保存</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
