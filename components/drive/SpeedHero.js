// SpeedHero — the one thing the driver glances at: current speed at ~120 pt,
// colour by margin over the limit, the limit sign beside it.
import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { useTheme, AutoFitText } from '../../theme';
import { SpeedLimitSign } from './SpeedLimitSign';

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.length === 8 ? h.slice(0, 6) : h;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function mix(a, b, k) {
  return { r: Math.round(a.r + (b.r - a.r) * k), g: Math.round(a.g + (b.g - a.g) * k), b: Math.round(a.b + (b.b - a.b) * k) };
}
export function speedColor(speed, limit, colors) {
  const safe = hexToRgb(colors.accent);
  const warn = hexToRgb(colors.warning);
  const alert = hexToRgb(colors.danger);
  if (!isFinite(limit) || limit <= 0) return colors.accent;
  const percent = Math.max(0, Math.min(1, (speed - limit) / (limit * 0.4)));
  const c = percent <= 0.5 ? mix(safe, warn, percent / 0.5) : mix(warn, alert, (percent - 0.5) / 0.5);
  return `rgb(${c.r},${c.g},${c.b})`;
}

export const SpeedHero = React.memo(function SpeedHero({
  speed, limit, unit, isSpeeding, limitIsDefault, showLimit = true, gpsStatus,
}) {
  const t = useTheme();
  // Six hex parses and two channel mixes; the inputs only change when the speed does.
  const color = useMemo(() => speedColor(speed, limit, t.colors), [speed, limit, t.colors]);
  const unitLabel = unit === 'kph' ? 'km/h' : 'mph';
  const searching = gpsStatus === 'searching';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
      <View style={{ flex: 1, alignItems: 'center' }} accessibilityLabel={`Speed ${Math.round(speed)} ${unitLabel}`} accessibilityRole="text">
        <AutoFitText
          style={[t.typography.glance, { color: searching ? t.colors.textSubtle : color, includeFontPadding: false, textAlign: 'center' }]}
          numberOfLines={1}
        >
          {searching ? '--' : Math.round(speed)}
        </AutoFitText>
        <Text style={[t.typography.glanceLabel, { color: t.colors.textMuted, marginTop: -4, textAlign: 'center' }]}>
          {searching ? 'Finding GPS' : unitLabel}
        </Text>
      </View>
      {showLimit && (
        <SpeedLimitSign limit={limit} unit={unit} isDefault={limitIsDefault} speeding={isSpeeding} size={84} />
      )}
    </View>
  );
});

export default SpeedHero;
