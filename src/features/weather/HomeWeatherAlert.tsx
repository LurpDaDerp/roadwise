import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { Units } from '@/lib/units';
import { IconButton, Text, useTheme } from '@/ui';

import { weatherCopy, weatherLabel, weatherLine, weatherTitle } from './copy';
import type { DangerAlert } from './danger';
import { useWeatherAlert, type DismissStore, type WeatherPorts } from './useWeatherAlert';

/**
 * Home's dangerous-weather card (plan D14): the first action item under the drive card. Renders
 * nothing unless the weather near the driver is dangerous now or in the next 2 hours. Its ✕ hides
 * it until that danger ends or a different one starts. `ports` and `store` are for tests.
 */
export function HomeWeatherAlert({ ports, store }: { ports?: WeatherPorts; store?: DismissStore } = {}) {
  const { alert, dismiss } = useWeatherAlert(ports, store);
  const units = useUnits();
  if (alert === null) return null;
  return <WeatherAlertCard alert={alert} units={units} onDismiss={dismiss} />;
}

/**
 * The card: paper with a yellow outline, a warning glyph, the title (one to three words) and one
 * line of what to do. The yellow is never the only cue: the glyph and the words carry it.
 */
export function WeatherAlertCard({ alert, units, onDismiss }: { alert: DangerAlert; units: Units; onDismiss: () => void }) {
  const t = useTheme();
  const c = t.colors;
  const yellow = c.signal.minor;
  return (
    <View
      testID="home-weather-alert"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.sm,
        paddingVertical: t.space.lg,
        paddingLeft: t.space.lg,
        paddingRight: t.space.sm,
        backgroundColor: c.surface,
        borderRadius: t.radius.card,
        borderCurve: 'continuous',
        borderWidth: 2,
        borderColor: yellow.fill,
        boxShadow: t.elevation.card,
      }}
    >
      <View
        accessible
        accessibilityRole="alert"
        accessibilityLabel={weatherLabel(alert, units)}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.space.md }}
      >
        <View
          style={{
            width: t.size.touch,
            height: t.size.touch,
            borderRadius: t.size.touch / 2,
            backgroundColor: yellow.faint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons testID="home-weather-alert-icon" name="warning" size={t.size.iconLg} color={yellow.text} />
        </View>
        <View style={{ flex: 1, gap: t.space.xs }}>
          <Text variant="headline" testID="home-weather-alert-title">
            {weatherTitle(alert)}
          </Text>
          <Text variant="callout" tone="muted" testID="home-weather-alert-line">
            {weatherLine(alert, units)}
          </Text>
        </View>
      </View>
      <IconButton
        icon="close"
        accessibilityLabel={weatherCopy.dismiss}
        accessibilityHint={weatherCopy.dismissHint}
        onPress={onDismiss}
        testID="home-weather-alert-dismiss"
      />
    </View>
  );
}
