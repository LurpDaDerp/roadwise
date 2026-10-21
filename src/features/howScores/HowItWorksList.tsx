import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { howItWorks } from '@/content/howScores';
import { Text, useTheme } from '@/ui';

/** The three big ideas, each on an accent disc: Home's How it works card and the top of How scores work. */
export function HowItWorksList({ autoDrives }: { autoDrives: boolean }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.md }}>
      {howItWorks(autoDrives).map((item) => (
        <View
          key={item.title}
          style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' }}
          accessible
          accessibilityLabel={`${item.title}. ${item.body}`}
        >
          <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentFaint }}>
            <Ionicons name={item.icon} size={t.size.icon} color={t.colors.accent} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headline">{item.title}</Text>
            <Text variant="subhead" tone="muted">
              {item.body}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}
