import { ActivityIndicator, Pressable, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { useSetTripRole, type ChosenRole } from './roleActions';

const OPTIONS: readonly { role: ChosenRole; label: string }[] = [
  { role: 'driver', label: copy.roles.driver },
  { role: 'passenger', label: copy.roles.passenger },
  { role: 'other', label: copy.roles.other },
];

function Chip({
  label,
  onPress,
  loading,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  loading: boolean;
  disabled: boolean;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={th.space.xs}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: th.space.lg,
        borderRadius: th.radius.pill,
        borderWidth: 1.5,
        borderColor: th.colors.accent,
        backgroundColor: pressed ? th.colors.accentFaint : th.colors.surface,
        opacity: disabled && !loading ? 0.6 : 1,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      {loading ? (
        <ActivityIndicator color={th.colors.accent} />
      ) : (
        <Text variant="headline" tone="accent">
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * "Were you driving?" (§7.C C10) — three answers, verbatim, each a 44 pt control. One answer at
 * a time: the chip pressed shows its progress and the others wait, so two taps cannot queue two
 * contradicting items. A failure is answered in place, in a live region, never in an alert.
 */
export function RoleChips({ clientTripId, testID }: { clientTripId: string; testID?: string }) {
  const th = useTheme();
  const { setRole, busy, failed } = useSetTripRole();

  return (
    <View style={{ gap: th.space.sm }} testID={testID}>
      <Text variant="headline">{copy.roles.question}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }}>
        {OPTIONS.map(({ role, label }) => (
          <Chip
            key={role}
            label={label}
            onPress={() => void setRole(clientTripId, role)}
            loading={busy === role}
            disabled={busy !== null}
          />
        ))}
      </View>
      {failed ? (
        <Text
          variant="footnote"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {copy.roles.error}
        </Text>
      ) : null}
    </View>
  );
}
