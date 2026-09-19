// CameraPlacementGuide — used by Settings > Driver monitoring. Illustrates the
// dash-mount placement (front camera facing the driver), lets the user pick
// the driver side, and exposes a `preview` slot where the monitoring branch
// can render its live camera preview (useDriverMonitoring().previewComponent).
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTheme } from '../../theme';
import { DRIVER_SIDE_OPTIONS } from '../../monitoring/settings';

function Illustration({ driverSide, t, preview }) {
  const driverLeft = driverSide !== 'right';
  return (
    <View
      style={{
        height: 150,
        borderRadius: t.radius.md,
        backgroundColor: t.colors.surfaceAlt,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.border,
        overflow: 'hidden',
        justifyContent: 'flex-end',
      }}
    >
      {preview ? (
        <View style={StyleSheet.absoluteFill}>{preview}</View>
      ) : (
        <>
          {/* windshield */}
          <View
            style={{
              position: 'absolute',
              top: 12,
              left: 16,
              right: 16,
              height: 62,
              borderTopLeftRadius: 40,
              borderTopRightRadius: 40,
              borderWidth: 2,
              borderColor: t.colors.borderStrong,
              borderBottomWidth: 0,
            }}
          />
          {/* dash */}
          <View style={{ position: 'absolute', top: 74, left: 10, right: 10, height: 3, backgroundColor: t.colors.borderStrong }} />
          {/* phone on mount */}
          <View
            style={{
              position: 'absolute',
              top: 46,
              left: driverLeft ? '38%' : '50%',
              width: 26,
              height: 40,
              borderRadius: 6,
              backgroundColor: t.colors.accent,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.colors.accentText, position: 'absolute', top: 4 }} />
            <Ionicons name="eye" size={14} color={t.colors.accentText} />
          </View>
          {/* driver */}
          <View style={{ position: 'absolute', bottom: 12, left: driverLeft ? '18%' : undefined, right: driverLeft ? undefined : '18%', alignItems: 'center' }}>
            <MaterialCommunityIcons name="account" size={44} color={t.colors.textMuted} />
            <Text style={[t.typography.micro, { color: t.colors.textMuted, fontSize: 9 }]}>YOU</Text>
          </View>
          {/* steering wheel */}
          <View style={{ position: 'absolute', bottom: 48, left: driverLeft ? '20%' : undefined, right: driverLeft ? undefined : '20%' }}>
            <MaterialCommunityIcons name="steering" size={30} color={t.colors.textSubtle} />
          </View>
          {/* sightline */}
          <View
            style={{
              position: 'absolute',
              top: 66,
              left: driverLeft ? '28%' : '58%',
              width: 56,
              height: 2,
              backgroundColor: t.colors.accent,
              opacity: 0.6,
              transform: [{ rotate: driverLeft ? '-28deg' : '28deg' }],
            }}
          />
        </>
      )}
    </View>
  );
}

export function CameraPlacementGuide({ driverSide = 'left', onDriverSideChange, preview, compact = false, style }) {
  const t = useTheme();
  const tips = [
    { icon: 'phone-portrait-outline', text: 'Mount the phone on the dash or windshield, portrait.' },
    { icon: 'camera-reverse-outline', text: 'Front camera facing you, screen still readable.' },
    { icon: 'sunny-outline', text: 'Avoid direct sun on the lens; keep the mount steady.' },
  ];
  return (
    <View style={style}>
      <Illustration driverSide={driverSide} t={t} preview={preview} />
      {!compact && (
        <View style={{ marginTop: 12, gap: 8 }}>
          {tips.map((tip) => (
            <View key={tip.icon} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name={tip.icon} size={16} color={t.colors.accent} />
              <Text style={[t.typography.caption, { color: t.colors.textMuted, flex: 1 }]}>{tip.text}</Text>
            </View>
          ))}
        </View>
      )}
      {!!onDriverSideChange && (
        <View style={{ marginTop: 14 }}>
          <Text style={[t.typography.micro, { color: t.colors.textMuted, marginBottom: 8 }]}>Driver seat</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {DRIVER_SIDE_OPTIONS.map((opt) => {
              const active = opt.value === driverSide;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => onDriverSideChange(opt.value)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => [
                    {
                      flex: 1,
                      paddingVertical: 10,
                      paddingHorizontal: 12,
                      borderRadius: t.radius.md,
                      borderWidth: 1.5,
                      borderColor: active ? t.colors.accent : t.colors.border,
                      backgroundColor: active ? t.colors.accentFaint : t.colors.surfaceAlt,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <Text style={[t.typography.bodyStrong, { color: active ? t.colors.accent : t.colors.text }]}>{opt.label} side</Text>
                  {!compact && (
                    <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]} numberOfLines={1}>
                      {opt.body}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

export default CameraPlacementGuide;
