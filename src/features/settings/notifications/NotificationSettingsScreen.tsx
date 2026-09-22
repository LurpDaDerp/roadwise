import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Switch, View } from 'react-native';

import { recordPrompt, type NotificationAccess, type PermissionsAdapter } from '@/core/permissions';
import { createSettingsRepo } from '@/data/db/settings';
import { useDriveStateReported } from '@/data/devices/driveStateStore';
import type { AppStateLike } from '@/data/foreground';
import { useDataSource } from '@/data/queries';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { ICON, TOUCH } from '@/features/trips/layout';
import { TripTopBar } from '@/features/trips/TopBar';
import {
  CATALOG,
  countsTowardDailyCap,
  LIVE_TYPES,
  type Catalog,
  type NotificationCategory,
} from '@/notifications/catalog';
import { Banner, Card, fontFamilies, Screen, Skeleton, Text, useTheme } from '@/ui';

import { notificationSettingsCopy as copy } from './copy';
import { useNotificationPrefs, type NotificationPrefsDeps } from './useNotificationPrefs';

/** The OS side: whether RoadWise may notify at all, and the two ways to fix it. */
export interface OsNotificationsPort {
  read(): Promise<NotificationAccess | null>;
  request(): Promise<NotificationAccess>;
  openSettings(): Promise<void>;
}

export interface NotificationSettingsDeps extends NotificationPrefsDeps {
  os?: OsNotificationsPort;
  appState?: AppStateLike;
  /** Tests build both readings of the cap question. */
  catalog?: Catalog;
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

/** The categories H6 shows: those with a live type, in catalog order, each shown once. */
export function liveCategories(catalog: Catalog = CATALOG): NotificationCategory[] {
  const out: NotificationCategory[] = [];
  for (const type of LIVE_TYPES) {
    const c = catalog[type].category;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Every shown category's live types count toward §11.1's cap (so the cap line is true of them all). */
function allCapped(catalog: Catalog): boolean {
  return LIVE_TYPES.every((t) => countsTowardDailyCap(t, catalog));
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

/** `America/Los_Angeles` → `America/Los Angeles`. */
const zoneLabel = (zone: string): string => zone.replace(/_/g, ' ');

function useOsAccess(os: OsNotificationsPort, appState: AppStateLike) {
  const [access, setAccess] = useState<NotificationAccess | null>(null);
  const read = useCallback(() => {
    void os.read().then(setAccess, () => setAccess(null));
  }, [os]);
  useEffect(() => {
    read();
    // Back from the phone's Settings: read again. Only while this screen is open.
    const sub = appState.addEventListener('change', (next) => {
      if (next === 'active') read();
    });
    return () => sub.remove();
  }, [appState, read]);
  return { access, read };
}

/**
 * H6 · Notifications. The switches for the categories that have a live notification, quiet hours,
 * and what the phone itself allows. Every change saves as it is made (no primary action), and each
 * switch's hint says what it does.
 */
export function NotificationSettingsScreen({ deps = {} }: { deps?: NotificationSettingsDeps }) {
  const th = useTheme();
  const router = useRouter();
  const catalog = deps.catalog ?? CATALOG;
  const { prefs, zone, save, saving, error, retry } = useNotificationPrefs(deps);
  const reported = useDriveStateReported();
  const [os] = useState(() => deps.os ?? adapterPort(defaultPermissionsAdapter()));
  const { access, read } = useOsAccess(os, deps.appState ?? AppState);
  const { db, now } = useDataSource();
  // A tap, so the request goes straight to the OS (never throttled, Ruling T8 r1); it is still
  // stamped, as T14's steps do, so a later app-started offer respects the 14-day window.
  const allow = () =>
    void os
      .request()
      .then(() => recordPrompt(createSettingsRepo(db), 'notifications', now()).catch(() => undefined))
      .then(read, read);

  const back = router.canGoBack() ? () => router.back() : null;
  const categories = liveCategories(catalog);

  let body;
  if (prefs === null && error === 'load') {
    body = (
      <Banner
        testID="prefs-load-error"
        tone="danger"
        message={copy.loadError}
        action={{ label: copy.retry, onPress: retry }}
      />
    );
  } else if (prefs === null) {
    body = (
      <Card padded={false} testID="prefs-loading">
        {[0, 1].map((i) => (
          <View key={i} style={{ padding: th.space.lg, gap: th.space.sm }}>
            <Skeleton width="45%" height={18} />
            <Skeleton width="80%" height={14} />
          </View>
        ))}
      </Card>
    );
  } else {
    const quiet = prefs.quiet;
    const quietOff = quiet.start === quiet.end;
    body = (
      <>
        <View style={{ gap: th.space.sm }}>
          <FieldLabel>{copy.sendLabel}</FieldLabel>
          <Card padded={false} testID="prefs-categories">
            {categories.map((c, i) => {
              const words = copy.categories[c];
              if (!words) return null;
              const on = prefs.categories[c];
              return (
                <ToggleRow
                  key={c}
                  testID={`prefs-category-${c}`}
                  first={i === 0}
                  title={words.title}
                  hint={on ? words.on : words.off}
                  value={on}
                  disabled={saving}
                  onChange={(next) => void save({ categories: { [c]: next } })}
                />
              );
            })}
          </Card>
          {allCapped(catalog) ? (
            <Text variant="footnote" tone="muted" testID="prefs-cap">
              {copy.cap}
            </Text>
          ) : null}
        </View>

        <View style={{ gap: th.space.sm }}>
          <FieldLabel>{copy.quiet.label}</FieldLabel>
          <Card padded={false} testID="prefs-quiet">
            <ToggleRow
              testID="prefs-quiet-toggle"
              first
              title={copy.quiet.title}
              hint={
                quiet.enabled && !quietOff
                  ? copy.quiet.on(clockLabel(quiet.start), clockLabel(quiet.end))
                  : quiet.enabled
                    ? copy.quiet.same
                    : copy.quiet.off
              }
              value={quiet.enabled}
              disabled={saving}
              onChange={(next) => void save({ quiet_enabled: next })}
            />
            {quiet.enabled ? (
              <>
                <HourRow
                  testID="prefs-quiet-start"
                  label={copy.quiet.starts}
                  value={quiet.start}
                  disabled={saving}
                  onChange={(v) => void save({ quiet_start: v })}
                />
                <HourRow
                  testID="prefs-quiet-end"
                  label={copy.quiet.ends}
                  value={quiet.end}
                  disabled={saving}
                  onChange={(v) => void save({ quiet_end: v })}
                />
              </>
            ) : null}
          </Card>
          <Text variant="footnote" tone="muted" testID="prefs-zone">
            {copy.quiet.zone(zoneLabel(zone))}
          </Text>
        </View>
      </>
    );
  }

  return (
    <Screen scroll testID="notification-settings">
      <TripTopBar title={copy.title} onBack={back} />
      {reported ? (
        <View
          testID="prefs-promise"
          style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }}
        >
          <Ionicons name="car-outline" size={ICON.sm + 4} color={th.colors.accent} />
          <Text variant="callout" style={{ flex: 1 }}>
            {copy.promise}
          </Text>
        </View>
      ) : null}
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
          action={{
            label: copy.os.allow,
            onPress: allow,
          }}
        />
      ) : null}
      {error === 'save' ? (
        <Banner
          testID="prefs-save-error"
          tone="warning"
          message={copy.saveError}
          action={{ label: copy.retry, onPress: retry }}
        />
      ) : null}
      {prefs !== null && error === 'load' ? (
        <Banner
          testID="prefs-load-error"
          tone="danger"
          message={copy.loadError}
          action={{ label: copy.retry, onPress: retry }}
        />
      ) : null}
      {body}
    </Screen>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <Text
      variant="caption"
      tone="muted"
      accessibilityRole="header"
      style={{ textTransform: 'uppercase', letterSpacing: 1.2 }}
    >
      {children}
    </Text>
  );
}

function ToggleRow({
  title,
  hint,
  value,
  disabled,
  onChange,
  first,
  testID,
}: {
  title: string;
  hint: string;
  value: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  first?: boolean;
  testID: string;
}) {
  const th = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        paddingVertical: th.space.md,
        paddingHorizontal: th.space.lg,
        minHeight: TOUCH + th.space.md,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: th.colors.divider,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="headline">{title}</Text>
        <Text variant="footnote" tone="muted" testID={`${testID}-hint`}>
          {hint}
        </Text>
      </View>
      <Switch
        testID={testID}
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityHint={hint}
        accessibilityState={{ checked: value, disabled }}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: th.colors.accent, false: th.colors.border }}
      />
    </View>
  );
}

/** An hour field with earlier/later steps; one adjustable element for a screen reader. */
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
      hitSlop={th.space.xs}
      style={({ pressed }) => ({
        width: TOUCH,
        height: TOUCH,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: th.radius.pill,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Ionicons
        name={dir === 1 ? 'chevron-forward' : 'chevron-back'}
        size={ICON.sm + 4}
        color={th.colors.accent}
      />
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
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.sm,
        paddingVertical: th.space.xs,
        paddingHorizontal: th.space.lg,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: th.colors.divider,
      }}
    >
      <Text variant="body" style={{ flex: 1 }}>
        {label}
      </Text>
      {button(-1)}
      <Text
        testID={`${testID}-value`}
        variant="headline"
        style={{ fontFamily: fontFamilies.numerals, minWidth: 84, textAlign: 'center' }}
      >
        {shown}
      </Text>
      {button(1)}
    </View>
  );
}
