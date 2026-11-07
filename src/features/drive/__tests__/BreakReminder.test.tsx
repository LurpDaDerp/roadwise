// The break reminder on the driving screen: "Take a break soon" with a cup, read out as an alert, for
// 4 s on the row clock, never the one standing at mount or one already 4 s old.
import { Ionicons } from '@expo/vector-icons';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { BREAK_REMINDER_MS, type BreakReminder } from '@/drive/breakWatch';
import { HUD } from '@/ui/drive';

import { BreakReminderLine, useBreakFlash } from '../BreakReminder';

const T = 1_790_000_000_000;
/** The cup glyph (`cafe-outline`). */
const cup = String.fromCodePoint(Number(Ionicons.glyphMap['cafe-outline']));
const reminder = (at: number, hours = 2): BreakReminder => ({ key: `break@${at}`, at, hours });

function Probe({ r, rowTs }: { r: BreakReminder | null; rowTs: number | null }) {
  const f = useBreakFlash(r, rowTs, () => Date.now());
  return <Text testID="f">{f === null ? 'none' : `${f.hours}@${f.until - T}`}</Text>;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
});
afterEach(() => jest.useRealTimers());

test('a cup in the screen ink and four words on a chrome bar, never a tier colour; read out as an alert; no touch target', async () => {
  await render(<BreakReminderLine palette={HUD.night} compact={false} />);
  const bar = screen.getByTestId('hud-break');
  expect(bar).toHaveStyle({ backgroundColor: HUD.night.chrome, borderColor: HUD.night.chromeEdge, borderWidth: 2 });
  expect(screen.getByRole('alert')).toHaveProp('accessibilityLabel', 'Take a break soon');
  const icon = screen.getByTestId('hud-break-icon', { includeHiddenElements: true });
  expect(icon).toHaveStyle({ color: HUD.night.ink });
  expect(icon).toHaveTextContent(cup);
  expect(screen.getByText('Take a break soon')).toHaveStyle({ fontSize: 20 });
  expect('Take a break soon'.split(' ')).toHaveLength(4);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('a new reminder shows for 4 s on the row clock, then not again; the one standing at mount never; one 4 s old never', async () => {
  expect(BREAK_REMINDER_MS).toBe(4000);
  const r = await render(<Probe r={null} rowTs={T} />);
  await r.rerender(<Probe r={reminder(T + 1000)} rowTs={T + 1000} />);
  expect(screen.getByTestId('f')).toHaveTextContent('2@4000');
  await act(() => jest.advanceTimersByTime(3999));
  expect(screen.getByTestId('f')).toHaveTextContent('2@4000');
  await act(() => jest.advanceTimersByTime(1));
  expect(screen.getByTestId('f')).toHaveTextContent('none');
  await r.rerender(<Probe r={reminder(T + 2000, 3)} rowTs={T + 6000} />);
  expect(screen.getByTestId('f')).toHaveTextContent('none');
  await r.unmount();
  await render(<Probe r={reminder(T)} rowTs={T} />);
  expect(screen.getByTestId('f')).toHaveTextContent('none');
});
