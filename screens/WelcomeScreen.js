// WelcomeScreen — first thing a signed-out person sees.
import React from 'react';
import { View, Text, ImageBackground, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, useTheme } from '../theme';

const STEPS = [
  { icon: 'play-circle-outline', title: 'Start a drive', body: 'Mount the phone and tap Start.' },
  { icon: 'eye-outline', title: 'Stay focused', body: 'Phone down. Optional camera monitoring keeps your eyes on the road.' },
  { icon: 'trophy-outline', title: 'Earn rewards', body: 'Points, streaks, badges and a leaderboard.' },
];

export default function WelcomeScreen({ navigation }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ImageBackground source={require('../assets/driveback.jpg')} style={{ flex: 1 }} resizeMode="cover">
      <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,8,10,0.78)' }} />
      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: insets.top + 48, paddingBottom: Math.max(insets.bottom, 20) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: t.colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="car-sport" size={22} color={t.colors.accentText} />
          </View>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: 0.4 }}>RoadWise</Text>
        </View>
        <Text style={[t.typography.display, { color: '#fff', marginTop: 28, fontSize: 40, lineHeight: 46 }]}>Drive focused.{'\n'}Earn rewards.</Text>
        <Text style={{ color: 'rgba(255,255,255,0.78)', fontSize: 16, lineHeight: 23, marginTop: 12, maxWidth: 340 }}>
          RoadWise detects distracted driving and rewards every focused mile.
        </Text>

        <View style={{ marginTop: 32, gap: 14 }}>
          {STEPS.map((s) => (
            <View key={s.title} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,179,134,0.18)', borderWidth: 1, borderColor: t.palette.teal[500], alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={s.icon} size={22} color={t.palette.teal[300]} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>{s.title}</Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 2 }}>{s.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={{ flex: 1 }} />
        <Button title="Create account" onPress={() => navigation.navigate('SignUp')} style={{ paddingVertical: 16 }} />
        <View style={{ height: 10 }} />
        <Button title="Log in" variant="ghost" onPress={() => navigation.navigate('Login')} style={{ borderColor: 'rgba(255,255,255,0.35)' }} />
      </View>
    </ImageBackground>
  );
}
