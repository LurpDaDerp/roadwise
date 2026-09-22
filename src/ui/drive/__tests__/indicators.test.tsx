import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

import { HazardChip } from '@/ui/drive/HazardChip';
import { HudIndicators } from '@/ui/drive/HudIndicators';
import { StatusRing } from '@/ui/drive/StatusRing';
import { countWords } from '@/ui/drive/hudSelectors';
import { HUD } from '@/ui/drive/hudTokens';

const flat = (style: unknown): ViewStyle => StyleSheet.flatten(style as ViewStyle);

describe('StatusRing', () => {
  const levels = ['calm', 'attention', 'critical'] as const;

  test('each level is announced and doubles as the recording indicator', async () => {
    const labels: string[] = [];
    for (const level of levels) {
      const { unmount } = await render(<StatusRing level={level} recording night={false} />);
      const label = String(screen.getByTestId('hud-status').props.accessibilityLabel);
      expect(label).toMatch(/^Recording/);
      labels.push(label);
      await unmount();
    }
    expect(new Set(labels).size).toBe(3);
  });

  test('off the recording state it neither shows the recording mark nor says "Recording" (M3)', async () => {
    for (const level of levels) {
      const { unmount } = await render(<StatusRing level={level} recording={false} night={false} />);
      expect(screen.queryByTestId('hud-status-recording')).toBeNull();
      const label = String(screen.getByTestId('hud-status').props.accessibilityLabel);
      expect(label).not.toMatch(/record/i);
      // The alert level is still announced.
      expect(screen.getByTestId('hud-status-strip')).toBeOnTheScreen();
      await unmount();
    }
    await render(<StatusRing level="calm" recording night={false} />);
    expect(screen.getByTestId('hud-status-recording')).toBeOnTheScreen();
  });

  test('levels differ by thickness and mark, not colour alone', async () => {
    const seen: { height: number; mark: boolean }[] = [];
    for (const level of levels) {
      const { unmount } = await render(<StatusRing level={level} recording night={false} />);
      seen.push({
        height: Number(flat(screen.getByTestId('hud-status-strip').props.style).height),
        mark: screen.queryByTestId('hud-status-mark') !== null,
      });
      await unmount();
    }
    expect(seen[0]!.mark).toBe(false);
    expect(seen[1]!.mark).toBe(true);
    expect(seen[2]!.mark).toBe(true);
    expect(seen[1]!.height).toBeGreaterThan(seen[0]!.height);
    expect(seen[2]!.height).toBeGreaterThan(seen[1]!.height);
  });

  test('critical uses the critical ink, night the night palette', async () => {
    const { rerender } = await render(<StatusRing level="critical" recording night={false} />);
    expect(flat(screen.getByTestId('hud-status-strip').props.style).backgroundColor).toBe(
      HUD.day.critical
    );
    await rerender(<StatusRing level="calm" recording night />);
    expect(flat(screen.getByTestId('hud-status-strip').props.style).backgroundColor).toBe(
      HUD.night.inkMuted
    );
  });
});

describe('HazardChip', () => {
  test('no hazard draws nothing', async () => {
    await render(<HazardChip kind={null} night={false} />);
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
  });

  test('night is an icon and one word', async () => {
    await render(<HazardChip kind="night" night />);
    const chip = screen.getByTestId('hud-hazard');
    expect(screen.getByText('Night')).toBeOnTheScreen();
    expect(screen.getByTestId('hud-hazard-icon')).toBeOnTheScreen();
    expect(countWords('Night')).toBeLessThanOrEqual(2);
    expect(chip).toHaveProp('accessibilityLabel', 'Hazard: night driving');
  });
});

describe('HudIndicators', () => {
  const base = {
    gps: 'good',
    thermal: 'nominal',
    batteryLow: false,
    passenger: false,
  } as const;

  test('GPS quality is always shown, as an icon with a spoken label', async () => {
    for (const [gps, label] of [
      ['good', 'GPS good'],
      ['weak', 'GPS weak'],
      ['none', 'No GPS'],
    ] as const) {
      const { unmount } = await render(<HudIndicators {...base} gps={gps} night={false} />);
      expect(screen.getByTestId('hud-ind-gps')).toHaveProp('accessibilityLabel', label);
      await unmount();
    }
  });

  test('lost GPS is an indicator, never the words "Finding GPS" on the HUD', async () => {
    await render(<HudIndicators {...base} gps="none" night={false} />);
    expect(screen.queryByText(/GPS/)).toBeNull();
  });

  test('the icon itself changes with GPS quality, not only its colour', async () => {
    const names = new Set<string>();
    for (const gps of ['good', 'weak', 'none'] as const) {
      const { unmount } = await render(<HudIndicators {...base} gps={gps} night={false} />);
      // the drawn glyph itself, not its colour
      names.add(String(screen.getByTestId('hud-ind-gps-icon').props.children));
      await unmount();
    }
    expect(names.size).toBe(3);
  });

  test('a nominal or fair phone shows no thermal mark; serious and critical do', async () => {
    for (const [thermal, label] of [
      ['nominal', null],
      ['fair', null],
      ['serious', 'Phone warm'],
      ['critical', 'Phone hot'],
    ] as const) {
      const { unmount } = await render(<HudIndicators {...base} thermal={thermal} night={false} />);
      if (label)
        expect(screen.getByTestId('hud-ind-thermal')).toHaveProp('accessibilityLabel', label);
      else expect(screen.queryByTestId('hud-ind-thermal')).toBeNull();
      await unmount();
    }
  });

  test('low battery and the passenger stamp appear only when true', async () => {
    const { rerender } = await render(<HudIndicators {...base} night={false} />);
    expect(screen.queryByTestId('hud-ind-battery')).toBeNull();
    expect(screen.queryByText('PASSENGER')).toBeNull();
    await rerender(<HudIndicators {...base} batteryLow passenger night={false} />);
    expect(screen.getByTestId('hud-ind-battery')).toHaveProp('accessibilityLabel', 'Battery low');
    expect(screen.getByText('PASSENGER')).toBeOnTheScreen();
  });
});
