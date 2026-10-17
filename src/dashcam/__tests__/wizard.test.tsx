/**
 * The DashPal setup sheet: every step's words and controls, the step numbers, Cancel's double
 * confirmation (and the scrim, Android back and a swipe down on the grabber doing the same), no
 * Cancel on done, the title taking the screen reader's focus, the announcements and Reduce Motion.
 */
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { useState } from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';

import { appWorld, clearQueryClients, fakeAdapter, tap } from '@/features/permissions/__fixtures__/harness';
import { ThemeProvider } from '@/ui';

import { createFakeDashcamRuntime, PAIRED } from '../__fixtures__/fakeRuntime';
import { dashpalCopy } from '../copy';
import { setActiveDashcam } from '../registry';
import { createDashpalSecrets } from '../secure';
import type { SetupDeps, SetupFlow, SetupPhase, SetupStart } from '../setup';
import { PairWizardSheet, STEP_COUNT } from '../ui/wizard/PairWizardSheet';
import { StepInstructions } from '../ui/wizard/StepInstructions';
import { STEP_SETTLED_MS } from '../ui/wizard/StepTransition';
import { SWIPE_CANCEL_PT } from '../ui/wizard/WizardFrame';

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mock above
const haptics = require('expo-haptics') as { notificationAsync: jest.Mock };

const wiz = dashpalCopy.wizard;

function memSecrets() {
  const store = new Map<string, string>();
  return createDashpalSecrets(() => ({
    getItemAsync: async (k: string) => store.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    deleteItemAsync: async (k: string) => void store.delete(k),
  }));
}

/** A scripted setup flow: the test moves its phase and sees the answers. */
function scriptedFlow() {
  const listeners = new Set<(p: SetupPhase) => void>();
  let phase: SetupPhase = { kind: 'idle' };
  const answers: string[] = [];
  const starts: SetupStart[] = [];
  let made = 0;
  let cancelled = 0;
  const flow: SetupFlow = {
    phase: () => phase,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    start: async (opts) => void starts.push(opts ?? {}),
    pick: (id) => void answers.push(`pick:${id}`),
    pair: () => void answers.push('pair'),
    startAim: () => void answers.push('startAim'),
    next: () => void answers.push('next'),
    onViewFrame: () => () => {},
    onAim: () => () => {},
    retry: async () => void answers.push('retry'),
    cancel: async () => void (cancelled += 1),
  };
  const bases: SetupDeps[] = [];
  return {
    make: (base: SetupDeps) => {
      made += 1;
      bases.push(base);
      return { ...flow };
    },
    bases,
    answers,
    starts,
    made: () => made,
    cancelled: () => cancelled,
    to: (p: SetupPhase) =>
      act(async () => {
        phase = p;
        for (const fn of [...listeners]) fn(p);
      }),
  };
}

const outcomes: string[] = [];
let adapter = fakeAdapter();

function Host({ s, initial = {}, still = false }: { s: ReturnType<typeof scriptedFlow>; initial?: SetupStart; still?: boolean }) {
  const [start, setStart] = useState<SetupStart | null>(initial);
  return (
    <ThemeProvider reduceMotion={still}>
      <PairWizardSheet
        start={start}
        onClose={(o) => {
          outcomes.push(o);
          setStart(null);
        }}
        deps={{ adapter, platform: 'ios', flow: s.make, secrets: memSecrets() }}
      />
    </ThemeProvider>
  );
}

async function open(initial: SetupStart = {}, still = false) {
  setActiveDashcam(createFakeDashcamRuntime());
  const s = scriptedFlow();
  const w = await appWorld();
  await w.render(<Host s={s} initial={initial} still={still} />);
  return s;
}

const HIDDEN = { includeHiddenElements: true };
/** A press on something the sheet's modal hides from the accessibility tree (the scrim behind it). */
const pressHidden = (id: string) =>
  act(async () => {
    fireEvent.press(screen.getByTestId(id, HIDDEN));
  });
/** Android back (the modal's onRequestClose). */
const back = () =>
  act(async () => {
    fireEvent(screen.getByTestId('wizard-modal', HIDDEN), 'requestClose');
  });
/** The header's step, as it is named (the pills themselves carry no text to match). */
const stepText = (): string => screen.getByTestId('wizard-step-number', HIDDEN).props.accessibilityLabel ?? '';

beforeEach(() => {
  outcomes.length = 0;
  adapter = fakeAdapter();
  haptics.notificationAsync.mockClear();
});
afterEach(async () => {
  await act(async () => setActiveDashcam(null));
  clearQueryClients();
});

describe('the steps', () => {
  it('starts the flow on what the sheet opened for (a found DashPal, Set up again, or search)', async () => {
    const s = await open({ target: { peripheralId: 'P-1', name: 'DashPal-1A2B', adv: 'new' } });
    expect(s.starts).toEqual([{ target: { peripheralId: 'P-1', name: 'DashPal-1A2B', adv: 'new' } }]);
    expect(screen.getByTestId('wizard-sheet')).toBeOnTheScreen();
    expect(screen.getByTestId('wizard-permission-asking')).toHaveTextContent(dashpalCopy.setup.permission);
  });

  it('search: “Looking for your DashPal…”, no step number; several heard: “Which DashPal is yours?”, strongest first', async () => {
    const s = await open();
    await s.to({ kind: 'search', until: 1 });
    expect(screen.getByTestId('wizard-search-title')).toHaveTextContent('Looking for your DashPal…');
    expect(screen.getByTestId('wizard-search-body')).toHaveTextContent(wiz.search.body);
    expect(stepText()).toBe('');
    expect(screen.getByTestId('wizard-step-number', HIDDEN)).toHaveTextContent('');
    await s.to({
      kind: 'choose',
      candidates: [
        { id: 'P1', name: 'DashPal-0001', rssi: -40, adv: 'new' },
        { id: 'P2', name: 'DashPal-0002', rssi: -60, adv: 'open' },
      ],
    });
    expect(screen.getByTestId('wizard-choose-title')).toHaveTextContent('Which DashPal is yours?');
    expect(screen.getByTestId('wizard-pick-P1')).toHaveTextContent('DashPal-0001 · New');
    expect(screen.getByTestId('wizard-pick-P2')).toHaveTextContent('DashPal-0002 · Has phones paired');
    expect(stepText()).toBe('');
    await tap('wizard-pick-P2');
    expect(s.answers).toEqual(['pick:P2']);
  });

  it(`screen 1: the DashPal’s picture, “Pair DashPal-C4D5?”, its words and Pair; “Step 1 of ${STEP_COUNT}”`, async () => {
    const s = await open();
    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: null });
    expect(screen.getByTestId('wizard-confirm-picture', HIDDEN)).toBeOnTheScreen();
    expect(screen.getByTestId('wizard-confirm-title')).toHaveTextContent('Pair DashPal-C4D5?');
    expect(screen.getByTestId('wizard-confirm-title').props.accessibilityLabel).toBe(`Step 1 of ${STEP_COUNT}. Pair DashPal-C4D5?`);
    expect(screen.getByTestId('wizard-confirm-title').props.accessibilityRole).toBe('header');
    expect(screen.getByTestId('wizard-confirm-body')).toHaveTextContent('Check that this is the DashPal in your car. Its light flashes quickly while it’s ready to pair.');
    expect(screen.getByTestId('wizard-confirm-note')).toHaveTextContent(wiz.confirm.note);
    expect(screen.queryByTestId('wizard-confirm-replaces')).toBeNull();
    expect(stepText()).toBe(`Step 1 of ${STEP_COUNT}`);
    // The header shows the step as ink pills, hidden from the screen reader (the title names the step).
    expect(screen.getByTestId('wizard-step-number', HIDDEN)).toHaveTextContent(`1/${STEP_COUNT}`);
    await tap('wizard-pair');
    expect(s.answers).toEqual(['pair']);

    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'again', replaces: null });
    expect(screen.getByTestId('wizard-confirm-title')).toHaveTextContent('Set up DashPal-C4D5 again');
    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'open', replaces: 'DashPal-AAAA' });
    expect(screen.queryByTestId('wizard-confirm-note')).toBeNull();
    expect(screen.getByTestId('wizard-confirm-replaces')).toHaveTextContent('This replaces DashPal-AAAA on this phone.');
  });

  it('screen 1 after the tap: a spinner with “Connecting to DashPal-C4D5…”, then a check mark with “Connected” and a success haptic', async () => {
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const s = await open();
    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: null });
    await s.to({ kind: 'connecting', name: 'DashPal-C4D5', reconnecting: false });
    expect(screen.getByTestId('wizard-spinner')).toBeOnTheScreen();
    expect(screen.getByTestId('wizard-connect-title')).toHaveTextContent('Connecting to DashPal-C4D5…');
    expect(screen.getByTestId('wizard-connect-body')).toHaveTextContent('Other phones can’t pair with it while you set it up.');
    expect(stepText()).toBe(`Step 1 of ${STEP_COUNT}`);
    expect(say).toHaveBeenLastCalledWith('Connecting to DashPal-C4D5');
    expect(haptics.notificationAsync).not.toHaveBeenCalled();
    await s.to({ kind: 'connected', name: 'DashPal-C4D5' });
    expect(screen.getByTestId('wizard-check', HIDDEN)).toBeOnTheScreen();
    expect(screen.queryByTestId('wizard-spinner')).toBeNull();
    expect(screen.getByTestId('wizard-connect-title')).toHaveTextContent('Connected');
    expect(say).toHaveBeenLastCalledWith('Connected');
    expect(haptics.notificationAsync).toHaveBeenCalledWith('success');
    await s.to({ kind: 'connecting', name: 'DashPal-C4D5', reconnecting: true });
    expect(screen.getByTestId('wizard-connect-title')).toHaveTextContent('Reconnecting…');
    say.mockRestore();
  });

  it.each([
    [{ kind: 'press_button', name: 'DashPal-C4D5', until: 1 }, 'Press the DashPal’s button 5 times.'],
    [{ kind: 'waiting_busy', name: 'DashPal-C4D5', until: 1 }, 'Another phone is setting up this DashPal. Waiting…'],
  ] as const)('%o says “%s” on screen 1', async (phase, text) => {
    const s = await open();
    await s.to(phase);
    expect(screen.getByTestId('wizard-connect-title')).toHaveTextContent(text);
    expect(stepText()).toBe(`Step 1 of ${STEP_COUNT}`);
    expect(screen.getByTestId('wizard-cancel')).toBeOnTheScreen();
  });

  it(`screen 2: “Step 2 of ${STEP_COUNT}”, the time left in the hold’s last minute, a lost link reconnecting, and Start`, async () => {
    const s = await open();
    await s.to({ kind: 'instructions', aimAllowed: true, holdLeftS: null, reconnecting: false });
    expect(stepText()).toBe(`Step 2 of ${STEP_COUNT}`);
    expect(screen.queryByTestId('wizard-hold-left')).toBeNull();
    await s.to({ kind: 'instructions', aimAllowed: true, holdLeftS: 42, reconnecting: true });
    expect(screen.getByTestId('wizard-hold-left')).toHaveTextContent('Finish setup within 0:42');
    expect(screen.getByTestId('wizard-reconnecting')).toHaveTextContent('Reconnecting…');
    expect(screen.queryByTestId('wizard-next')).toBeNull();
    await tap('wizard-start');
    expect(s.answers).toEqual(['startAim']);
  });

  it('screen 2 explains how to aim DashPal: its title, the three numbered lines ending with the normal driving position, the privacy line', async () => {
    const s = await open();
    await s.to({ kind: 'instructions', aimAllowed: true, holdLeftS: null, reconnecting: false });
    expect(screen.getByTestId('wizard-instructions-title')).toHaveTextContent('Aim DashPal at your face');
    expect(screen.getByTestId('wizard-instructions-title').props.accessibilityLabel).toBe(`Step 2 of ${STEP_COUNT}. Aim DashPal at your face`);
    wiz.instructions.steps.forEach((line, i) => {
      expect(screen.getByTestId(`wizard-instructions-step-${i + 1}`)).toHaveTextContent(`${i + 1}${line}`);
      expect(screen.getByTestId(`wizard-instructions-step-${i + 1}`).props.accessibilityLabel).toBe(`${i + 1}. ${line}`);
    });
    expect(wiz.instructions.steps[2]).toMatch(/normal driving position/);
    expect(screen.getByTestId('wizard-instructions-privacy')).toHaveTextContent(wiz.instructions.privacy);
    expect(screen.getByTestId('wizard-start')).toHaveTextContent('Start');
    expect(screen.queryByTestId('wizard-instructions-aimed-elsewhere')).toBeNull();
  });

  it('a DashPal the other phone aimed (Add another phone): it says so, with Next, and no step number', async () => {
    const s = await open();
    await s.to({ kind: 'instructions', aimAllowed: false, holdLeftS: null, reconnecting: false });
    expect(screen.getByTestId('wizard-instructions-aimed-elsewhere')).toHaveTextContent('Your other phone already aimed DashPal.');
    expect(screen.queryByTestId('wizard-instructions-steps')).toBeNull();
    expect(stepText()).toBe('');
    await tap('wizard-next');
    expect(s.answers).toEqual(['next']);
  });

  it('screen 2 with an aiming picture to start: Start starts it', async () => {
    const w = await appWorld();
    const onStart = jest.fn();
    const onNext = jest.fn();
    await w.render(<StepInstructions aimAllowed holdLeftS={null} reconnecting={false} step="Step 2 of 3" onStart={onStart} onNext={onNext} />);
    expect(screen.getByTestId('wizard-start')).toHaveTextContent('Start');
    expect(screen.queryByTestId('wizard-next')).toBeNull();
    await tap('wizard-start');
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('screen 2 never starts a picture for a DashPal the other phone aimed: Next', async () => {
    const w = await appWorld();
    const onStart = jest.fn();
    const onNext = jest.fn();
    await w.render(<StepInstructions aimAllowed={false} holdLeftS={null} reconnecting={false} step={null} onStart={onStart} onNext={onNext} />);
    expect(screen.queryByTestId('wizard-start')).toBeNull();
    await tap('wizard-next');
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it(`screen 3: “Step 3 of ${STEP_COUNT}”, the picture with Next; Cancel says DashPal will be unpaired; a refusal Try again can help with starts it again`, async () => {
    const s = await open();
    await s.to({ kind: 'aim', status: 'starting', reason: null, holdLeftS: null, reconnecting: false });
    expect(stepText()).toBe(`Step 3 of ${STEP_COUNT}`);
    expect(screen.getByTestId('wizard-aim-title').props.accessibilityLabel).toBe(`Step 3 of ${STEP_COUNT}. Aim DashPal`);
    expect(screen.getByTestId('aim-video')).toBeOnTheScreen();
    expect(screen.getByTestId('aim-hint')).toHaveTextContent('Starting the camera…');
    await s.to({ kind: 'aim', status: 'refused', reason: 'moving', holdLeftS: 42, reconnecting: true });
    expect(screen.getByTestId('wizard-aim-refused')).toHaveTextContent('Stop the car to aim DashPal.');
    expect(screen.getByTestId('wizard-hold-left')).toHaveTextContent('Finish setup within 0:42');
    expect(screen.getByTestId('wizard-reconnecting')).toHaveTextContent('Reconnecting…');
    await tap('wizard-aim-retry');
    await tap('wizard-aim-next');
    expect(s.answers).toEqual(['startAim', 'next']);
    await tap('wizard-cancel');
    expect(screen.getByTestId('wizard-cancel-confirm-body')).toHaveTextContent('DashPal will be unpaired from this phone and ready to pair again.');
    await tap('wizard-cancel-stop');
    expect(outcomes).toEqual(['closed']);
    expect(s.cancelled()).toBe(1);
  });

  it('screen 3 is its own step: it slides in after screen 2', async () => {
    const s = await open();
    await s.to({ kind: 'instructions', aimAllowed: true, holdLeftS: null, reconnecting: false });
    expect(screen.getByTestId('wizard-step-instructions')).toBeOnTheScreen();
    await s.to({ kind: 'aim', status: 'starting', reason: null, holdLeftS: null, reconnecting: false });
    expect(screen.getByTestId('wizard-step-aim')).toBeOnTheScreen();
  });

  it('finishing: “Finishing…” with no Cancel; back and the scrim wait for the answer', async () => {
    const s = await open();
    await s.to({ kind: 'finishing' });
    expect(screen.getByTestId('wizard-connect-title')).toHaveTextContent('Finishing…');
    expect(screen.queryByTestId('wizard-cancel')).toBeNull();
    await pressHidden('wizard-scrim');
    expect(screen.queryByTestId('wizard-cancel-confirm')).toBeNull();
    expect(outcomes).toEqual([]);
  });

  it('a link lost while finishing: still “Finishing…”, with “Reconnecting…” under it and no step number; Cancel stays for the reconnect and says DashPal will be unpaired', async () => {
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const s = await open();
    await s.to({ kind: 'aim', status: 'live', reason: null, holdLeftS: null, reconnecting: false });
    await tap('wizard-aim-next');
    expect(s.answers).toEqual(['next']);
    await s.to({ kind: 'finishing' });
    await s.to({ kind: 'finishing', reconnecting: true });
    expect(screen.getByTestId('wizard-connect-finishing')).toBeOnTheScreen();
    expect(screen.getByTestId('wizard-connect-title')).toHaveTextContent('Finishing…');
    expect(screen.getByTestId('wizard-connect-body')).toHaveTextContent('Reconnecting…');
    expect(say).toHaveBeenLastCalledWith('Reconnecting…');
    expect(stepText()).toBe('');
    await tap('wizard-cancel');
    expect(screen.getByTestId('wizard-cancel-confirm-body')).toHaveTextContent('DashPal will be unpaired from this phone and ready to pair again.');
    await tap('wizard-cancel-stop');
    expect(outcomes).toEqual(['closed']);
    expect(s.cancelled()).toBe(1);
    say.mockRestore();
  });

  it('done: a check mark, “DashPal is ready”, from 2 phones how many and “Not all yours?”, no Cancel; Done, back or the scrim close', async () => {
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const s = await open();
    await s.to({ kind: 'done', paired: PAIRED, phones: 1, notAllYours: false, aimedElsewhere: false });
    expect(screen.getByTestId('wizard-done-check', HIDDEN)).toBeOnTheScreen();
    expect(screen.getByTestId('wizard-done-title')).toHaveTextContent('DashPal is ready');
    expect(screen.getByTestId('wizard-done-body')).toHaveTextContent('DashPal-C4D5 connects by itself whenever it’s on and nearby.');
    expect(screen.queryByTestId('wizard-done-phones')).toBeNull();
    expect(screen.queryByTestId('wizard-done-not-all-yours')).toBeNull();
    expect(screen.queryByTestId('wizard-cancel')).toBeNull();
    expect(stepText()).toBe('');
    expect(say).toHaveBeenCalledWith('DashPal is ready');
    expect(haptics.notificationAsync).toHaveBeenCalledWith('success');
    await s.to({ kind: 'done', paired: PAIRED, phones: 3, notAllYours: true, aimedElsewhere: true });
    expect(screen.getByTestId('wizard-done-phones')).toHaveTextContent('3 phones are paired with this DashPal.');
    expect(screen.getByTestId('wizard-done-not-all-yours')).toHaveTextContent(wiz.done.notAllYours, { exact: false });
    expect(screen.getByTestId('wizard-done-aimed-elsewhere')).toHaveTextContent('Your other phone already aimed it.');
    await pressHidden('wizard-scrim');
    expect(outcomes).toEqual(['done']);
    expect(screen.queryByTestId('wizard-sheet')).toBeNull();
    say.mockRestore();
  });

  it('done’s Done and Android back close it too', async () => {
    const s = await open();
    await s.to({ kind: 'done', paired: PAIRED, phones: 1, notAllYours: false, aimedElsewhere: false });
    await tap('wizard-done');
    expect(outcomes).toEqual(['done']);
    const t = await open();
    await t.to({ kind: 'done', paired: PAIRED, phones: 1, notAllYours: false, aimedElsewhere: false });
    await back();
    expect(outcomes).toEqual(['done', 'done']);
  });

  it.each([
    ['not_found', 'DashPal-C4D5', 'restart', 'Couldn’t reach DashPal-C4D5. Make sure it’s on and nearby.'],
    ['none_nearby', null, 'restart', wiz.failed.none_nearby],
    ['window_closed', 'DashPal-C4D5', 'restart', 'DashPal-C4D5 isn’t ready to pair anymore. Press its button 5 times, then try again.'],
    ['setup_busy', null, 'restart', wiz.failed.setup_busy],
    ['unverified', null, 'restart', wiz.failed.unverified],
    ['update_firmware', null, 'none', wiz.failed.update_firmware],
    ['update_app', null, 'none', wiz.failed.update_app],
    ['mtu', null, 'restart', wiz.failed.mtu],
    ['ios_forget_first', null, 'none', wiz.failed.ios_forget_first],
    ['lost', 'DashPal-C4D5', 'resume', 'Lost the connection to DashPal-C4D5. Try again.'],
    ['expired', null, 'restart', 'Setup took too long. Try again.'],
    ['save_failed', null, 'commit', 'DashPal couldn’t save the pairing. Try again.'],
    ['error', null, 'restart', wiz.failed.error],
  ] as const)('failed %s says so (and to a screen reader); Try again does what the failure says; Close closes', async (reason, name, retry, text) => {
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const s = await open();
    await s.to({ kind: 'failed', reason, name, retry });
    expect(screen.getByTestId('wizard-failed-title')).toHaveTextContent(text);
    expect(say).toHaveBeenLastCalledWith(text);
    say.mockRestore();
    if (retry === 'none') expect(screen.queryByTestId('wizard-retry')).toBeNull();
    else {
      const before = s.made();
      await tap('wizard-retry');
      if (retry === 'restart') expect(s.made()).toBe(before + 1);
      else expect(s.answers).toEqual(['retry']);
      await s.to({ kind: 'failed', reason, name, retry });
    }
    await tap('wizard-close');
    expect(outcomes).toEqual(['closed']);
    expect(s.cancelled()).toBeGreaterThanOrEqual(1);
  });

  it('a drive open: “Finish your drive first.” with Close', async () => {
    const s = await open();
    await s.to({ kind: 'busy' });
    expect(screen.getByTestId('wizard-failed-title')).toHaveTextContent('Finish your drive first.');
    expect(screen.queryByTestId('wizard-retry')).toBeNull();
  });

  it('Bluetooth not allowed: Open Settings and Try again; off: Try again; no Bluetooth LE: Close', async () => {
    const s = await open();
    await s.to({ kind: 'denied' });
    expect(screen.getByTestId('wizard-permission-title')).toHaveTextContent(dashpalCopy.setup.denied);
    await tap('wizard-open-settings');
    expect(adapter.log).toContain('openAppSettings');
    const before = s.made();
    await tap('wizard-retry');
    expect(s.made()).toBe(before + 1);
    await s.to({ kind: 'off' });
    expect(screen.getByTestId('wizard-permission-title')).toHaveTextContent(dashpalCopy.setup.off);
    expect(screen.queryByTestId('wizard-open-settings')).toBeNull();
    await s.to({ kind: 'unavailable' });
    expect(screen.getByTestId('wizard-permission-title')).toHaveTextContent(dashpalCopy.setup.unavailable);
    await tap('wizard-close');
    expect(outcomes).toEqual(['closed']);
  });

  it('a flow that ends cancelled by itself closes the sheet', async () => {
    const s = await open();
    await s.to({ kind: 'cancelled' });
    expect(outcomes).toEqual(['closed']);
  });
});

describe('the flow’s wiring', () => {
  it('reads the drive host, the runtime and the paired DashPal’s refused key live; closing the sheet cancels the flow', async () => {
    const rt = createFakeDashcamRuntime();
    setActiveDashcam(rt);
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(<Host s={s} />);
    const base = s.bases[s.bases.length - 1]!;
    expect(base.isBusy()).toBe(false); // no drive host mounted: never busy
    base.notePhones?.('a4cf12b3c4d5', 2);
    expect(rt.log).toContain('notePhones:a4cf12b3c4d5:2');
    expect(base.keyRefused(PAIRED.dashcamId)).toBe(false);
    rt.set({ link: { paired: PAIRED, lifecycle: 'needs_repair', repairCause: 'unknown_phone' } });
    expect(base.keyRefused(PAIRED.dashcamId)).toBe(true);
    expect(base.keyRefused('a4cf12b3c401')).toBe(false);
    rt.set({ link: { repairCause: 'downgrade' } });
    expect(base.keyRefused(PAIRED.dashcamId)).toBe(false);
    expect(base.paired()).toEqual(PAIRED);
    base.stepAside();
    await base.resumePaired();
    expect(rt.log).toEqual(expect.arrayContaining(['stepAside', 'resumePaired']));
    expect(s.cancelled()).toBe(0);
    await tap('wizard-cancel');
    await tap('wizard-cancel-stop');
    expect(s.cancelled()).toBe(1);
  });
});

describe('Cancel', () => {
  it('asks first: Keep setting up goes back to the step; Stop setup closes the sheet at once and stops the flow', async () => {
    const s = await open();
    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: null });
    expect(screen.getByTestId('wizard-cancel').props.accessibilityLabel).toBe('Cancel setup');
    await tap('wizard-cancel');
    expect(screen.getByTestId('wizard-cancel-confirm-title')).toHaveTextContent('Stop setting up DashPal?');
    expect(screen.getByTestId('wizard-cancel-confirm-body')).toHaveTextContent('DashPal won’t be paired with this phone.');
    expect(screen.getByTestId('wizard-cancel-confirm').props.accessibilityViewIsModal).toBe(true);
    await tap('wizard-cancel-keep');
    expect(screen.queryByTestId('wizard-cancel-confirm')).toBeNull();
    expect(s.cancelled()).toBe(0);
    expect(outcomes).toEqual([]);
    await tap('wizard-cancel');
    await tap('wizard-cancel-stop');
    expect(outcomes).toEqual(['closed']);
    expect(screen.queryByTestId('wizard-sheet')).toBeNull();
    expect(s.cancelled()).toBe(1);
  });

  it.each([
    [{ kind: 'connected', name: 'DashPal-C4D5' }],
    [{ kind: 'instructions', aimAllowed: true, holdLeftS: null, reconnecting: false }],
    [{ kind: 'connecting', name: 'DashPal-C4D5', reconnecting: true }],
    [{ kind: 'failed', reason: 'save_failed', name: null, retry: 'commit' }],
  ] as const)('after the pairing (%o) it says DashPal will be unpaired and ready to pair again', async (phase) => {
    const s = await open();
    await s.to(phase as SetupPhase);
    await tap('wizard-cancel');
    expect(screen.getByTestId('wizard-cancel-confirm-body')).toHaveTextContent('DashPal will be unpaired from this phone and ready to pair again.');
  });

  it('the scrim, Android back and a swipe down on the grabber ask the same; back or the scrim again closes the question', async () => {
    const s = await open();
    await s.to({ kind: 'instructions', aimAllowed: true, holdLeftS: null, reconnecting: false });
    await pressHidden('wizard-scrim');
    expect(screen.getByTestId('wizard-cancel-confirm')).toBeOnTheScreen();
    await back();
    expect(screen.queryByTestId('wizard-cancel-confirm')).toBeNull();
    await back();
    expect(screen.getByTestId('wizard-cancel-confirm')).toBeOnTheScreen();
    await pressHidden('wizard-scrim');
    expect(screen.queryByTestId('wizard-cancel-confirm')).toBeNull();

    const grabber = screen.getByTestId('wizard-grabber', HIDDEN);
    await act(async () => {
      fireEvent(grabber, 'touchStart', { nativeEvent: { pageY: 100 } });
      fireEvent(grabber, 'touchEnd', { nativeEvent: { pageY: 100 + SWIPE_CANCEL_PT - 1 } });
    });
    expect(screen.queryByTestId('wizard-cancel-confirm')).toBeNull();
    await act(async () => {
      fireEvent(grabber, 'touchStart', { nativeEvent: { pageY: 100 } });
      fireEvent(grabber, 'touchEnd', { nativeEvent: { pageY: 100 + SWIPE_CANCEL_PT } });
    });
    expect(screen.getByTestId('wizard-cancel-confirm')).toBeOnTheScreen();
    expect(s.cancelled()).toBe(0);
    expect(outcomes).toEqual([]);
  });

  it('while the question shows, the step is dimmed and inert', async () => {
    const s = await open();
    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: null });
    await tap('wizard-cancel');
    const body = screen.getByTestId('wizard-body', HIDDEN);
    expect(body.props.pointerEvents).toBe('none');
    expect(body.props.importantForAccessibility).toBe('no-hide-descendants');
    await tap('wizard-cancel-keep');
    expect(screen.getByTestId('wizard-body').props.pointerEvents).toBe('auto');
    await tap('wizard-cancel');
    expect(screen.getByTestId('wizard-cancel-confirm')).toBeOnTheScreen();
  });
  it('a step taller than the sheet scrolls inside it, and the question keeps its full height under it, so Stop setup and Keep setting up stay on screen', async () => {
    const s = await open();
    await s.to({ kind: 'instructions', aimAllowed: true, holdLeftS: 42, reconnecting: true });
    await tap('wizard-cancel');
    // The panel is capped at 92% of the screen: the body's frame and its scroll view give way to it…
    const frame = screen.getByTestId('wizard-body-frame', HIDDEN);
    expect(StyleSheet.flatten(frame.props.style).flexShrink).toBe(1);
    const scroll = within(frame).getByTestId('wizard-scroll', HIDDEN);
    expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({ flexGrow: 0, flexShrink: 1 });
    expect(within(scroll).getByTestId('wizard-body', HIDDEN)).toBeOnTheScreen();
    // …and the question, under the scroll view and outside it, does not.
    const question = within(frame).getByTestId('wizard-cancel-confirm');
    expect(within(scroll).queryByTestId('wizard-cancel-confirm')).toBeNull();
    expect(StyleSheet.flatten(question.props.style).flexShrink ?? 0).toBe(0);
    expect(within(question).getByTestId('wizard-cancel-stop')).toBeOnTheScreen();
    expect(within(question).getByTestId('wizard-cancel-keep')).toBeOnTheScreen();
  });
});

describe('focus and motion', () => {
  it('each step’s title takes the screen reader’s focus once the step has slid in; at once under Reduce Motion', async () => {
    jest.useFakeTimers();
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
    try {
      const s = await open();
      await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: null });
      focus.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(STEP_SETTLED_MS - 1);
      });
      expect(focus).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(focus).toHaveBeenCalledTimes(1);

      const still = await open({}, true);
      await still.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: null });
      focus.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(0);
      });
      expect(focus).toHaveBeenCalled();
    } finally {
      focus.mockRestore();
      jest.useRealTimers();
    }
  });

  it('under Reduce Motion every step still shows (the check mark drawn at once)', async () => {
    const s = await open({}, true);
    await s.to({ kind: 'connected', name: 'DashPal-C4D5' });
    expect(screen.getByTestId('wizard-check', HIDDEN)).toBeOnTheScreen();
    await s.to({ kind: 'instructions', aimAllowed: true, holdLeftS: null, reconnecting: false });
    expect(screen.getByTestId('wizard-instructions-title')).toHaveTextContent(wiz.instructions.title);
  });
});
