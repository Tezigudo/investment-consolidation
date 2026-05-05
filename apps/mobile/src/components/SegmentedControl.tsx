import { Pressable, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radius, spacing, typography } from '@/theme/tokens';

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
}

export function SegmentedControl<T extends string>({ value, options, onChange }: Props<T>) {
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        padding: 3,
        borderWidth: 1,
        borderColor: colors.border,
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
              flex: 1,
              paddingVertical: spacing.sm - 2,
              paddingHorizontal: spacing.md,
              borderRadius: radius.sm,
              backgroundColor: active ? colors.bgCard : 'transparent',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                ...typography.caption,
                color: active ? colors.text : colors.textMuted,
                fontWeight: active ? '600' : '400',
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
