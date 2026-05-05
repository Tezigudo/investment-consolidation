import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View, Text, Pressable } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { queryClient } from '@/hooks/queryClient';
import { colors, radius, spacing, typography } from '@/theme/tokens';

// Face ID gate. Skips on simulators (no biometric hardware) so dev
// stays smooth. Re-locks on cold start only — no background timeout
// because a portfolio app you check 20x/day shouldn't punish you.
function useBiometricGate() {
  const [unlocked, setUnlocked] = useState(false);
  const [needsAuth, setNeedsAuth] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const has = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!has || !enrolled) {
        setNeedsAuth(false);
        setUnlocked(true);
        return;
      }
      setNeedsAuth(true);
    })();
  }, []);

  const auth = async () => {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Consolidate',
      fallbackLabel: 'Use passcode',
    });
    if (r.success) setUnlocked(true);
  };

  // Auto-prompt once we know auth is required.
  useEffect(() => {
    if (needsAuth) auth();
  }, [needsAuth]);

  return { unlocked, retry: auth, needsAuth };
}

function GateScreen({ retry }: { retry: () => void }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.xl,
      }}
    >
      <Text style={{ ...typography.h1, color: colors.text, marginBottom: spacing.md }}>
        Consolidate
      </Text>
      <Text
        style={{
          ...typography.body,
          color: colors.textMuted,
          textAlign: 'center',
          marginBottom: spacing.xl,
        }}
      >
        Unlock with Face ID to view your portfolio.
      </Text>
      <Pressable
        onPress={retry}
        style={{
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.md,
          backgroundColor: colors.accent,
          borderRadius: radius.md,
        }}
      >
        <Text style={{ ...typography.bodyMedium, color: '#0b0d11' }}>Unlock</Text>
      </Pressable>
    </View>
  );
}

export default function RootLayout() {
  const { unlocked, retry, needsAuth } = useBiometricGate();

  if (needsAuth === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          {unlocked ? (
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerTintColor: colors.text,
                contentStyle: { backgroundColor: colors.bg },
                headerShadowVisible: false,
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen
                name="position/[symbol]"
                options={{ title: '', presentation: 'card' }}
              />
            </Stack>
          ) : (
            <GateScreen retry={retry} />
          )}
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
