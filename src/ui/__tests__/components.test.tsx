import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Avatar, avatarColorIndex, avatarInitials } from '@/ui/primitives/Avatar';
import { Chip } from '@/ui/primitives/Chip';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { FreezeCount } from '@/ui/primitives/FreezeCount';
import { IconButton } from '@/ui/primitives/IconButton';
import { Pill } from '@/ui/primitives/Pill';
import { formatPointsValue, PointsCounter } from '@/ui/primitives/PointsCounter';
import { ProgressBar } from '@/ui/primitives/ProgressBar';
import { ProgressRing } from '@/ui/primitives/ProgressRing';
import { SectionHeader } from '@/ui/primitives/SectionHeader';
import { SegmentedControl } from '@/ui/primitives/SegmentedControl';
import { Sheet } from '@/ui/primitives/Sheet';
import { StatTile } from '@/ui/primitives/StatTile';
import { StreakFlame } from '@/ui/primitives/StreakFlame';
import { TierBadge } from '@/ui/primitives/TierBadge';
import { ToggleRow } from '@/ui/primitives/ToggleRow';
import { describeTrend, TrendArrow } from '@/ui/primitives/TrendArrow';
import { ThemeProvider } from '@/ui/theme';
import { tokens } from '@/ui/tokens';

// The count-up runs on requestAnimationFrame; drive it with fake timers inside act() so no frame
// lands after a test has finished.
beforeEach(() => jest.useFakeTimers());
afterEach(async () => {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

const wrap = (ui: ReactElement, opts: { still?: boolean; scheme?: 'light' | 'dark' } = {}) =>
  render(
    <SafeAreaProvider>
      <ThemeProvider scheme={opts.scheme ?? 'light'} reduceMotion={opts.still ?? true}>
        {ui}
      </ThemeProvider>
    </SafeAreaProvider>
  );

describe('Avatar', () => {
  test('initials come from the first two words of a username', () => {
    expect(avatarInitials('maya_drives')).toBe('MD');
    expect(avatarInitials('LurpDaDerp')).toBe('LD');
    expect(avatarInitials('jordan')).toBe('J');
    expect(avatarInitials('alex-15')).toBe('A');
    expect(avatarInitials('sam.k')).toBe('SK');
    expect(avatarInitials('1234')).toBe('?');
  });

  test('the colour is deterministic and ignores case', () => {
    const n = tokens.color.light.avatar.length;
    expect(avatarColorIndex('maya_drives', n)).toBe(avatarColorIndex('MAYA_drives', n));
    const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((u) => avatarColorIndex(u, n)));
    expect(spread.size).toBeGreaterThan(3);
  });

  test('is decorative unless given a label', async () => {
    await wrap(
      <>
        <Avatar username="rio" testID="quiet" />
        <Avatar username="quinn_t" accessibilityLabel="quinn_t" />
      </>
    );
    expect(screen.queryByTestId('quiet')).toBeNull();
    expect(screen.getByLabelText('quinn_t')).toBeOnTheScreen();
  });
});

describe('Chip', () => {
  test('a filter chip is a button that reports selected', async () => {
    const onPress = jest.fn();
    await wrap(<Chip label="Clean" selected onPress={onPress} />);
    const chip = screen.getByRole('button', { name: 'Clean' });
    expect(chip).toBeSelected();
    await fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('the DMS chip is a switch that reports on/off', async () => {
    await wrap(<Chip label="DMS" role="switch" selected={false} onPress={() => {}} />);
    expect(screen.getByRole('switch', { name: 'DMS' })).not.toBeChecked();
  });
});

test('SegmentedControl exposes tabs and reports the chosen value', async () => {
  const onChange = jest.fn();
  await wrap(
    <SegmentedControl
      accessibilityLabel="Leaderboard"
      segments={[
        { value: 'friends', label: 'Friends & clan' },
        { value: 'league', label: 'League' },
      ]}
      value="friends"
      onChange={onChange}
    />
  );
  expect(screen.getByRole('tab', { name: 'Friends & clan' })).toBeSelected();
  await fireEvent.press(screen.getByRole('tab', { name: 'League' }));
  expect(onChange).toHaveBeenCalledWith('league');
});

describe('progress', () => {
  test('a bar speaks its percent and clamps out-of-range values', async () => {
    await wrap(<ProgressBar value={1.7} accessibilityLabel="Level progress" />);
    expect(screen.getByRole('progressbar', { name: 'Level progress' })).toHaveAccessibilityValue({ now: 100 });
  });

  test('a ring can speak a custom value and draws its centre', async () => {
    await wrap(
      <ProgressRing value={0.68} accessibilityLabel="Clan goal" accessibilityValueText="340 of 500 clean miles" />
    );
    expect(screen.getByRole('progressbar', { name: 'Clan goal' })).toHaveAccessibilityValue({
      text: '340 of 500 clean miles',
    });
  });
});

test('TierBadge names the tier and rank, so it never relies on colour', async () => {
  await wrap(<TierBadge tier="platinum" rank={4} />);
  expect(screen.getByLabelText('Platinum league, rank 4')).toBeOnTheScreen();
});

describe('StatTile', () => {
  test('reads as one element: label, value, band word and trend', async () => {
    await wrap(<StatTile label="Speeding" value="0.8" unit="per 100 mi" health="green" trend="down" />);
    expect(
      screen.getByLabelText('Speeding, 0.8 per 100 mi, Good, Down, better vs your 30-day average')
    ).toBeOnTheScreen();
  });

  test('higher-is-better flips the trend reading', () => {
    expect(describeTrend('up', 'up')).toBe('Up, better');
    expect(describeTrend('up', 'down')).toBe('Up, worse');
    expect(describeTrend('flat', 'down')).toBe('No change');
  });

  test('the value takes the band colour', async () => {
    await wrap(<StatTile label="Phone pickups" value="2.1" health="red" />);
    expect(screen.getByText('2.1')).toHaveStyle({ color: tokens.color.light.signal.severe.text });
  });
});

test('TrendArrow has a spoken default', async () => {
  await wrap(<TrendArrow direction="down" better="up" />);
  expect(screen.getByLabelText('Down, worse')).toBeOnTheScreen();
});

describe('streak and freezes', () => {
  test('StreakFlame says the count and multiplier', async () => {
    await wrap(<StreakFlame count={11} multiplier={1.22} />);
    expect(screen.getByLabelText('Streak 11 drives, multiplier 1.22')).toBeOnTheScreen();
  });

  test('an at-risk streak says so in words', async () => {
    await wrap(<StreakFlame count={3} state="atRisk" />);
    expect(screen.getByLabelText('Streak 3 drives, at risk')).toBeOnTheScreen();
  });

  test('FreezeCount clamps to its maximum', async () => {
    await wrap(<FreezeCount count={5} />);
    expect(screen.getByLabelText('3 of 3 freezes held')).toBeOnTheScreen();
  });
});

describe('PointsCounter', () => {
  test('formats with separators, a plus for gains and a true minus for losses', () => {
    expect(formatPointsValue(1240)).toBe('1,240');
    expect(formatPointsValue(167, true)).toBe('+167');
    expect(formatPointsValue(-44, true)).toBe('−44');
    expect(formatPointsValue(0, true)).toBe('0');
  });

  test('VoiceOver hears the final value at once, never the count', async () => {
    await wrap(<PointsCounter value={167} from={0} signed label="Points earned" />, { still: false });
    expect(screen.getByLabelText('Points earned: +167 points')).toBeOnTheScreen();
  });

  test('under reduce motion it shows the final number straight away', async () => {
    await wrap(<PointsCounter value={1240} from={0} unit="" />, { still: true });
    expect(screen.getByText('1,240')).toBeOnTheScreen();
  });

  test('a negative total is red', async () => {
    await wrap(<PointsCounter value={-44} signed unit="" />);
    expect(screen.getByText('−44')).toHaveStyle({ color: tokens.color.light.signal.severe.text });
  });

  test('counts up to the target when motion is allowed', async () => {
    await wrap(<PointsCounter value={500} from={0} unit="" />, { still: false });
    expect(screen.queryByText('500')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(tokens.motion.countUp + 200);
    });
    expect(screen.getByText('500')).toBeOnTheScreen();
  });
});

test('Pill is static text with its glyph', async () => {
  await wrap(<Pill label="Clean" tone="clean" icon="checkmark-circle" />);
  expect(screen.getByLabelText('Clean')).toBeOnTheScreen();
  expect(screen.queryByRole('button')).toBeNull();
});

test('IconButton requires and exposes a label', async () => {
  const onPress = jest.fn();
  await wrap(<IconButton icon="share-outline" accessibilityLabel="Share" onPress={onPress} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Share' }));
  expect(onPress).toHaveBeenCalled();
});

test('ToggleRow flips from the switch', async () => {
  const onValueChange = jest.fn();
  await wrap(<ToggleRow title="Voice alerts" value={false} onValueChange={onValueChange} testID="sw" />);
  await fireEvent(screen.getByTestId('sw'), 'valueChange', true);
  expect(onValueChange).toHaveBeenCalledWith(true);
});

test('SectionHeader is a header with an optional link', async () => {
  const onPress = jest.fn();
  await wrap(<SectionHeader title="Recent drives" action={{ label: 'See all', onPress }} />);
  expect(screen.getByRole('header', { name: 'Recent drives' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('link', { name: 'See all' }));
  expect(onPress).toHaveBeenCalled();
});

test('EmptyState offers its one action', async () => {
  const onPress = jest.fn();
  await wrap(
    <EmptyState icon="car-sport" title="Take your first drive" body="Safe miles earn points." action={{ label: 'Start drive', onPress }} />
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Start drive' }));
  expect(onPress).toHaveBeenCalled();
});

test('Sheet shows its title and closes from the close button', async () => {
  const onClose = jest.fn();
  await wrap(
    <Sheet visible title="Report this event" onClose={onClose}>
      <></>
    </Sheet>
  );
  expect(screen.getByText('Report this event')).toBeOnTheScreen();
  await fireEvent.press(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
  expect(onClose).toHaveBeenCalled();
});
