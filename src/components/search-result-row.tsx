import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { parseSnippet, type SearchResult } from '@/api/search';
import { timeAgo } from '@/lib/format';
import { useTheme } from '@/theme';

/** A full-text search hit: snippet with highlighted matches + session meta. */
export const SearchResultRow = memo(function SearchResultRow({
  hit,
  title,
  onPress,
}: {
  hit: SearchResult;
  /** Known session title, when the session is already loaded locally. */
  title?: string | null;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const segments = parseSnippet(hit.snippet ?? '');
  const heading = title?.trim() || '会话';
  const meta = [hit.role, hit.source].filter(Boolean).join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`搜索结果所在会话：${heading}`}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 3,
        backgroundColor: pressed ? colors.raised : 'transparent',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text
          numberOfLines={1}
          style={{ flex: 1, color: colors.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 }}
        >
          {heading}
        </Text>
        {hit.session_started ? (
          <Text style={{ color: colors.textFaint, fontSize: 13, fontVariant: ['tabular-nums'] }}>
            {timeAgo(hit.session_started)}
          </Text>
        ) : null}
      </View>
      {segments.length > 0 ? (
        <Text numberOfLines={2} style={{ color: colors.textDim, fontSize: 14.5 }}>
          {segments.map((seg, i) =>
            seg.match ? (
              <Text key={i} style={{ color: colors.accent, fontWeight: '600' }}>
                {seg.text}
              </Text>
            ) : (
              <Text key={i}>{seg.text}</Text>
            ),
          )}
        </Text>
      ) : null}
      {meta ? (
        <Text style={{ color: colors.textFaint, fontSize: 12.5 }}>{meta}</Text>
      ) : null}
    </Pressable>
  );
});
