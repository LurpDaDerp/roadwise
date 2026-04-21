import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ImageBackground,
  ScrollView,
  StatusBar,
  Platform,
} from 'react-native';
import { useTheme, Eyebrow } from '../theme';

export default function AboutScreen({ imageUri }) {
  const t = useTheme();

  const bgSource = imageUri ? { uri: imageUri } : require('../assets/aboutback.jpg');

  const STATS = {
    phoneInvolvedPercent: 12,
    textingCrashMultiplier: 23,
    dailyPhoneDeathSummary:
      'Nearly one life is lost every single day in the U.S. due to phone-related distractions',
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      <ImageBackground source={bgSource} style={{ flex: 1 }} resizeMode="cover">
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: 'rgba(6,10,12,0.66)' },
          ]}
        />
        <View style={{ flex: 1 }}>
          <ScrollView
            contentContainerStyle={{
              paddingTop:
                Platform.OS === 'android'
                  ? (StatusBar.currentHeight || 0) + 32
                  : 64,
              paddingHorizontal: 24,
              paddingBottom: 48,
            }}
          >
            <Eyebrow style={{ color: t.colors.accent }}>The mission</Eyebrow>
            <Text
              style={{
                color: '#fff',
                fontSize: 38,
                fontWeight: '800',
                letterSpacing: -0.8,
                marginTop: 10,
                marginBottom: 24,
              }}
            >
              Building a Safer Journey.
            </Text>

            <Text style={styles.lead}>
              I created this app because I've seen firsthand how quickly a phone can turn a normal drive into a tragedy. A quick glance doesn't feel like much, but it's often enough to take your eyes off the road for several seconds. At highway speeds that can mean driving the length of a football field blind.
            </Text>

            <View
              style={{
                backgroundColor: 'rgba(10,16,14,0.72)',
                borderRadius: t.radius.lg,
                padding: 20,
                marginTop: 24,
                marginBottom: 24,
                borderWidth: 1,
                borderColor: 'rgba(0,179,134,0.3)',
              }}
            >
              <Text
                style={{
                  color: t.colors.accent,
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 1.2,
                  textTransform: 'uppercase',
                  marginBottom: 14,
                }}
              >
                The facts
              </Text>

              <StatLine>
                Each year, over <B>3,000</B> people lose their lives in distracted driving accidents in the United States.
              </StatLine>
              <StatLine>
                An estimated <B>{STATS.phoneInvolvedPercent}%</B> of those fatal crashes involved phone use.
              </StatLine>
              <StatLine>
                Phone use while driving makes a crash <B>{STATS.textingCrashMultiplier}×</B> more likely.
              </StatLine>
              <StatLine>{STATS.dailyPhoneDeathSummary}.</StatLine>
            </View>

            <Text style={styles.lead}>
              This isn't just about numbers. It's about people. Families who never got to say goodbye, friends who never made it home. I built this app to help drivers stay focused and remove the small but deadly temptations of their phones. If this app helps prevent even one crash, it will have been worth the work.
            </Text>
          </ScrollView>
        </View>
      </ImageBackground>
    </View>
  );
}

function StatLine({ children }) {
  return (
    <View style={{ flexDirection: 'row', marginBottom: 10 }}>
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: '#00b386',
          marginTop: 8,
          marginRight: 12,
        }}
      />
      <Text style={{ color: '#e8ecef', fontSize: 15, lineHeight: 22, flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}

function B({ children }) {
  return <Text style={{ color: '#fff', fontWeight: '700' }}>{children}</Text>;
}

const styles = StyleSheet.create({
  lead: {
    color: '#e8ecef',
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: 0.1,
  },
});
