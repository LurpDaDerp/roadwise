// The DashPal radio the permissions adapter starts on the driver's tap: on iOS the start shows the
// Bluetooth prompt, and the answer is waited for as long as a driver takes to read it.
import { createBluetoothPort, PROMPT_SETTLE_MS } from '../bluetoothPort';
import { createFakeBle } from '../fakeTransport';
import { createBleTransport } from '../transport';

/** An iOS transport whose timers run on a virtual clock (`advance`). */
function iosRadio() {
  const ble = createFakeBle();
  ble.setState('unknown');
  const due: { at: number; fn: () => void }[] = [];
  let now = 0;
  const t = createBleTransport(ble, {
    platform: 'ios',
    setTimer: (fn, ms) => {
      const d = { at: now + ms, fn };
      due.push(d);
      return d;
    },
    clearTimer: (h) => {
      const i = due.indexOf(h as (typeof due)[number]);
      if (i >= 0) due.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const d of due.filter((x) => x.at <= now)) {
      due.splice(due.indexOf(d), 1);
      d.fn();
    }
  };
  return { ble, port: createBluetoothPort(() => t), advance };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('an answer to the iOS prompt 30 s after the tap is the answer, not "undetermined"', async () => {
  const { ble, port, advance } = iosRadio();
  let answer: string | null | undefined;
  void port.startRadio().then((s) => (answer = s));
  await flush();
  advance(30_000);
  await flush();
  expect(answer).toBeUndefined();
  ble.setState('on');
  await flush();
  expect(answer).toBe('on');
});

test('with no answer at all the start gives up after the settle, still unknown', async () => {
  const { port, advance } = iosRadio();
  let answer: string | null | undefined;
  void port.startRadio().then((s) => (answer = s));
  await flush();
  advance(PROMPT_SETTLE_MS - 1);
  await flush();
  expect(answer).toBeUndefined();
  advance(1);
  await flush();
  expect(answer).toBe('unknown');
});
