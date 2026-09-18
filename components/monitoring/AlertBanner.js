// AlertBanner — [MP-2] non-blocking banner for INFO and WARNING alerts.
// Also used for speeding and phone-use notices so every in-drive notice looks
// the same. Large type, colour + icon carry the meaning.
//
// Acknowledgement (Euro NCAP "suppression after acknowledgement", WARNINGS_DESIGN §4): when
// `onDismiss` is supplied the banner shows a large "Got it" control rather than a 20 px close
// glyph. The driver is glancing, in a moving car: the target is a full-height pill on the side of
// the banner, with a 12 px hitSlop on top, so it can be hit without aiming. The engine decides
// whether an acknowledgement is allowed at all (the closed-eye family and "driver not visible"
// can never be dismissed); this component only offers the affordance it was given.
import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme';
import { ALERT_SEVERITY } from '../../monitoring/types';

// alert: { id, severity, title, message, icon?, onPress? }
export const AlertBanner = React.memo(function AlertBanner({ alert, onDismiss, dismissLabel = 'Got it', style }) {
  const t = useTheme();
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(slide, { toValue: alert ? 1 : 0, useNativeDriver: true, friction: 8, tension: 80 }).start();
  }, [alert?.id, slide]);

  if (!alert) return null;
  const severity = alert.severity || ALERT_SEVERITY.INFO;
  const palette = {
    [ALERT_SEVERITY.INFO]: { bg: t.colors.infoFaint, fg: t.colors.info, border: t.colors.info },
    [ALERT_SEVERITY.WARNING]: { bg: t.colors.warningFaint, fg: t.colors.warning, border: t.colors.warning },
    [ALERT_SEVERITY.CRITICAL]: { bg: t.colors.dangerFaint, fg: t.colors.danger, border: t.colors.danger },
  }[severity];

  return (
    <Animated.View
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
      style={[
        styles.banner,
        {
          backgroundColor: palette.bg,
          borderRadius: t.radius.md,
          borderColor: palette.border,
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
        },
        style,
      ]}
    >
      <Ionicons name={alert.icon || (severity === ALERT_SEVERITY.INFO ? 'information-circle' : 'warning')} size={26} color={palette.fg} />
      <View style={styles.text}>
        <Text style={[styles.title, { color: t.colors.text }]} numberOfLines={1}>
          {alert.title}
        </Text>
        {!!alert.message && (
          <Text style={[styles.message, { color: t.colors.textMuted }]} numberOfLines={1}>
            {alert.message}
          </Text>
        )}
      </View>
      {!!onDismiss && (
        <Pressable
          onPress={() => onDismiss(alert.id)}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={`${dismissLabel}, dismiss this alert`}
          style={({ pressed }) => [
            styles.dismiss,
            { backgroundColor: palette.fg, borderRadius: t.radius.pill, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Ionicons name="checkmark" size={20} color={t.colors.bg} />
          <Text style={[styles.dismissLabel, { color: t.colors.bg }]}>{dismissLabel}</Text>
        </Pressable>
      )}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  banner: {
    borderWidth: 1.5,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  text: { flex: 1 },
  title: { fontSize: 18, fontWeight: '800', letterSpacing: -0.2 },
  message: { fontSize: 14, fontWeight: '600', marginTop: 1 },
  dismiss: {
    minHeight: 44,
    minWidth: 92,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  dismissLabel: { fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
});

export default AlertBanner;
