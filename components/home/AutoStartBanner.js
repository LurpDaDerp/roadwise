// AutoStartBanner — shown on Home when auto-start sees the car moving. The drive starts by
// itself when the countdown reaches zero; the only reason to touch it is "Not driving".
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, AccessibilityInfo } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme, Card, Button } from '../../theme';

const COUNTDOWN_S = 5;

export function AutoStartBanner({ onStart, onCancel }) {
  const t = useTheme();
  const [left, setLeft] = useState(COUNTDOWN_S);
  const firedRef = useRef(false);
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(`Driving detected. Starting your drive in ${COUNTDOWN_S} seconds.`);
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (left > 0 || firedRef.current) return;
    firedRef.current = true;
    onStartRef.current?.();
  }, [left]);

  const startNow = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    onStartRef.current?.();
  };

  return (
    <Card style={{ borderWidth: 1.5, borderColor: t.colors.accent }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: t.colors.accentFaint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: t.colors.accent, fontSize: 24, fontWeight: '900', fontVariant: ['tabular-nums'] }}>{left}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="car-sport" size={16} color={t.colors.accent} />
            <Text style={[t.typography.micro, { color: t.colors.accent }]}>Driving detected</Text>
          </View>
          <Text style={[t.typography.subheading, { color: t.colors.text, marginTop: 2 }]}>Starting your drive…</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <View style={{ flex: 1 }}>
          <Button title="Not driving" variant="ghost" onPress={onCancel} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Start now" onPress={startNow} />
        </View>
      </View>
    </Card>
  );
}

export default AutoStartBanner;
