import { useEffect, useState, type ReactNode } from 'react';

import { dashpalCopy } from '../../copy';
import type { SetupPhase, SetupStart } from '../../setup';
import { CancelConfirm } from './CancelConfirm';
import { StepAim } from './StepAim';
import { StepChoose } from './StepChoose';
import { StepConfirm } from './StepConfirm';
import { StepConnecting } from './StepConnecting';
import { StepDone } from './StepDone';
import { failureText, StepFailed } from './StepFailed';
import { StepInstructions } from './StepInstructions';
import { StepPermission } from './StepPermission';
import { StepSearch } from './StepSearch';
import { StepTransition } from './StepTransition';
import { useSetupFlow, type SetupFlowDeps } from './useSetupFlow';
import { WizardFrame } from './WizardFrame';

const copy = dashpalCopy.wizard;

/** The numbered steps: 1 the DashPal and Pair (and connecting), 2 how to aim it, 3 the live picture. */
export const STEP_COUNT = 3;

/** The step number a phase shows in the header, or null (search, choose, outcomes, finishing, done, aiming skipped). */
export function stepNumber(p: SetupPhase): number | null {
  switch (p.kind) {
    case 'confirm':
    case 'press_button':
    case 'waiting_busy':
    case 'connecting':
    case 'connected':
      return 1;
    case 'instructions':
      // A DashPal the other phone aimed (Add another phone) has no aiming step: no number.
      return p.aimAllowed ? 2 : null;
    case 'aim':
      return 3;
    default:
      return null;
  }
}

/** Which screen a phase belongs to: a new screen slides in, a change within one does not. */
export function stepKey(p: SetupPhase): string {
  switch (p.kind) {
    case 'idle':
    case 'permission':
    case 'denied':
    case 'off':
    case 'unavailable':
      return 'permission';
    case 'press_button':
    case 'waiting_busy':
    case 'connecting':
    case 'connected':
      return 'connect';
    case 'busy':
    case 'failed':
      return 'failed';
    case 'stopping':
    case 'cancelled':
      return 'finishing';
    default:
      return p.kind;
  }
}

/** The DashPal may hold this phone's pairing: stopping then unpairs it on both sides. */
export function holdsPairing(p: SetupPhase): boolean {
  switch (p.kind) {
    case 'connected':
    case 'instructions':
    case 'aim':
    case 'finishing':
      return true;
    case 'connecting':
      return p.reconnecting;
    case 'failed':
      return p.retry === 'commit' || p.retry === 'resume';
    default:
      return false;
  }
}

/**
 * The DashPal setup as a bottom sheet, opened by Home's card, Settings › DashPal and onboarding's
 * Find my DashPal: `start` says on which DashPal (none: search mode), null keeps it closed. Each
 * step slides in; Cancel at the top, the scrim, Android back and a swipe down on the grabber ask
 * "Stop setting up DashPal?" first, and Stop setup closes the sheet at once while the flow undoes a
 * pairing it made, on both sides. Done (no Cancel) closes it.
 */
export function PairWizardSheet({
  start,
  onClose,
  onPhase,
  deps,
}: {
  start: SetupStart | null;
  onClose(outcome: 'done' | 'closed'): void;
  onPhase?(p: SetupPhase): void;
  deps?: SetupFlowDeps;
}) {
  const visible = start !== null;
  const { phase, flow, adapter, restart } = useSetupFlow({ start: start ?? {}, deps, active: visible, onPhase });
  const [confirming, setConfirming] = useState(false);

  // A closed sheet forgets its open question.
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (!visible) setConfirming(false);
  }
  // A setup that ended cancelled (by the flow itself) closes the sheet.
  useEffect(() => {
    if (visible && phase.kind === 'cancelled') onClose('closed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, phase.kind]);

  const n = stepNumber(phase);
  const step = n !== null ? copy.step(n, STEP_COUNT) : null;
  // While finishing only a reconnect (up to 45 s) can be cancelled; otherwise the commit's answer decides (≤ 2 s).
  const cancellable = phase.kind !== 'done' && phase.kind !== 'stopping' && (phase.kind !== 'finishing' || phase.reconnecting === true);

  const requestCancel = () => {
    if (confirming) {
      setConfirming(false);
      return;
    }
    if (phase.kind === 'done') {
      onClose('done');
      return;
    }
    if (!cancellable) return; // the commit's answer decides (≤ 2 s)
    setConfirming(true);
  };
  const stop = () => {
    setConfirming(false);
    onClose('closed');
  };
  const retry = () => {
    if (phase.kind === 'failed' && phase.retry !== 'restart') void flow.retry();
    else restart();
  };
  const openSettings = () => void adapter.openAppSettings().catch(() => {});

  let body: ReactNode = null;
  switch (phase.kind) {
    case 'idle':
    case 'permission':
      body = <StepPermission view="asking" onOpenSettings={openSettings} onRetry={retry} onClose={stop} />;
      break;
    case 'denied':
    case 'off':
    case 'unavailable':
      body = <StepPermission view={phase.kind} onOpenSettings={openSettings} onRetry={retry} onClose={stop} />;
      break;
    case 'search':
      body = <StepSearch />;
      break;
    case 'choose':
      body = <StepChoose candidates={phase.candidates} onPick={(id) => flow.pick(id)} />;
      break;
    case 'confirm':
      body = <StepConfirm name={phase.name} mode={phase.mode} replaces={phase.replaces} step={step} onPair={() => flow.pair()} />;
      break;
    case 'connecting':
      body = <StepConnecting view={{ kind: 'connecting', name: phase.name, reconnecting: phase.reconnecting }} step={step} />;
      break;
    case 'connected':
      body = <StepConnecting view={{ kind: 'connected', name: phase.name }} step={step} />;
      break;
    case 'press_button':
    case 'waiting_busy':
      body = <StepConnecting view={{ kind: phase.kind, name: phase.name }} step={step} />;
      break;
    case 'instructions':
      body = (
        <StepInstructions
          aimAllowed={phase.aimAllowed}
          holdLeftS={phase.holdLeftS}
          reconnecting={phase.reconnecting}
          step={step}
          onStart={() => flow.startAim()}
          onNext={() => flow.next()}
        />
      );
      break;
    case 'aim':
      body = (
        <StepAim
          status={phase.status}
          reason={phase.reason}
          holdLeftS={phase.holdLeftS}
          reconnecting={phase.reconnecting}
          step={step}
          flow={flow}
          onRetry={() => flow.startAim()}
          onNext={() => flow.next()}
        />
      );
      break;
    case 'finishing':
      body = <StepConnecting view={{ kind: 'finishing', reconnecting: phase.reconnecting === true }} step={null} />;
      break;
    case 'stopping':
    case 'cancelled':
      body = <StepConnecting view={{ kind: 'finishing', reconnecting: false }} step={null} />;
      break;
    case 'done':
      body = <StepDone paired={phase.paired} phones={phase.phones} notAllYours={phase.notAllYours} aimedElsewhere={phase.aimedElsewhere} onDone={() => onClose('done')} />;
      break;
    case 'busy':
      body = <StepFailed text={copy.failed.busy} retry="none" onRetry={retry} onClose={stop} />;
      break;
    case 'failed':
      body = <StepFailed text={failureText(phase.reason, phase.name)} retry={phase.retry} onRetry={retry} onClose={stop} />;
      break;
  }

  return (
    <WizardFrame
      visible={visible}
      step={step}
      stepIndex={n}
      stepCount={STEP_COUNT}
      cancel={cancellable}
      onRequestCancel={requestCancel}
      dimmed={confirming}
      overlay={confirming ? <CancelConfirm paired={holdsPairing(phase)} onStop={stop} onKeep={() => setConfirming(false)} /> : null}
    >
      <StepTransition stepKey={stepKey(phase)}>{body}</StepTransition>
    </WizardFrame>
  );
}
