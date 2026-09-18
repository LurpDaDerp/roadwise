// PointsCard — points this drive (or lifetime total) with the focus shield.
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, AutoFitText, Card } from '../../theme';

export const PointsCard = React.memo(function PointsCard({
  points, label = 'Points this drive', state = 'focused', pausedReason,
}) {
  const t = useTheme();
  const bump = useRef(new Animated.Value(1)).current;
  const prev = useRef(points);
  useEffect(() => {
    if (points > prev.current) {
      bump.setValue(1.12);
      Animated.spring(bump, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }).start();
    }
    prev.current = points;
  }, [points, bump]);

  const s = useMemo(() => {
    const states = {
      focused: { icon: 'shield-checkmark', color: t.colors.accent, bg: t.colors.accentFaint, text: 'Focused' },
      paused: { icon: 'pause-circle', color: t.colors.warning, bg: t.colors.warningFaint, text: pausedReason || 'Paused' },
      distracted: { icon: 'shield-half', color: t.colors.danger, bg: t.colors.dangerFaint, text: 'Distracted · streak lost' },
      idle: { icon: 'shield-outline', color: t.colors.textSubtle, bg: t.colors.surfaceAlt, text: 'Start moving to earn' },
    };
    return states[state] || states.focused;
  }, [state, pausedReason, t.colors]);
  const shown = useMemo(() => Number(points).toLocaleString(), [points]);
  return (
    <Card padded={false} style={{ paddingVertical: 14, paddingHorizontal: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={[t.typography.micro, { color: t.colors.textMuted, marginBottom: 2 }]}>{label}</Text>
          <Animated.View style={{ transform: [{ scale: bump }], alignSelf: 'flex-start' }}>
            <AutoFitText style={[t.typography.numeric, { color: state === 'distracted' ? t.colors.danger : t.colors.accent, fontSize: 48, lineHeight: 54 }]}>
              {shown}
            </AutoFitText>
          </Animated.View>
        </View>
        <View
          accessibilityLabel={`Status: ${s.text}`}
          style={{ alignItems: 'center', backgroundColor: s.bg, paddingHorizontal: 14, paddingVertical: 10, borderRadius: t.radius.md, maxWidth: 150 }}
        >
          <Ionicons name={s.icon} size={30} color={s.color} />
          <Text style={{ color: s.color, fontSize: 12, fontWeight: '800', letterSpacing: 0.4, marginTop: 4, textAlign: 'center' }} numberOfLines={2}>
            {s.text}
          </Text>
        </View>
      </View>
    </Card>
  );
});

export default PointsCard;
