// AlertBanner — [MP-2] non-blocking banner for INFO and WARNING alerts.
// Also used for speeding and phone-use notices so every in-drive notice looks
// the same. Large type, colour + icon carry the meaning; no buttons required.
import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme';
import { ALERT_SEVERITY } from '../../monitoring/types';

// alert: { id, severity, title, message, icon?, onPress? }
export function AlertBanner({ alert, onDismiss, style }) {
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
        {
          backgroundColor: palette.bg,
          borderRadius: t.radius.md,
          borderWidth: 1.5,
          borderColor: palette.border,
          paddingVertical: 12,
          paddingHorizontal: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
        },
        style,
      ]}
    >
      <Ionicons name={alert.icon || (severity === ALERT_SEVERITY.INFO ? 'information-circle' : 'warning')} size={26} color={palette.fg} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.2 }} numberOfLines={1}>
          {alert.title}
        </Text>
        {!!alert.message && (
          <Text style={{ color: t.colors.textMuted, fontSize: 14, fontWeight: '600', marginTop: 1 }} numberOfLines={1}>
            {alert.message}
          </Text>
        )}
      </View>
      {!!onDismiss && (
        <Pressable onPress={() => onDismiss(alert.id)} hitSlop={10} accessibilityLabel="Dismiss">
          <Ionicons name="close" size={20} color={t.colors.textMuted} />
        </Pressable>
      )}
    </Animated.View>
  );
}

export default AlertBanner;
