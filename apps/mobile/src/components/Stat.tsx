import { Text, View } from 'react-native';
import { colors, spacing, typography } from '@/theme/tokens';

interface Props {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'pos' | 'neg' | 'muted';
  align?: 'left' | 'right';
}

const toneColor: Record<NonNullable<Props['tone']>, string> = {
  default: colors.text,
  pos: colors.green,
  neg: colors.red,
  muted: colors.textMuted,
};

export function Stat({ label, value, sub, tone = 'default', align = 'left' }: Props) {
  return (
    <View style={{ alignItems: align === 'right' ? 'flex-end' : 'flex-start' }}>
      <Text style={{ ...typography.micro, color: colors.textDim, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <Text
        style={{
          ...typography.h2,
          ...typography.mono,
          color: toneColor[tone],
          marginTop: spacing.xs,
        }}
      >
        {value}
      </Text>
      {sub ? (
        <Text
          style={{
            ...typography.caption,
            ...typography.mono,
            color: colors.textMuted,
            marginTop: 2,
          }}
        >
          {sub}
        </Text>
      ) : null}
    </View>
  );
}
