// The BLE manager at module load (plan §7.4), from `index.ts`, before any React tree or the runtime:
// iOS state restoration emits once, during `start()`, and only if the app's restore identifier is
// registered in that process. Only when the driver opted into DashPal (`dashpal.enabled`): nobody
// without a DashPal ever sees the Bluetooth permission prompt. The paired peripheral comes from
// SecureStore too, so a restored connection is kept and every other one cancelled before SQLite is
// open; bootstrap later sets the target from the database (the source of truth).
import { getDashcamTransport, type DashcamTransport } from './transport';
import { readDashpalEnabled, readSecureTarget } from './secure';

export async function startDashpalEarly(deps: { transport?: () => DashcamTransport; onError?: (e: unknown) => void } = {}): Promise<boolean> {
  try {
    if (!(await readDashpalEnabled())) return false;
    const transport = (deps.transport ?? getDashcamTransport)();
    const target = await readSecureTarget();
    if (target && transport.target() === null) transport.setTarget(target);
    await transport.start();
    return true;
  } catch (e) {
    deps.onError?.(e);
    return false;
  }
}
