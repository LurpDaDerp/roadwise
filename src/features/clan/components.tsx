/**
 * Clan building blocks: banner art, the screen top bar, a text field, the confirm dialog, and the
 * member / clan menu (view profile, report, block).
 */
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { Card, Divider, IconButton, ListRow, Pill, Sheet, Text, useTheme } from '@/ui';

import { profileHref } from '../leagues/routes';

import { useServerAction, type ClanRole, type ReportReason } from './api';
import { bannerArt } from './banners';
import { clanCopy } from './copy';
import { friendlyError, ROLE_LABEL } from './model';

// ---------------------------------------------------------------------------
// banner art
// ---------------------------------------------------------------------------

/** The clan's banner: its preset gradient, a big shield watermark, the name and a line under it. */
export function ClanBannerArt({
  banner,
  name,
  subtitle,
  children,
  compact = false,
  testID,
}: {
  banner: string;
  name: string;
  subtitle?: string;
  children?: ReactNode;
  compact?: boolean;
  testID?: string;
}) {
  const t = useTheme();
  const art = bannerArt(banner);
  return (
    <View
      testID={testID}
      style={{
        minHeight: compact ? 96 : 144,
        borderRadius: t.radius.card,
        borderCurve: 'continuous',
        overflow: 'hidden',
        padding: t.space.lg,
        justifyContent: 'flex-end',
        gap: t.space.xs,
        backgroundColor: art.face[1],
        boxShadow: t.elevation.raised,
      }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={art.face}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', right: -18, top: -14, opacity: 0.16, transform: [{ rotate: '12deg' }] }}
      >
        <Ionicons name="shield" size={compact ? 120 : 170} color={art.ink} />
      </View>
      <Text
        variant={compact ? 'title2' : 'title1'}
        accessibilityRole="header"
        numberOfLines={2}
        style={{ color: art.ink }}
      >
        {name}
      </Text>
      {subtitle ? (
        <Text variant="subhead" style={{ color: art.inkMuted }}>
          {subtitle}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** Leader and co-leader badges (a plain member shows none). Star glyphs, so not colour alone. */
export function RoleBadge({ role, accessible = false }: { role: ClanRole; accessible?: boolean }) {
  if (role === 'member') return null;
  return (
    <Pill
      label={ROLE_LABEL[role]}
      icon={role === 'leader' ? 'star' : 'star-half'}
      tone={role === 'leader' ? 'gold' : 'info'}
      accessible={accessible}
    />
  );
}

// ---------------------------------------------------------------------------
// top bar, text field, confirm
// ---------------------------------------------------------------------------

/** Title and Back for the pushed clan screens (the (app) stack shows no native header). */
export function TopBar({ title }: { title: string }) {
  const t = useTheme();
  const router = useRouter();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs, marginLeft: -t.space.sm }}>
      {router.canGoBack() ? (
        <IconButton icon="chevron-back" accessibilityLabel={clanCopy.back} onPress={() => router.back()} />
      ) : null}
      <Text variant="title2" accessibilityRole="header" style={{ flex: 1 }}>
        {title}
      </Text>
    </View>
  );
}

export function TextField({
  label,
  hint,
  error,
  testID,
  ...input
}: { label: string; hint?: string; error?: string | null; testID?: string } & Omit<TextInputProps, 'style'>) {
  const t = useTheme();
  const c = t.colors;
  return (
    <View style={{ gap: t.space.xs }}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        placeholderTextColor={c.textSubtle}
        selectionColor={c.accent}
        style={{
          minHeight: t.size.touchLg,
          paddingHorizontal: t.space.lg,
          borderRadius: t.radius.lg,
          borderCurve: 'continuous',
          borderWidth: 1.5,
          borderColor: error ? c.danger : c.borderStrong,
          backgroundColor: c.surface,
          color: c.text,
          fontSize: t.type.headline.fontSize,
        }}
        {...input}
      />
      {error ? (
        <View style={{ flexDirection: 'row', gap: t.space.xs, alignItems: 'center' }}>
          <Ionicons name="alert-circle" size={16} color={c.danger} />
          <Text variant="footnote" tone="danger" testID={testID ? `${testID}-error` : undefined} style={{ flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : hint ? (
        <Text variant="footnote" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** A native confirm dialog. Resolves true only on the confirm button. */
export function confirm(opts: { title: string; body: string; confirmLabel: string; destructive?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      opts.title,
      opts.body,
      [
        { text: clanCopy.manage.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: opts.confirmLabel, style: opts.destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

export function showError(err: unknown): void {
  Alert.alert(friendlyError(err));
}

// ---------------------------------------------------------------------------
// report + block menu
// ---------------------------------------------------------------------------

const REASONS: readonly ReportReason[] = ['inappropriate_name', 'harassment', 'cheating', 'impersonation', 'other'];

export type MenuTarget = { kind: 'user'; id: string; username: string } | { kind: 'clan'; id: string; name: string };

/**
 * The sheet behind a member row's long-press or "more" button: View profile, Report, Block.
 * For a clan it opens straight on the report reasons.
 */
export function TargetMenu({ target, onClose }: { target: MenuTarget | null; onClose: () => void }) {
  const t = useTheme();
  const router = useRouter();
  const [step, setStep] = useState<'menu' | 'report'>('menu');
  const block = useServerAction<{ p_user_id: string }>('block_user');
  const report = useServerAction<{ p_kind: string; p_target_id: string; p_reason: ReportReason; p_note: string }>(
    'report_target'
  );
  const busy = block.isPending || report.isPending;

  const close = () => {
    setStep('menu');
    onClose();
  };
  if (!target) return null;
  const name = target.kind === 'user' ? target.username : target.name;
  const showReasons = step === 'report' || target.kind === 'clan';
  const reasonCopy = target.kind === 'clan' ? clanCopy.clanReasons : clanCopy.reasons;

  const onBlock = async () => {
    if (target.kind !== 'user') return;
    const ok = await confirm({
      title: clanCopy.menu.blockTitle(target.username),
      body: clanCopy.menu.blockBody,
      confirmLabel: clanCopy.menu.block,
      destructive: true,
    });
    if (!ok) return;
    try {
      await block.mutateAsync({ p_user_id: target.id });
      close();
    } catch (err) {
      showError(err);
    }
  };

  const onReport = async (reason: ReportReason) => {
    try {
      await report.mutateAsync({ p_kind: target.kind, p_target_id: target.id, p_reason: reason, p_note: '' });
      close();
      Alert.alert(clanCopy.menu.reported);
    } catch (err) {
      showError(err);
    }
  };

  const rows: { key: string; title: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void; danger?: boolean }[] =
    showReasons
      ? REASONS.map((r) => ({ key: r, title: reasonCopy[r], icon: 'flag-outline', onPress: () => void onReport(r) }))
      : [
          {
            key: 'profile',
            title: clanCopy.menu.viewProfile,
            icon: 'person-circle-outline',
            onPress: () => {
              close();
              if (target.kind === 'user') router.push(profileHref(target.username));
            },
          },
          { key: 'report', title: clanCopy.menu.report, icon: 'flag-outline', onPress: () => setStep('report') },
          { key: 'block', title: clanCopy.menu.block, icon: 'ban-outline', onPress: () => void onBlock(), danger: true },
        ];

  return (
    <Sheet
      visible
      onClose={close}
      title={showReasons ? clanCopy.menu.reportTitle(name) : name}
      testID="target-menu"
    >
      {showReasons ? (
        <Text variant="callout" tone="muted">
          {clanCopy.menu.reportLead}
        </Text>
      ) : null}
      <Card padded={false} variant="raised">
        {rows.map((r, i) => (
          <View key={r.key}>
            {i > 0 ? <Divider inset={16} /> : null}
            <ListRow
              title={r.title}
              leading={<Ionicons name={r.icon} size={t.size.icon} color={r.danger ? t.colors.danger : t.colors.accent} />}
              onPress={busy ? undefined : r.onPress}
              accessory="none"
              testID={`menu-${r.key}`}
            />
          </View>
        ))}
      </Card>
    </Sheet>
  );
}
