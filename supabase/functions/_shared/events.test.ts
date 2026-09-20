import { assertEquals } from '@std/assert';
import { deriveEvents, hasSevereSpeeding } from './events.ts';
import { event, payload, provisionalFor, T0 } from './testing/fixtures.ts';

Deno.test('deriveEvents replaces the device\'s severity, multiplier and deduction with the server\'s', () => {
  const p = payload();
  const lying = [event({ severity: 0, contextMultiplier: 1.5, deduction: 0 })];
  const [e] = deriveEvents(lying, p.provisional);
  assertEquals(e.severity, 1); // a pickup at 35 mph is the top phone band
  assertEquals(e.contextMultiplier, 1);
  assertEquals(e.deduction, p.provisional.eventDeductions.p1);
  assertEquals(e.id, 'p1');
  assertEquals(e.measured, { speedMps: 15.6464 });
});

Deno.test('deriveEvents applies the night multiplier from the event\'s own context', () => {
  const night = [event({ context: { night: true, precipitation: false } })];
  const p = payload({ events: night });
  const [e] = deriveEvents(night, provisionalFor(p));
  assertEquals(e.contextMultiplier, 1.2);
});

Deno.test('deriveEvents gives every event a null deduction on an unscored trip', () => {
  const p = payload({ role: 'passenger' });
  assertEquals(p.provisional.status, 'unscored');
  const [e] = deriveEvents([event({ deduction: 5 })], p.provisional);
  assertEquals(e.deduction, null);
});

Deno.test('a possible event costs nothing even when the device says otherwise', () => {
  const events = [event(), event({ id: 'p2', status: 'possible', startedAt: T0 + 400_000, deduction: 9 })];
  const p = payload({ events });
  const derived = deriveEvents(events, p.provisional);
  assertEquals(derived[1].deduction, 0);
});

Deno.test('hasSevereSpeeding is a scored speeding event at or beyond 20 mph over', () => {
  const severe = event({ id: 's', category: 'speeding', measured: { overMps: 8.9408, limitMps: 20 }, source: 'gnss' });
  assertEquals(hasSevereSpeeding([event(), severe]), true);
  assertEquals(hasSevereSpeeding([{ ...severe, measured: { overMps: 8.94, limitMps: 20 } }]), false);
  assertEquals(hasSevereSpeeding([{ ...severe, status: 'possible' }]), false);
  assertEquals(hasSevereSpeeding([{ ...severe, status: 'removed' }]), false);
  assertEquals(hasSevereSpeeding([]), false);
});
