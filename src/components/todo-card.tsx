// src/components/todo-card.tsx
import { Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import type { TodoItem } from '@/lib/todo';
import { useTheme } from '@/theme';

type Colors = ReturnType<typeof useTheme>['colors'];

function TodoGlyph({ status, colors }: { status: TodoItem['status']; colors: Colors }) {
  if (status === 'completed') {
    return (
      <View style={{ paddingTop: 1 }}>
        <Icon sf="checkmark.circle.fill" size={14} color={colors.success} />
      </View>
    );
  }
  const ring = { width: 13, height: 13, borderRadius: 7, borderCurve: 'continuous' as const, marginTop: 3 };
  if (status === 'in_progress') return <View style={[ring, { borderWidth: 3.5, borderColor: colors.accent }]} />;
  if (status === 'cancelled') return <View style={[ring, { borderWidth: 1.5, borderColor: colors.textFaint }]} />;
  return <View style={[ring, { borderWidth: 1.5, borderColor: colors.textDim }]} />; // pending
}

export function TodoCard({ items }: { items: TodoItem[] }) {
  const { colors } = useTheme();
  const done = items.filter((t) => t.status === 'completed').length;
  return (
    <View style={{ paddingVertical: 4 }}>
      <View
        style={{
          backgroundColor: colors.raised,
          borderRadius: 14,
          borderCurve: 'continuous',
          paddingHorizontal: 12,
          paddingVertical: 9,
          gap: 8,
          alignSelf: 'stretch',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Icon sf="checklist" size={12} color={colors.accent} />
          <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>计划</Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: colors.textFaint, fontSize: 12, fontVariant: ['tabular-nums'] }}>
            {done}/{items.length}
          </Text>
        </View>
        <View style={{ gap: 6 }}>
          {items.map((t) => (
            <View key={t.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <TodoGlyph status={t.status} colors={colors} />
              <Text
                style={{
                  flex: 1,
                  color:
                    t.status === 'completed'
                      ? colors.textDim
                      : t.status === 'cancelled'
                        ? colors.textFaint
                        : colors.text,
                  fontSize: 13.5,
                  lineHeight: 19,
                  textDecorationLine: t.status === 'cancelled' ? 'line-through' : 'none',
                }}
              >
                {t.content}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
