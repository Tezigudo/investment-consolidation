import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { api } from '@/api/client';
import { getApiUrl, setApiUrl, getApiToken, setApiToken } from '@/api/baseUrl';
import { Card } from '@/components/Card';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useCostView } from '@/hooks/useCostView';
import { fmtAge } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme/tokens';

function SyncRow({
  label,
  status,
  busy,
  onSync,
  disabled,
  hint,
}: {
  label: string;
  status: string;
  busy: boolean;
  onSync: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <View
      style={{
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ flex: 1, paddingRight: spacing.md }}>
          <Text style={{ ...typography.bodyMedium, color: colors.text }}>{label}</Text>
          <Text style={{ ...typography.caption, color: colors.textMuted, marginTop: 2 }}>
            {status}
          </Text>
        </View>
        <Pressable
          disabled={disabled || busy}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onSync();
          }}
          style={{
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            borderRadius: radius.md,
            backgroundColor: disabled ? colors.bgElevated : colors.accent,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? (
            <ActivityIndicator color={colors.bg} size="small" />
          ) : (
            <Text style={{ ...typography.caption, color: disabled ? colors.textMuted : colors.bg, fontWeight: '600' }}>
              Sync
            </Text>
          )}
        </Pressable>
      </View>
      {hint ? (
        <Text style={{ ...typography.caption, color: colors.textDim, marginTop: spacing.xs }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export default function SettingsScreen() {
  const qc = useQueryClient();
  const [costView, setCostView] = useCostView();
  const [serverInput, setServerInput] = useState('');
  const [savedUrl, setSavedUrl] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [savedToken, setSavedToken] = useState('');

  useEffect(() => {
    getApiUrl().then((u) => {
      setSavedUrl(u);
      setServerInput(u);
    });
    getApiToken().then((t) => {
      setSavedToken(t);
      setTokenInput(t);
    });
  }, []);

  const binance = useQuery({
    queryKey: ['binanceStatus'],
    queryFn: api.binanceStatus,
    refetchInterval: 30_000,
  });
  const dimeMail = useQuery({
    queryKey: ['dimeMailStatus'],
    queryFn: api.dimeMailStatus,
    refetchInterval: 30_000,
  });
  const onchain = useQuery({
    queryKey: ['onchainStatus'],
    queryFn: api.onchainStatus,
    refetchInterval: 30_000,
  });

  const [busy, setBusy] = useState<'binance' | 'dimeMail' | 'onchain' | null>(null);

  const runSync = async (kind: 'binance' | 'dimeMail' | 'onchain') => {
    setBusy(kind);
    try {
      if (kind === 'binance') await api.binanceSync();
      else if (kind === 'dimeMail') await api.dimeMailSync();
      else if (kind === 'onchain') await api.onchainSync();
      await qc.invalidateQueries();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Sync failed', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveServer = async () => {
    await setApiUrl(serverInput);
    setSavedUrl(serverInput);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    qc.invalidateQueries();
  };

  const saveToken = async () => {
    await setApiToken(tokenInput);
    setSavedToken(tokenInput);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    qc.invalidateQueries();
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
    >
      <Card style={{ marginBottom: spacing.lg }}>
        <Text
          style={{
            ...typography.micro,
            color: colors.textDim,
            textTransform: 'uppercase',
            marginBottom: spacing.md,
          }}
        >
          Server
        </Text>
        <Text style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing.sm }}>
          API base URL — must be reachable from this device on the LAN.
        </Text>
        <TextInput
          value={serverInput}
          onChangeText={setServerInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.1.42:4000"
          placeholderTextColor={colors.textDim}
          style={{
            backgroundColor: colors.bgElevated,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            color: colors.text,
            marginBottom: spacing.sm,
            ...typography.mono,
          }}
        />
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Pressable
            onPress={saveServer}
            disabled={!serverInput.trim() || serverInput === savedUrl}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              backgroundColor:
                !serverInput.trim() || serverInput === savedUrl
                  ? colors.bgElevated
                  : colors.accent,
              borderRadius: radius.md,
            }}
          >
            <Text
              style={{
                ...typography.caption,
                color: !serverInput.trim() || serverInput === savedUrl ? colors.textMuted : colors.bg,
                fontWeight: '600',
              }}
            >
              Save
            </Text>
          </Pressable>
        </View>
      </Card>

      <Card style={{ marginBottom: spacing.lg }}>
        <Text
          style={{
            ...typography.micro,
            color: colors.textDim,
            textTransform: 'uppercase',
            marginBottom: spacing.md,
          }}
        >
          API auth token
        </Text>
        <Text style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing.sm }}>
          Required by the deployed API. Same value as the API_AUTH_TOKEN env on Fly.
        </Text>
        <TextInput
          value={tokenInput}
          onChangeText={setTokenInput}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="paste 64-char token"
          placeholderTextColor={colors.textDim}
          style={{
            backgroundColor: colors.bgElevated,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            color: colors.text,
            marginBottom: spacing.sm,
            ...typography.mono,
          }}
        />
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Pressable
            onPress={saveToken}
            disabled={tokenInput === savedToken}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              backgroundColor:
                tokenInput === savedToken ? colors.bgElevated : colors.accent,
              borderRadius: radius.md,
            }}
          >
            <Text
              style={{
                ...typography.caption,
                color: tokenInput === savedToken ? colors.textMuted : colors.bg,
                fontWeight: '600',
              }}
            >
              Save
            </Text>
          </Pressable>
        </View>
      </Card>

      <Card style={{ marginBottom: spacing.lg }}>
        <Text
          style={{
            ...typography.micro,
            color: colors.textDim,
            textTransform: 'uppercase',
            marginBottom: spacing.md,
          }}
        >
          Default cost view
        </Text>
        <SegmentedControl
          value={costView}
          onChange={setCostView}
          options={[
            { value: 'standard', label: 'Avg cost' },
            { value: 'dime', label: 'DIME view' },
          ]}
        />
        <Text style={{ ...typography.caption, color: colors.textDim, marginTop: spacing.sm }}>
          DIME view shows avg cost as net-cash-invested per share (matches what the DIME app shows).
        </Text>
      </Card>

      <Card>
        <Text
          style={{
            ...typography.micro,
            color: colors.textDim,
            textTransform: 'uppercase',
            marginBottom: spacing.sm,
          }}
        >
          Data sources
        </Text>

        <SyncRow
          label="Binance"
          status={
            !binance.data?.enabled
              ? 'Disabled (no API key)'
              : binance.data.running
                ? 'Syncing…'
                : `Last sync ${fmtAge(binance.data.lastSyncTs ?? null)}`
          }
          busy={busy === 'binance' || !!binance.data?.running}
          disabled={!binance.data?.enabled}
          onSync={() => runSync('binance')}
        />

        <SyncRow
          label="DIME mail"
          status={
            !dimeMail.data?.enabled
              ? 'Disabled (no Gmail credentials)'
              : !dimeMail.data.authed
                ? 'Run `bun run import:dime-mail -- --auth` once'
                : dimeMail.data.running
                  ? 'Syncing…'
                  : `Last sync ${fmtAge(dimeMail.data.lastSyncTs ?? null)}`
          }
          busy={busy === 'dimeMail' || !!dimeMail.data?.running}
          disabled={!dimeMail.data?.enabled || !dimeMail.data?.authed}
          onSync={() => runSync('dimeMail')}
          hint={dimeMail.data?.pdfPasswordSet === false ? 'PDF password not set in .env' : undefined}
        />

        <SyncRow
          label="On-chain (WLD)"
          status={
            !onchain.data?.enabled
              ? 'Disabled (no wallet)'
              : `Wallet ${onchain.data.wallet?.slice(0, 6)}…${onchain.data.wallet?.slice(-4)} · ${onchain.data.vaults.length} vault(s)`
          }
          busy={busy === 'onchain'}
          disabled={!onchain.data?.enabled}
          onSync={() => runSync('onchain')}
        />
      </Card>
    </ScrollView>
  );
}
