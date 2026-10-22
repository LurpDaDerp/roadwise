import { nextWaitingChange, WAIT_COUNTDOWN_MS, WAIT_POPUP_MS, WAIT_TOTAL_MS, waitingDeadline, waitingPhaseAt } from '@/drive/waiting';

test('the constants: 5 min in all, the sheet at 2:00, the countdown from 4:30', () => {
  expect([WAIT_TOTAL_MS, WAIT_POPUP_MS, WAIT_COUNTDOWN_MS]).toEqual([300_000, 120_000, 270_000]);
});

test('phases on the host clock: waiting, the sheet at 2:00, the countdown at 4:30, over at 5:00; each with its deadline', () => {
  const since = 1_000_000;
  expect(waitingPhaseAt(since, since)).toBe('waiting');
  expect(waitingPhaseAt(since, since + 119_999)).toBe('waiting');
  expect(waitingPhaseAt(since, since + 120_000)).toBe('popup');
  expect(waitingPhaseAt(since, since + 269_999)).toBe('popup');
  expect(waitingPhaseAt(since, since + 270_000)).toBe('countdown');
  expect(waitingPhaseAt(since, since + 299_999)).toBe('countdown');
  expect(waitingPhaseAt(since, since + 300_000)).toBe('expired');
  expect(waitingDeadline(since, 'waiting')).toBe(since + 120_000);
  expect(waitingDeadline(since, 'popup')).toBe(since + 270_000);
  expect(waitingDeadline(since, 'countdown')).toBe(since + 300_000);
  expect(nextWaitingChange(since, since + 10)).toBe(since + 120_000);
  expect(nextWaitingChange(since, since + 280_000)).toBe(since + 300_000);
  // A touch is a new `since`: the wait starts over.
  expect(waitingPhaseAt(since + 250_000, since + 280_000)).toBe('waiting');
});
