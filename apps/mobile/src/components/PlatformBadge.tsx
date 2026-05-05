import { Text, View } from 'react-native';
import type { Platform } from '@consolidate/shared';
import { colors, radius, spacing, typography } from '@/theme/tokens';

const LABEL: Record<Platform, string> = {
  DIME: 'DIME',
  Binance: 'Binance',
  Bank: 'Bank',
  OnChain: 'On-chain',
};

export function PlatformBadge({ platform }: { platform: Platform }) {
  const tint = colors.platform[platform];
  return (
    <View
      style={{
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderRadius: radius.sm,
        backgroundColor: tint + '22',
        borderWidth: 1,
        borderColor: tint + '55',
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ ...typography.micro, color: tint, textTransform: 'uppercase' }}>
        {LABEL[platform]}
      </Text>
    </View>
  );
}
