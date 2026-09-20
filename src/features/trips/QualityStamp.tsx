import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useTheme } from '@/ui';
import { Stamp } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { qualityCaption } from './format';
import { TOUCH } from './layout';
import { HOW_SCORING_WORKS_HREF } from './routes';

/**
 * The data-quality grade as a stamp that can be tapped for what it means (§7.D D1: "data-quality
 * badge (A / B / C, tap for meaning)"; Task 6 deviation D-2, now that E4 has a route).
 *
 * The letter never carries the meaning alone — the caption under it is the words ("Clean signal",
 * "Some GPS gaps", "Weak GPS") — and the tap opens E4, where the grades are explained in full.
 * The stamp is drawn at its own size and the *target* is stretched around it: a rubber stamp
 * inflated to 44 pt is a bigger stamp, not a better one.
 *
 * The stamp is hidden from assistive technology inside the button, so the grade is one element
 * that reads "Data quality A, Clean signal" and says what tapping it does, rather than two.
 */
export function QualityStamp({
  grade,
  size = 'sm',
  testID,
}: {
  grade: 'A' | 'B' | 'C';
  size?: 'sm' | 'md';
  testID?: string;
}) {
  const router = useRouter();
  const th = useTheme();
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={copy.quality.spoken(grade, qualityCaption(grade))}
      accessibilityHint={copy.quality.hint}
      onPress={() => router.push(HOW_SCORING_WORKS_HREF)}
      hitSlop={th.space.sm}
      testID={testID}
      style={({ pressed }) => ({
        minHeight: TOUCH,
        justifyContent: 'center',
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Stamp kind={grade} label={qualityCaption(grade)} size={size} />
      </View>
    </Pressable>
  );
}
