import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  useTheme,
} from '../theme';

export default function AboutScreen() {
  const t = useTheme();

  const STATS = {
    phoneInvolvedPercent: 12,
    textingCrashMultiplier: 23,
    dailyPhoneDeathSummary:
      'Nearly one life is lost every single day in the U.S. due to phone-related distractions',
  };

  const leadStyle = {
    ...t.typography.body,
    color: t.colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
  };

  return (
    <Screen hasHeader>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing[9] }}
      >
        <ScreenHeader
          eyebrow="The mission"
          title="Building a Safer Journey."
          subtitle="Why RoadWise exists."
        />

        <Section>
          <Card>
            <Text style={leadStyle}>
              I created this app because I've seen firsthand how quickly a phone can turn a normal drive into a tragedy. A quick glance doesn't feel like much, but it's often enough to take your eyes off the road for several seconds. At highway speeds that can mean driving the length of a football field blind.
            </Text>
          </Card>
        </Section>

        <Section label="The facts">
          <Card>
            <StatLine>
              Each year, over <B>3,000</B> people lose their lives in distracted driving accidents in the United States.
            </StatLine>
            <StatLine>
              An estimated <B>{STATS.phoneInvolvedPercent}%</B> of those fatal crashes involved phone use.
            </StatLine>
            <StatLine>
              Phone use while driving makes a crash <B>{STATS.textingCrashMultiplier}×</B> more likely.
            </StatLine>
            <StatLine last>{STATS.dailyPhoneDeathSummary}.</StatLine>
          </Card>
        </Section>

        <Section label="Why it matters">
          <Card>
            <Text style={leadStyle}>
              This isn't just about numbers. It's about people. Families who never got to say goodbye, friends who never made it home. I built this app to help drivers stay focused and remove the small but deadly temptations of their phones. If this app helps prevent even one crash, it will have been worth the work.
            </Text>
          </Card>
        </Section>
      </ScrollView>
    </Screen>
  );
}

function StatLine({ children, last }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        marginBottom: last ? 0 : 12,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: t.colors.accent,
          marginTop: 9,
          marginRight: 12,
        }}
      />
      <Text
        style={{
          color: t.colors.text,
          fontSize: 15,
          lineHeight: 22,
          flex: 1,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

function B({ children }) {
  const t = useTheme();
  return (
    <Text style={{ color: t.colors.accent, fontWeight: '700' }}>
      {children}
    </Text>
  );
}
