import { Pressable, ScrollView, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radius, spacing, typography } from '@/theme/tokens';

interface Props<T extends string> {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
}

export function FilterPills<T extends string>({ value, options, onChange }: Props<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        gap: spacing.sm,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => {
              if (!active) {
                Haptics.selectionAsync();
                onChange(opt.value);
              }
            }}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm - 2,
              borderRadius: radius.lg,
              backgroundColor: active ? colors.text : 'transparent',
              borderWidth: 1,
              borderColor: active ? colors.text : colors.border,
            }}
          >
            <Text
              style={{
                ...typography.caption,
                color: active ? colors.bg : colors.text,
                fontWeight: active ? '600' : '500',
              }}
            >
              {opt.label}
              {opt.count != null ? ` ${opt.count}` : ''}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
