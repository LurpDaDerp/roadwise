import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';

import { useScoreDaily, useTrip } from '@/data/queries';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { Field } from './Field';
import { ICON, TIGHT, TOUCH } from './layout';
import { useSetTripRole, type ChosenRole } from './roleActions';
import { HOME_HREF, TRIP_HISTORY_HREF } from './routes';
import { TripTopBar } from './TopBar';
import { TripHeader } from './TripHeader';
import { useDeleteTrip } from './tripActions';

/** A day key no trip can have, so the day query has nothing to read until the trip is known. */
const NO_DAY = '0000-00-00';

const ROLE_OPTIONS: readonly { value: ChosenRole; label: string }[] = [
  { value: 'driver', label: copy.edit.roleDriver },
  { value: 'passenger', label: copy.edit.rolePassenger },
  { value: 'other', label: copy.edit.roleOther },
];

function RoleRadio({
  label,
  checked,
  busy,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked, disabled, busy }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        minHeight: TOUCH,
        paddingVertical: th.space.sm,
        paddingHorizontal: th.space.sm,
        marginHorizontal: -th.space.sm,
        borderRadius: th.radius.sm,
        opacity: disabled && !busy ? 0.5 : 1,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      {busy ? (
        <ActivityIndicator color={th.colors.accent} />
      ) : (
        <Ionicons
          name={checked ? 'radio-button-on' : 'radio-button-off'}
          size={ICON.lg}
          color={checked ? th.colors.accent : th.colors.borderStrong}
        />
      )}
      <Text variant="body" style={{ flex: 1 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The delete confirmation (§7.D D5), as a sheet so the drive it is about stays on screen behind
 * it. Every consequence is stated **before** the destructive button, including the one the
 * product is honest about rather than quiet about: a guardian who receives shared summaries can
 * see that a drive was deleted, never what was on it.
 */
function DeleteSheet({
  visible,
  busy,
  failed,
  rewarded,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  busy: boolean;
  failed: boolean;
  rewarded: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const th = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: th.colors.scrim }}>
        <View
          style={{
            backgroundColor: th.colors.bgElevated,
            borderTopLeftRadius: th.radius.xl,
            borderTopRightRadius: th.radius.xl,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderColor: th.colors.border,
            padding: th.space.lg,
            gap: th.space.md,
          }}
        >
          <Text variant="title3" accessibilityRole="header">
            {copy.edit.deleteConfirmTitle}
          </Text>
          <View style={{ gap: th.space.sm }} testID="delete-consequences">
            {copy.edit.deleteConsequence.map((line) => (
              <Text key={line} variant="subhead" tone="muted">
                {line}
              </Text>
            ))}
          </View>
          {rewarded ? (
            <View
              testID="rewarded-notice"
              style={{
                gap: TIGHT,
                padding: th.space.md,
                borderRadius: th.radius.sm,
                borderWidth: 1,
                borderColor: th.colors.border,
                backgroundColor: th.colors.surface,
              }}
            >
              <Text variant="headline">{copy.edit.rewarded}</Text>
              <Text variant="footnote" tone="muted">
                {copy.edit.rewardedBody}
              </Text>
            </View>
          ) : null}
          {failed ? <Banner tone="danger" message={copy.edit.deleteError} /> : null}
          <Button
            label={copy.edit.deleteConfirm}
            variant="destructive"
            onPress={onConfirm}
            loading={busy}
            testID="delete-confirm"
          />
          <Button
            label={copy.edit.deleteCancel}
            variant="ghost"
            size="md"
            onPress={onCancel}
            testID="delete-cancel"
          />
        </View>
      </View>
    </Modal>
  );
}

/**
 * D5 — edit the drive (§7.D D5): who was driving, and delete.
 *
 * The role change goes through Task 6's `setTripRole` rather than a second write path, so C10's
 * chips on Home and this radio group queue the identical `trip-actions` body and leave the row in
 * the identical state. What this screen adds is the sentence C10 has no room for: what changing
 * the answer *does* — a passenger answer takes the drive off the score now, a driver answer sends
 * it back to be scored again.
 *
 * Vehicle and notes are named in §7.D D5 and are not here: M2 has no vehicles table and no notes
 * column, and a control that saves nothing is worse than an honest "coming soon".
 */
export function EditTripScreen({ clientTripId }: { clientTripId: string }) {
  const router = useRouter();
  const th = useTheme();
  const detailQuery = useTrip(clientTripId);
  const day = detailQuery.data?.trip.day ?? NO_DAY;
  const dayQuery = useScoreDaily({ from: day, to: day });
  const { setRole, busy, failed } = useSetTripRole();
  const remove = useDeleteTrip();
  const [confirming, setConfirming] = useState(false);
  const [changed, setChanged] = useState<ChosenRole | null>(null);

  const back = () => (router.canGoBack() ? router.back() : router.dismissTo(HOME_HREF));

  if (detailQuery.isPending) {
    return (
      <Screen scroll>
        <TripTopBar title={copy.edit.title} onBack={back} />
        <View accessibilityLabel={copy.loading} accessibilityRole="progressbar" accessible>
          <Skeleton width="70%" height={28} />
          <Skeleton width="100%" height={140} />
        </View>
      </Screen>
    );
  }

  if (detailQuery.error) {
    return (
      <Screen>
        <TripTopBar title={copy.edit.title} onBack={back} />
        <Banner
          tone="danger"
          message={copy.error.message}
          action={{ label: copy.error.retry, onPress: () => void detailQuery.refetch() }}
        />
      </Screen>
    );
  }

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <Screen>
        <TripTopBar title={copy.edit.title} onBack={back} />
        <EmptyState title={copy.notFound.title} body={copy.notFound.body} />
      </Screen>
    );
  }

  const { trip } = detail;
  const cached = dayQuery.data?.[0] ?? null;
  const rewarded = cached !== null && (cached.safeDay || cached.goodDay);

  const consequence =
    changed === null ? null : changed === 'driver' ? copy.edit.roleRescore : copy.edit.roleUnscore;

  const choose = (role: ChosenRole) => {
    if (role === trip.role) return;
    void setRole(clientTripId, role).then(() => setChanged(role));
  };

  const confirmDelete = () => {
    void remove.remove(clientTripId).then((ok) => {
      if (!ok) return;
      setConfirming(false);
      // The drive is gone from every list; going "back" would land on its own detail screen.
      router.dismissTo(TRIP_HISTORY_HREF);
    });
  };

  return (
    <Screen scroll testID="edit-trip-screen">
      <TripTopBar title={copy.edit.title} onBack={back} />

      <Card variant="license" testID="edit-card">
        <TripHeader trip={trip} />
      </Card>

      <Field label={copy.edit.roleLabel} testID="role-field">
        <View accessibilityRole="radiogroup" accessibilityLabel={copy.edit.roleLabel}>
          {ROLE_OPTIONS.map((option) => (
            <RoleRadio
              key={option.value}
              label={option.label}
              checked={trip.role === option.value}
              busy={busy === option.value}
              disabled={busy !== null}
              onPress={() => choose(option.value)}
              testID={`role-${option.value}`}
            />
          ))}
        </View>
        {failed ? (
          <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite" testID="role-error">
            {copy.edit.roleError}
          </Text>
        ) : consequence !== null ? (
          <Text
            variant="footnote"
            tone="muted"
            accessibilityLiveRegion="polite"
            testID="role-consequence"
          >
            {consequence}
          </Text>
        ) : null}
      </Field>

      <Field label={copy.edit.vehicleLabel} testID="vehicle-field">
        <Text variant="subhead" tone="muted">
          {copy.edit.vehicleSoon}
        </Text>
      </Field>

      <Field label={copy.edit.deleteLabel} testID="delete-field">
        <View style={{ gap: th.space.sm }}>
          <Text variant="subhead" tone="muted">
            {copy.edit.deleteLead}
          </Text>
          <Button
            label={copy.edit.delete}
            variant="destructive"
            onPress={() => setConfirming(true)}
            testID="delete-trip"
          />
        </View>
      </Field>

      <DeleteSheet
        visible={confirming}
        busy={remove.phase === 'busy'}
        failed={remove.phase === 'error'}
        rewarded={rewarded}
        onConfirm={confirmDelete}
        onCancel={() => setConfirming(false)}
      />
    </Screen>
  );
}
