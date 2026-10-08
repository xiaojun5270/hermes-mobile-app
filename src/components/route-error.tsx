import { Pressable, Text, View } from 'react-native';
import { useTheme } from '@/theme';

/** Per-route error boundary view (expo-router renders this on render crashes). */
export function RouteError({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14, backgroundColor: colors.bg }}>
      <Text style={{ color: colors.text, fontSize: 19, fontWeight: '700' }}>出现问题</Text>
      <Text selectable style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>
        {error.message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="重试"
        onPress={retry}
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.accentPressed : colors.accent,
          borderRadius: 999,
          paddingHorizontal: 24,
          paddingVertical: 12,
        })}
      >
        <Text style={{ color: colors.onAccent, fontSize: 15.5, fontWeight: '600' }}>重试</Text>
      </Pressable>
    </View>
  );
}
