// The token at the sink (security review T13 I-1): the host's native start/setPolicy wrappers and the
// policy's nativePolicy take a GateToken, never a string, so a forged token does not type-check where it
// is used. The @ts-expect-error lines are checked by `npm run typecheck`.
import { createFakeDmsVision } from '../../../../../modules/dms-vision/src/fake';
import { createCapturePolicy, nativePolicy } from '../../policy/capture';
import { createGate, type GateToken } from '../../policy/gate';
import { gatedNative } from '../native';

const OPEN = { optedIn: true, cameraBeta: true, ageBand: '18_plus' as const, driveActive: true, mode: 'mounted' as const, role: 'driver' as const, appActive: true };

function realToken(): GateToken {
  const r = createGate(() => 'nonce-1').gateOpen(OPEN, 'granted');
  if (!r.open) throw new Error('closed');
  return r.token;
}
const out = createCapturePolicy().next({
  tMs: 0,
  gateOpen: true,
  row: { tMs: 0, speedKmh: 60, imuMoving: true, handling: false },
  quality: 'tracking',
  qualityForMs: 0,
  thermal: 'nominal',
  lowPower: false,
  batteryLevel: 80,
  charging: false,
  setup: false,
  lostLowLight: false,
  gazeNetEvery: 1,
});

test('a forged string is refused by the types at every sink', () => {
  const native = gatedNative(createFakeDmsVision());
  const run = () => {
    // @ts-expect-error a plain string is not a GateToken (nativePolicy)
    nativePolicy(out, 'forged');
    // @ts-expect-error a plain string is not a GateToken (the host's native start)
    void native.start({ gateToken: 'forged', fps: 15, gazeNet: false, gazeNetEvery: 1, delegate: 'cpu', rotationOffsetDegrees: 0 });
    // @ts-expect-error a plain string is not a GateToken (the host's native setPolicy)
    void native.setPolicy({ gateToken: 'forged', capture: 'run', fps: 15, gazeNet: false, gazeNetEvery: 1, setupMode: false, previewAllowed: false });
  };
  expect(typeof run).toBe('function'); // compiled, never run: the proof is the type check
});

test('a real token passes through to native', async () => {
  const fake = createFakeDmsVision();
  const native = gatedNative(fake);
  const token = realToken();
  await native.start({ gateToken: token, fps: 15, gazeNet: false, gazeNetEvery: 1, delegate: 'cpu', rotationOffsetDegrees: 0 });
  await native.setPolicy(nativePolicy(out, token)!);
  expect(fake.calls.map((c) => c.method)).toEqual(['start', 'setPolicy']);
  expect((fake.calls[1]!.args[0] as { gateToken: string }).gateToken).toBe('nonce-1');
  expect(fake.nativeState()).toBe('running');
});
