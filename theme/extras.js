import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Switch,
  StyleSheet,
  Animated,
  Modal,
  Easing,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './useTheme';
import { AutoFitText } from './AutoFitText';

// Additional primitives added by the UX rework. Everything here composes the
// tokens in ./tokens.js; nothing restyles the existing primitives.

// ListRow — a settings / navigation row: icon, title, subtitle, right slot, chevron.
export function ListRow({
  icon,
  iconColor,
  iconBg,
  title,
  subtitle,
  right,
  chevron = false,
  onPress,
  first = false,
  destructive = false,
  disabled = false,
  testID,
}) {
  const t = useTheme();
  const fg = destructive ? t.colors.danger : t.colors.text;
  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {!!icon && (
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            backgroundColor: iconBg || (destructive ? t.colors.dangerFaint : t.colors.accentFaint),
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 14,
          }}
        >
          {typeof icon === 'string' ? (
            <Ionicons
              name={icon}
              size={18}
              color={iconColor || (destructive ? t.colors.danger : t.colors.accent)}
            />
          ) : (
            icon
          )}
        </View>
      )}
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={[t.typography.bodyStrong, { color: fg }]} numberOfLines={2}>
          {title}
        </Text>
        {!!subtitle && (
          <Text
            style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]}
            numberOfLines={3}
          >
            {subtitle}
          </Text>
        )}
      </View>
      {right}
      {chevron && (
        <Ionicons
          name="chevron-forward"
          size={18}
          color={t.colors.textSubtle}
          style={{ marginLeft: 6 }}
        />
      )}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      android_ripple={{ color: t.colors.accentFaint }}
      style={({ pressed }) => [pressed && { opacity: 0.85 }]}
    >
      {content}
    </Pressable>
  );
}

// Toggle — themed Switch.
export function Toggle({ value, onValueChange, disabled }) {
  const t = useTheme();
  const off = t.isDark ? '#3a3f46' : '#c9cfd6';
  return (
    <Switch
      value={!!value}
      onValueChange={onValueChange}
      disabled={disabled}
      trackColor={{ false: off, true: t.colors.accent }}
      thumbColor="#fff"
      ios_backgroundColor={off}
    />
  );
}

// ToggleRow — ListRow with a Toggle on the right.
export function ToggleRow({ value, onValueChange, disabled, ...rowProps }) {
  return (
    <ListRow
      {...rowProps}
      disabled={disabled}
      right={<Toggle value={value} onValueChange={onValueChange} disabled={disabled} />}
    />
  );
}

// EmptyState — icon, title, body and an optional action.
export function EmptyState({ icon = 'sparkles-outline', title, body, action, compact = false }) {
  const t = useTheme();
  return (
    <View
      style={{
        paddingVertical: compact ? 20 : 36,
        paddingHorizontal: 20,
        alignItems: 'center',
      }}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: t.colors.accentFaint,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12,
        }}
      >
        <Ionicons name={icon} size={24} color={t.colors.accent} />
      </View>
      {!!title && (
        <Text
          style={[t.typography.subheading, { color: t.colors.text, marginBottom: 4, textAlign: 'center' }]}
        >
          {title}
        </Text>
      )}
      {!!body && (
        <Text
          style={[
            t.typography.caption,
            { color: t.colors.textMuted, textAlign: 'center', maxWidth: 280, lineHeight: 19 },
          ]}
        >
          {body}
        </Text>
      )}
      {!!action && <View style={{ marginTop: 16, alignSelf: 'stretch' }}>{action}</View>}
    </View>
  );
}

// Skeleton — shimmering placeholder block.
export function Skeleton({ width = '100%', height = 16, radius, style }) {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius ?? t.radius.sm,
          backgroundColor: t.colors.surfaceAlt,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

// SegmentedTabs — pill-style segmented control built from tokens (no native dependency).
export function SegmentedTabs({ values, selectedIndex, onChange, style }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          backgroundColor: t.colors.surfaceAlt,
          borderRadius: t.radius.pill,
          padding: 3,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
        },
        style,
      ]}
    >
      {values.map((label, i) => {
        const active = i === selectedIndex;
        return (
          <Pressable
            key={label}
            onPress={() => onChange(i)}
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: t.radius.pill,
              backgroundColor: active ? t.colors.accent : 'transparent',
              alignItems: 'center',
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text
              style={{
                color: active ? t.colors.accentText : t.colors.textMuted,
                fontWeight: '700',
                fontSize: 13,
                letterSpacing: 0.3,
              }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// IconButton — round tappable icon; `tone` neutral | accent | danger.
export function IconButton({ icon, onPress, size = 40, tone = 'neutral', label, style, disabled }) {
  const t = useTheme();
  const tones = {
    neutral: { bg: t.colors.surfaceAlt, fg: t.colors.text, border: t.colors.border },
    accent: { bg: t.colors.accentFaint, fg: t.colors.accent, border: 'transparent' },
    danger: { bg: t.colors.danger, fg: '#fff', border: 'transparent' },
    ghost: { bg: 'transparent', fg: t.colors.text, border: t.colors.borderStrong },
  };
  const c = tones[tone] || tones.neutral;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.bg,
          borderWidth: c.border === 'transparent' ? 0 : StyleSheet.hairlineWidth,
          borderColor: c.border,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.5)} color={c.fg} />
    </Pressable>
  );
}

// ProgressBar — thin bar with tone colour.
export function ProgressBar({ value = 0, tone = 'accent', height = 8, style }) {
  const t = useTheme();
  const colors = {
    accent: t.colors.accent,
    warning: t.colors.warning,
    danger: t.colors.danger,
    info: t.colors.info,
  };
  const pct = Math.max(0, Math.min(1, Number(value) || 0)) * 100;
  return (
    <View
      style={[
        {
          height,
          borderRadius: height / 2,
          backgroundColor: t.colors.divider,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <View
        style={{
          height,
          width: `${pct}%`,
          borderRadius: height / 2,
          backgroundColor: colors[tone] || colors.accent,
        }}
      />
    </View>
  );
}

// Ring — circular score ring (0..100) with a centred value.
export function Ring({ value = 0, size = 96, stroke = 9, color, label, children }) {
  const t = useTheme();
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const ringColor = color || scoreColor(clamped, t);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={t.colors.divider}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={ringColor}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={offset}
          strokeLinecap="round"
          rotation="-90"
          origin={`${size / 2}, ${size / 2}`}
        />
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center' }}>
        {children || (
          <>
            <AutoFitText
              style={[
                t.typography.numeric,
                { color: ringColor, fontSize: Math.round(size * 0.3), lineHeight: Math.round(size * 0.34) },
              ]}
            >
              {Math.round(clamped)}
            </AutoFitText>
            {!!label && (
              <Text style={[t.typography.micro, { color: t.colors.textMuted, fontSize: 9 }]}>{label}</Text>
            )}
          </>
        )}
      </View>
    </View>
  );
}

// scoreColor — 0..100 → danger → warning → accent.
export function scoreColor(score, t) {
  const p = Math.max(0, Math.min(100, Number(score) || 0)) / 100;
  const start = { r: 230, g: 80, b: 80 };
  const mid = { r: 240, g: 180, b: 60 };
  const end = { r: 0, g: 179, b: 134 };
  let r, g, b;
  if (p < 0.5) {
    const k = p / 0.5;
    r = Math.round(start.r + (mid.r - start.r) * k);
    g = Math.round(start.g + (mid.g - start.g) * k);
    b = Math.round(start.b + (mid.b - start.b) * k);
  } else {
    const k = (p - 0.5) / 0.5;
    r = Math.round(mid.r + (end.r - mid.r) * k);
    g = Math.round(mid.g + (end.g - mid.g) * k);
    b = Math.round(mid.b + (end.b - mid.b) * k);
  }
  return `rgb(${r},${g},${b})`;
}

// Banner — inline notice with tone colouring (info | success | warning | danger).
export function Banner({ tone = 'info', icon, title, body, right, style, onPress }) {
  const t = useTheme();
  const tones = {
    info: { bg: t.colors.infoFaint, fg: t.colors.info, icon: 'information-circle' },
    success: { bg: t.colors.successFaint, fg: t.colors.success, icon: 'checkmark-circle' },
    warning: { bg: t.colors.warningFaint, fg: t.colors.warning, icon: 'warning' },
    danger: { bg: t.colors.dangerFaint, fg: t.colors.danger, icon: 'alert-circle' },
    neutral: { bg: t.colors.surfaceAlt, fg: t.colors.textMuted, icon: 'ellipse' },
  };
  const c = tones[tone] || tones.info;
  const inner = (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: c.bg,
          borderRadius: t.radius.md,
          paddingVertical: 12,
          paddingHorizontal: 14,
          gap: 10,
        },
        style,
      ]}
    >
      <Ionicons name={icon || c.icon} size={20} color={c.fg} />
      <View style={{ flex: 1 }}>
        {!!title && (
          <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>{title}</Text>
        )}
        {!!body && (
          <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: title ? 2 : 0 }]}>
            {body}
          </Text>
        )}
      </View>
      {right}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed && { opacity: 0.85 }]}>
      {inner}
    </Pressable>
  );
}

// Sheet — centred modal card with backdrop. Children render inside a Card-like container.
export function Sheet({ visible, onClose, title, eyebrow, children, align = 'center' }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: t.isDark ? 'rgba(0,0,0,0.65)' : 'rgba(15,20,25,0.45)',
          justifyContent: align === 'bottom' ? 'flex-end' : 'center',
          padding: align === 'bottom' ? 0 : 24,
        }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: t.colors.surface,
            borderRadius: t.radius.xl,
            borderBottomLeftRadius: align === 'bottom' ? 0 : t.radius.xl,
            borderBottomRightRadius: align === 'bottom' ? 0 : t.radius.xl,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.colors.border,
            padding: 22,
            paddingBottom: align === 'bottom' ? 36 : 22,
            width: '100%',
            maxWidth: align === 'bottom' ? undefined : 440,
            alignSelf: 'center',
            ...t.elevation.raised,
          }}
        >
          {!!eyebrow && (
            <Text style={[t.typography.micro, { color: t.colors.accent, marginBottom: 6 }]}>{eyebrow}</Text>
          )}
          {!!title && (
            <Text style={[t.typography.heading, { color: t.colors.text, marginBottom: 12 }]}>{title}</Text>
          )}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Chip — small rounded label with an optional icon; tones as Pill plus success/info.
export function Chip({ label, icon, tone = 'neutral', style, size = 'sm' }) {
  const t = useTheme();
  const tones = {
    neutral: { bg: t.colors.surfaceAlt, fg: t.colors.textMuted },
    accent: { bg: t.colors.accentFaint, fg: t.colors.accent },
    success: { bg: t.colors.successFaint, fg: t.colors.success },
    danger: { bg: t.colors.dangerFaint, fg: t.colors.danger },
    warning: { bg: t.colors.warningFaint, fg: t.colors.warning },
    info: { bg: t.colors.infoFaint, fg: t.colors.info },
  };
  const c = tones[tone] || tones.neutral;
  const big = size === 'md';
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          backgroundColor: c.bg,
          paddingHorizontal: big ? 12 : 9,
          paddingVertical: big ? 6 : 4,
          borderRadius: t.radius.pill,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      {!!icon && <Ionicons name={icon} size={big ? 14 : 12} color={c.fg} />}
      <Text
        style={{
          color: c.fg,
          fontSize: big ? 13 : 11,
          fontWeight: '700',
          letterSpacing: big ? 0.2 : 0.6,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// StatCell — label above a large value; used in stat rows across screens.
export function StatCell({ label, value, color, size = 'md', align = 'center' }) {
  const t = useTheme();
  const fontSize = size === 'sm' ? 24 : size === 'lg' ? 44 : 34;
  return (
    <View style={{ flex: 1, alignItems: align, justifyContent: 'center', paddingVertical: 4, paddingHorizontal: 6 }}>
      <Text
        style={[
          t.typography.micro,
          { color: t.colors.textMuted, marginBottom: 6, textAlign: align },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <AutoFitText
        style={[
          t.typography.numeric,
          { color: color || t.colors.text, fontSize, lineHeight: fontSize + 4 },
        ]}
      >
        {value}
      </AutoFitText>
    </View>
  );
}

// StatDivider — vertical hairline between StatCells.
export function StatDivider() {
  const t = useTheme();
  return (
    <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: t.colors.divider, marginVertical: 4 }} />
  );
}

// KeyValueRow — label left, value right; for detail lists.
export function KeyValueRow({ label, value, first, accent, tone }) {
  const t = useTheme();
  const color = accent ? t.colors.accent : tone === 'danger' ? t.colors.danger : tone === 'warning' ? t.colors.warning : t.colors.text;
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
      }}
    >
      <Text style={[t.typography.caption, { color: t.colors.textMuted, flex: 1, paddingRight: 12 }]}>{label}</Text>
      <Text style={[t.typography.bodyStrong, { color }]}>{String(value)}</Text>
    </View>
  );
}

// useCountUp — animates a number from 0 to `to` for stat counters.
export function useCountUp(to, duration = 500) {
  const [display, setDisplay] = useState(0);
  const anim = useRef(new Animated.Value(0)).current;
  const lastTarget = useRef(0);
  useEffect(() => {
    const id = anim.addListener(({ value }) => setDisplay(Math.floor(value)));
    return () => anim.removeListener(id);
  }, [anim]);
  useEffect(() => {
    const target = Number(to) || 0;
    anim.stopAnimation();
    anim.setValue(lastTarget.current); // count from the previous value, not from 0
    lastTarget.current = target;
    Animated.timing(anim, {
      toValue: target,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(() => setDisplay(target));
  }, [to, duration, anim]);
  return display;
}
