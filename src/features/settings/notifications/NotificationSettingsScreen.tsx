import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';

import type { NotificationAccess, PermissionsAdapter } from '@/core/permissions';
import type { AppStateLike } from '@/data/foreground';
import { SERVER_SLOW_STALE_MS, serverKey, useServerQuery } from '@/data/server/useServerQuery';
import { useSession } from '@/data/supabase/session';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { Banner, Card, Divider, Screen, Skeleton, Text, ToggleRow, useTheme } from '@/ui';

import { TopBar } from '../parts';
import { currentZone, PREFS_KEY, savePrefs, type NotificationPrefs, type PrefsPatch } from './api';
import { notificationSettingsCopy as copy } from './copy';

/** The OS side: whether RoadWise may notify at all, and the two ways to fix it. */
export interface OsNotificationsPort {
  read(): Promise<NotificationAccess | null>;
  request(): Promise<NotificationAccess>;
  openSettings(): Promise<void>;
}

export interface NotificationSettingsDeps {
  os?: OsNotificationsPort;
  appState?: AppStateLike;
  zone?: () => string;
}

function adapterPort(adapter: PermissionsAdapter): OsNotificationsPort {
  return {
    read: () =>
      adapter
        .snapshot()
        .then((s) => s.notifications)
        .catch(() => null),
    request: () => adapter.requestNotifications(),
    openSettings: () => adapter.openAppSettings(),
  };
}

/** `22:00` → `10 PM`, `06:30` → `6:30 AM`. */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** One whole hour earlier or later, wrapping at midnight; a half hour steps to its whole hour. */
export function stepHour(hhmm: string, dir: -1 | 1): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const next = dir === 1 ? h + 1 : m > 0 ? h : h - 1;
  return `${String((next + 24) % 24).padStart(2, '0')}:00`;
}

const KINDS = ['weekly_recap', 'leagues', 'social'] as const;

function useOsAccess(os: OsNotificationsPort, appState: AppStateLike) {
  const [access, setAccess] = useState<NotificationAccess | null>(null);
  const read = useCallback(() => {
    void os.read().then(setAccess, () => setAccess(null));
  }, [os]);
  useEffect(() => {
    read();
    const sub = appState.addEventListener('change', (next) => {
      if (next === 'active') read();
    });
    return () => sub.remove();
  }, [appState, read]);
  return { access, read };
}

/**
 * `/settings/notifications`: weekly recap, league results and friend requests, quiet hours, and
 * what the phone itself allows. Every change saves as it is made and shows as made while it saves;
 * a failure puts it back and says so.
 */
export function NotificationSettingsScreen({ deps = {} }: { deps?: NotificationSettingsDeps }) {
  const th = useTheme();
  const qc = useQueryClient();
  const uid = useSession().session?.user.id ?? null;
  const query = useServerQuery<NotificationPrefs>([...PREFS_KEY], 'get_notification_prefs', undefined, {
    staleMs: SERVER_SLOW_STALE_MS,
  });
  const [pending, setPending] = useState<PrefsPatch | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [os] = useState(() => deps.os ?? adapterPort(defaultPermissionsAdapter()));
  const { access, read } = useOsAccess(os, deps.appState ?? AppState);
  const zone = (deps.zone ?? currentZone)();

  const save = async (patch: PrefsPatch) => {
    if (pending) return;
    setPending(patch);
    setSaveFailed(false);
    try {
      const next = await savePrefs(patch, zone);
      qc.setQueryData(serverKey(uid, ...PREFS_KEY), next);
    } catch {
      setSaveFailed(true);
    } finally {
      setPending(null);
    }
  };

  const prefs = query.data ? { ...query.data, ...pending } : null;
  const saving = pending !== null;

  let body;
  if (!prefs) {
    body = query.isError ? (
      <Banner
        testID="prefs-load-error"
        tone="danger"
        message={copy.loadError}
        action={{ label: copy.retry, onPress: () => void query.refetch() }}
      />
    ) : (
      <Card testID="prefs-loading">
        <Skeleton width="45%" height={18} />
        <Skeleton width="80%" height={14} />
      </Card>
    );
  } else {
    const quietOff = prefs.quiet_start === prefs.quiet_end;
    body = (
      <>
        <View style={{ gap: th.space.sm }}>
          <Text variant="headline" accessibilityRole="header">
            {copy.send}
          </Text>
          <Card padded={false} testID="prefs-kinds">
            {KINDS.map((k, i) => (
              <View key={k}>
                {i > 0 ? <Divider inset={th.space.lg} /> : null}
                <ToggleRow
                  testID={`prefs-${k}`}
                  title={copy.kinds[k].title}
                  subtitle={prefs[k] ? copy.kinds[k].on : copy.kinds[k].off}
                  value={prefs[k]}
                  disabled={saving}
                  onValueChange={(next) => void save({ [k]: next })}
                />
              </View>
            ))}
          </Card>
        </View>

        <View style={{ gap: th.space.sm }}>
          <Text variant="headline" accessibilityRole="header">
            {copy.quiet.title}
          </Text>
          <Card padded={false} testID="prefs-quiet">
            <ToggleRow
              testID="prefs-quiet-toggle"
              title={copy.quiet.title}
              subtitle={
                prefs.quiet_enabled && !quietOff
                  ? copy.quiet.on(clockLabel(prefs.quiet_start), clockLabel(prefs.quiet_end))
                  : prefs.quiet_enabled
                    ? copy.quiet.same
                    : copy.quiet.off
              }
              value={prefs.quiet_enabled}
              disabled={saving}
              onValueChange={(next) => void save({ quiet_enabled: next })}
            />
            {prefs.quiet_enabled ? (
              <>
                <Divider inset={th.space.lg} />
                <HourRow
                  testID="prefs-quiet-start"
                  label={copy.quiet.starts}
                  value={prefs.quiet_start}
                  disabled={saving}
                  onChange={(v) => void save({ quiet_start: v })}
                />
                <Divider inset={th.space.lg} />
                <HourRow
                  testID="prefs-quiet-end"
                  label={copy.quiet.ends}
                  value={prefs.quiet_end}
                  disabled={saving}
                  onChange={(v) => void save({ quiet_end: v })}
                />
              </>
            ) : null}
          </Card>
          <Text variant="footnote" tone="muted" testID="prefs-zone">
            {copy.quiet.zone(zone.replace(/_/g, ' '))}
          </Text>
        </View>
      </>
    );
  }

  return (
    <Screen scroll testID="notification-settings">
      <TopBar title={copy.title} />
      {access === 'denied' ? (
        <Banner
          testID="prefs-os-denied"
          tone="warning"
          message={copy.os.denied}
          action={{ label: copy.os.openSettings, onPress: () => void os.openSettings().catch(() => undefined) }}
        />
      ) : access === 'undetermined' ? (
        <Banner
          testID="prefs-os-undetermined"
          tone="info"
          message={copy.os.undetermined}
          action={{ label: copy.os.allow, onPress: () => void os.request().then(read, read) }}
        />
      ) : null}
      {saveFailed ? <Banner testID="prefs-save-error" tone="warning" message={copy.saveError} /> : null}
      {body}
    </Screen>
  );
}

/** An hour with earlier/later steps; one adjustable element for a screen reader. */
function HourRow({
  label,
  value,
  disabled,
  onChange,
  testID,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  testID: string;
}) {
  const th = useTheme();
  const shown = clockLabel(value);
  const step = (dir: -1 | 1) => {
    if (!disabled) onChange(stepHour(value, dir));
  };
  const button = (dir: -1 | 1) => (
    <Pressable
      testID={`${testID}-${dir === 1 ? 'later' : 'earlier'}`}
      accessibilityRole="button"
      accessibilityLabel={dir === 1 ? copy.quiet.later(label) : copy.quiet.earlier(label)}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => step(dir)}
      style={({ pressed }) => ({
        width: th.size.touch,
        height: th.size.touch,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: th.radius.pill,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Ionicons name={dir === 1 ? 'chevron-forward' : 'chevron-back'} size={th.size.icon} color={th.colors.accent} />
    </Pressable>
  );
  return (
    <View
      testID={`${testID}-row`}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: shown }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm, paddingVertical: th.space.xs, paddingHorizontal: th.space.lg }}
    >
      <Text variant="body" style={{ flex: 1 }}>
        {label}
      </Text>
      {button(-1)}
      <Text testID={`${testID}-value`} variant="headline" style={{ minWidth: 84, textAlign: 'center', fontVariant: ['tabular-nums'] }}>
        {shown}
      </Text>
      {button(1)}
    </View>
  );
}
