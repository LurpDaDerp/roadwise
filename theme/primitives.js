import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from './useTheme';
import { AutoFitText } from './AutoFitText';

// Screen — full-bleed themed background + safe padding.
// Uses a solid background to avoid LinearGradient null-colors crashes
// during native stack transitions.
export function Screen({ children, style, padded = true }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.colors?.bg || '#000' }}>
      <View
        style={[
          { flex: 1 },
          padded && { paddingHorizontal: t.spacing[5], paddingTop: t.spacing[6] },
          style,
        ]}
      >
        {children}
      </View>
    </View>
  );
}

// Section — labeled group. Micro uppercase eyebrow + content.
export function Section({ label, children, style, actions }) {
  const t = useTheme();
  return (
    <View style={[{ marginBottom: t.spacing[6] }, style]}>
      {(label || actions) && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: t.spacing[3],
            paddingHorizontal: t.spacing[1],
          }}
        >
          {label ? (
            <Text
              style={[
                t.typography.micro,
                { color: t.colors.accent },
              ]}
            >
              {label}
            </Text>
          ) : <View />}
          {actions}
        </View>
      )}
      {children}
    </View>
  );
}

// Card — primary container for content groups.
export function Card({ children, style, padded = true, tone = 'default', onPress }) {
  const t = useTheme();
  const bg = tone === 'raised' ? t.colors.surfaceRaised : t.colors.surface;

  const base = {
    backgroundColor: bg,
    borderRadius: t.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.border,
    padding: padded ? t.spacing[5] : 0,
    ...t.elevation.card,
  };

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        android_ripple={{ color: t.colors.accentFaint }}
        style={({ pressed }) => [base, pressed && { opacity: 0.85 }, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[base, style]}>{children}</View>;
}

// Divider — hairline separator.
export function Divider({ inset = 0 }) {
  const t = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: t.colors.divider,
        marginVertical: t.spacing[2],
        marginLeft: inset,
      }}
    />
  );
}

// Eyebrow — tiny uppercase label used as section header standalone.
export function Eyebrow({ children, style, tone = 'accent' }) {
  const t = useTheme();
  const color = tone === 'accent' ? t.colors.accent : t.colors.textSubtle;
  return <Text style={[t.typography.micro, { color }, style]}>{children}</Text>;
}

// Stat — large numeric with label beneath.
export function Stat({ value, label, trend, accent }) {
  const t = useTheme();
  return (
    <View>
      <AutoFitText
        style={[
          t.typography.numeric,
          { color: accent || t.colors.text },
        ]}
      >
        {value}
      </AutoFitText>
      {!!label && (
        <Text
          style={[
            t.typography.caption,
            { color: t.colors.textMuted, marginTop: -2 },
          ]}
        >
          {label}
        </Text>
      )}
      {!!trend && (
        <Text
          style={[
            t.typography.caption,
            { color: t.colors.accent, marginTop: 2 },
          ]}
        >
          {trend}
        </Text>
      )}
    </View>
  );
}

// Button — three variants: primary, ghost, danger.
export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  style,
  fullWidth = true,
}) {
  const t = useTheme();

  const variants = {
    primary: {
      bg: t.colors.accent,
      fg: t.colors.accentText,
      border: 'transparent',
    },
    ghost: {
      bg: 'transparent',
      fg: t.colors.text,
      border: t.colors.borderStrong,
    },
    soft: {
      bg: t.colors.accentFaint,
      fg: t.colors.accent,
      border: 'transparent',
    },
    danger: {
      bg: t.colors.danger,
      fg: '#ffffff',
      border: 'transparent',
    },
  };
  const v = variants[variant] || variants.primary;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      android_ripple={{ color: 'rgba(255,255,255,0.12)' }}
      style={({ pressed }) => [
        {
          backgroundColor: v.bg,
          borderColor: v.border,
          borderWidth: v.border === 'transparent' ? 0 : 1,
          borderRadius: t.radius.md,
          paddingVertical: 14,
          paddingHorizontal: t.spacing[5],
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 8,
          width: fullWidth ? '100%' : undefined,
          opacity: disabled ? 0.5 : pressed ? 0.88 : 1,
          transform: pressed ? [{ scale: 0.995 }] : undefined,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={v.fg} />
      ) : (
        <>
          {icon}
          <Text
            style={{
              color: v.fg,
              fontSize: 15,
              fontWeight: '700',
              letterSpacing: 0.2,
            }}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

// Field — labeled text input wrapper (consumer provides TextInput as child).
export function Field({ label, hint, children, style }) {
  const t = useTheme();
  return (
    <View style={[{ marginBottom: t.spacing[4] }, style]}>
      {!!label && (
        <Text
          style={[
            t.typography.caption,
            {
              color: t.colors.textMuted,
              marginBottom: 6,
              marginLeft: 2,
            },
          ]}
        >
          {label}
        </Text>
      )}
      {children}
      {!!hint && (
        <Text
          style={[
            t.typography.caption,
            { color: t.colors.textSubtle, marginTop: 4, marginLeft: 2 },
          ]}
        >
          {hint}
        </Text>
      )}
    </View>
  );
}

// Use as a StyleSheet source for TextInput
export function useInputStyle() {
  const t = useTheme();
  return {
    backgroundColor: t.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: t.colors.border,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing[4],
    paddingVertical: 12,
    color: t.colors.text,
    fontSize: 15,
  };
}

// Pill — small status/count chip.
export function Pill({ label, tone = 'neutral', style }) {
  const t = useTheme();
  const tones = {
    neutral: { bg: t.colors.surfaceAlt, fg: t.colors.textMuted },
    accent:  { bg: t.colors.accentFaint, fg: t.colors.accent },
    danger:  { bg: 'rgba(255,59,48,0.15)', fg: t.colors.danger },
    warning: { bg: 'rgba(255,176,32,0.15)', fg: t.colors.warning },
  };
  const c = tones[tone] || tones.neutral;
  return (
    <View
      style={[
        {
          backgroundColor: c.bg,
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: t.radius.pill,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <Text
        style={{
          color: c.fg,
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// ScreenHeader — page title + optional subtitle, used at top of Screen.
export function ScreenHeader({ eyebrow, title, subtitle, right, style }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: t.spacing[6],
        },
        style,
      ]}
    >
      <View style={{ flex: 1 }}>
        {!!eyebrow && (
          <Eyebrow style={{ marginBottom: 8 }}>{eyebrow}</Eyebrow>
        )}
        <Text style={[t.typography.title, { color: t.colors.text }]}>
          {title}
        </Text>
        {!!subtitle && (
          <Text
            style={[
              t.typography.body,
              { color: t.colors.textMuted, marginTop: 4 },
            ]}
          >
            {subtitle}
          </Text>
        )}
      </View>
      {right}
    </View>
  );
}
