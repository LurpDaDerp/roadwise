import { assert, assertEquals } from '@std/assert';
import {
  capKey,
  createSendEmail,
  DEADLINE_MS,
  hasEmailSignIn,
  ipKey,
  MAX_BODY_BYTES,
  signInWith,
  type CapAnswer,
  type SendEmailDeps,
} from './handler.ts';
import type { Delivery, DeliveryOptions, Mail } from './mail.ts';

const KEY = new Uint8Array(32).map((_, i) => i * 7);
const SECRET = ['v1,whsec', btoa(String.fromCharCode(...KEY))].join('_');
const NOW = 1790000000;
const USER = '11111111-1111-4111-8111-111111111111';

/** Signs a body the way Auth does (Standard Webhooks), independently of signature.ts. */
async function signed(body: string, opts: { key?: Uint8Array<ArrayBuffer>; ts?: number } = {}): Promise<Request> {
  const id = 'msg_' + crypto.randomUUID();
  const ts = String(opts.ts ?? NOW);
  const k = await crypto.subtle.importKey('raw', opts.key ?? KEY, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return new Request('http://localhost/functions/v1/send-email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${btoa(String.fromCharCode(...sig))}`,
    },
    body,
  });
}

const payload = (
  type: string,
  over: { token?: string; email?: string; providers?: string[] | null; ip?: string | null } = {}
) =>
  JSON.stringify({
    user: {
      id: USER,
      aud: 'authenticated',
      role: '',
      email: over.email ?? 'Ava@Example.com',
      ...(over.providers === null ? {} : { app_metadata: { provider: 'email', providers: over.providers ?? ['email'] } }),
      user_metadata: { username: 'x' },
    },
    ...(over.ip === null || over.ip === undefined ? {} : { metadata: { ip_address: over.ip } }),
    email_data: {
      token: over.token ?? '12345678',
      token_hash: 'pkce_abc',
      redirect_to: '',
      email_action_type: type,
      site_url: 'https://example.com',
      token_new: '',
      token_hash_new: '',
    },
  });

interface World {
  deps: SendEmailDeps;
  taken: Uint8Array[];
  takenIp: (Uint8Array | null)[];
  sent: { apiKey: string; mail: Mail; options: DeliveryOptions }[];
  logs: unknown[][];
}

function world(
  over: Partial<SendEmailDeps> = {},
  opts: { capped?: boolean; cap?: CapAnswer; delivery?: Delivery; clock?: number[] } = {}
): World {
  const w: World = { taken: [], takenIp: [], sent: [], logs: [], deps: undefined as unknown as SendEmailDeps };
  // Milliseconds handed out in turn by nowMs (the last one repeats); 0 by default.
  const clock = opts.clock ?? [0];
  let tick = 0;
  const record = (...args: unknown[]) => void w.logs.push(args);
  w.deps = {
    hookSecret: SECRET,
    resendKey: 're_test_key',
    from: 'no-reply@mail.example.com',
    takeMail: (hash, ipHash) => {
      w.taken.push(hash);
      w.takenIp.push(ipHash);
      return Promise.resolve(opts.cap ?? (opts.capped ? 'address' : 'ok'));
    },
    deliver: (apiKey, mail, options) => {
      w.sent.push({ apiKey, mail, options });
      return Promise.resolve(opts.delivery ?? { sent: true });
    },
    nowS: () => NOW,
    nowMs: () => clock[Math.min(tick++, clock.length - 1)],
    log: { info: record, warn: record, error: record },
    ...over,
  };
  return w;
}

async function call(w: World, req: Request): Promise<{ status: number; body: unknown }> {
  const res = await createSendEmail(w.deps)(req);
  assertEquals(res.headers.get('content-type'), 'application/json');
  return { status: res.status, body: await res.json() };
}

/** What Auth reads as a refusal of the request with this status: a 200 carrying `error`. */
const assertRefusal = (got: { status: number; body: unknown }, httpCode: number) => {
  assertEquals(got.status, 200);
  const err = (got.body as { error?: { http_code?: unknown; message?: unknown } }).error;
  assertEquals(err?.http_code, httpCode);
  assert(typeof err?.message === 'string' && err.message.length > 0);
};

/** No log line may carry the code, the address or the secret. */
const assertQuietLogs = (w: World) => {
  const text = JSON.stringify(w.logs);
  for (const secret of ['12345678', 'Ava@Example.com', 'ava@example.com', 're_test_key', SECRET]) {
    assert(!text.includes(secret), `a log carries ${secret}`);
  }
};

Deno.test('a signed sign-up mail goes out through Resend once, to the account’s address, with the code', async () => {
  const w = world();
  assertEquals(await call(w, await signed(payload('signup'))), { status: 200, body: {} });
  assertEquals(w.sent.length, 1);
  assertEquals(w.sent[0].apiKey, 're_test_key');
  assertEquals(w.sent[0].mail.to, 'Ava@Example.com');
  assertEquals(w.sent[0].mail.from, 'RoadWise <no-reply@mail.example.com>');
  assertEquals(w.sent[0].mail.subject, '12345678 is your RoadWise code');
  // The cap is keyed by SHA256 of the lower-cased address.
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ava@example.com')));
  assertEquals(w.taken, [expected]);
  assertQuietLogs(w);
});

Deno.test('a signed password-reset mail goes out the same way, as a reset code, against the same cap', async () => {
  const w = world();
  assertEquals(await call(w, await signed(payload('recovery', { providers: ['email', 'google'] }))), { status: 200, body: {} });
  assertEquals(w.sent.length, 1);
  assertEquals(w.sent[0].mail.to, 'Ava@Example.com');
  assertEquals(w.sent[0].mail.subject, '12345678 is your RoadWise reset code');
  assert(w.sent[0].mail.text.includes('Reset your password'));
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ava@example.com')));
  assertEquals(w.taken, [expected]);
  assertQuietLogs(w);

  const capped = world({}, { capped: true });
  assertRefusal(await call(capped, await signed(payload('recovery'))), 429);
  assertEquals([capped.taken.length, capped.sent.length], [1, 0]);
});

Deno.test('Forgot password for an Apple or Google account sends no code, only how it signs in, under the same cap', async () => {
  for (const [providers, how] of [
    [['google'], 'you sign in with Google. Open RoadWise and tap Continue with Google.'],
    [['apple'], 'you sign in with Apple. Open RoadWise and tap Continue with Apple.'],
    [['apple', 'google'], 'you sign in with Apple or Google.'],
    [[], 'you sign in with Apple or Google.'],
    // No list at all: no code (a mailbox must never become a way in the account did not have).
    [null, 'you sign in with Apple or Google.'],
  ] as const) {
    const w = world();
    assertEquals(
      await call(w, await signed(payload('recovery', { providers: providers === null ? null : [...providers] }))),
      { status: 200, body: {} }
    );
    assertEquals(w.sent.length, 1);
    const mail = w.sent[0].mail;
    assertEquals(mail.subject, 'How you sign in to RoadWise');
    assertEquals(mail.to, 'Ava@Example.com');
    for (const body of [mail.html, mail.text]) {
      assert(!body.includes('12345678'), 'the reminder carries no code');
      assert(body.includes(how), body);
      assert(!/https?:|href=/i.test(body));
    }
    assertEquals(w.taken.length, 1);
    assertQuietLogs(w);
  }
});

Deno.test('a sign-up code goes out whatever the providers say (the account is being made)', async () => {
  const w = world();
  assertEquals(await call(w, await signed(payload('signup', { providers: null }))), { status: 200, body: {} });
  assertEquals(w.sent[0].mail.subject, '12345678 is your RoadWise code');
});

Deno.test('the IP Auth reports is capped too, by its hash; one over its cap is a 429 with no mail', async () => {
  const w = world();
  assertEquals(await call(w, await signed(payload('signup', { ip: ' 203.0.113.7 ' }))), { status: 200, body: {} });
  const ipHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ip:203.0.113.7')));
  assertEquals(w.takenIp, [ipHash]);
  assert(!JSON.stringify(w.logs).includes('203.0.113.7'), 'no log carries the IP');

  const noIp = world();
  await call(noIp, await signed(payload('signup')));
  assertEquals(noIp.takenIp, [null]);

  const capped = world({}, { cap: 'ip' });
  assertRefusal(await call(capped, await signed(payload('signup', { ip: '203.0.113.7' }))), 429);
  assertEquals(capped.sent.length, 0);
});

Deno.test('the IP key: "ip:" and a lower-cased address; nothing for anything else', () => {
  assertEquals(ipKey('203.0.113.7'), 'ip:203.0.113.7');
  assertEquals(ipKey(' 2001:DB8::1 '), 'ip:2001:db8::1');
  for (const bad of [undefined, '', '   ', 'not an ip', '203.0.113.7; drop', 'x'.repeat(65)]) assertEquals(ipKey(bad), null, String(bad));
});

Deno.test('which accounts may get a reset code, and what the reminder names', () => {
  assertEquals(hasEmailSignIn(['email']), true);
  assertEquals(hasEmailSignIn(['google', 'email']), true);
  assertEquals(hasEmailSignIn(['google']), false);
  assertEquals(hasEmailSignIn(undefined), false);
  assertEquals(signInWith(['apple']), 'apple');
  assertEquals(signInWith(['google']), 'google');
  assertEquals(signInWith(['apple', 'google']), 'apple_or_google');
  assertEquals(signInWith(undefined), 'apple_or_google');
});

Deno.test('Resend gets what is left of the hook deadline (at most 3.5 s) and the call id as its idempotency key', async () => {
  const w = world({}, { clock: [1_000, 2_000] });
  const req = await signed(payload('signup'));
  const webhookId = req.headers.get('webhook-id');
  assertEquals(await call(w, req), { status: 200, body: {} });
  assertEquals(w.sent[0].options, { timeoutMs: DEADLINE_MS - 1_000 - 100, idempotencyKey: webhookId ?? undefined });

  const fresh = world();
  await call(fresh, await signed(payload('signup')));
  assertEquals(fresh.sent[0].options.timeoutMs, 3_500);
});

Deno.test('with too little of the deadline left after the cap, nothing is sent (504), so no mail outlives the request', async () => {
  const w = world({}, { clock: [0, DEADLINE_MS - 500] });
  assertRefusal(await call(w, await signed(payload('signup'))), 504);
  assertEquals(w.sent.length, 0);
  assertQuietLogs(w);
});

Deno.test('the type allowlist: every type but signup and recovery is refused with 403, and nothing is taken or sent', async () => {
  for (const type of ['magiclink', 'email', 'invite', 'email_change', 'reauthentication', 'something_new', 'Signup', 'recovery ']) {
    const w = world();
    assertRefusal(await call(w, await signed(payload(type))), 403);
    assertEquals([w.taken.length, w.sent.length], [0, 0], type);
    assertQuietLogs(w);
  }
});

Deno.test('a security notification carries no code: it is skipped without a mail, and the change it reports goes on', async () => {
  for (const type of ['password_changed_notification', 'email_changed_notification', 'identity_linked_notification']) {
    const w = world();
    assertEquals(await call(w, await signed(payload(type))), { status: 200, body: {} });
    assertEquals([w.taken.length, w.sent.length], [0, 0], type);
  }
});

Deno.test('a signature that is missing, wrong, from another key or stale is a 401 before anything else', async () => {
  const good = await signed(payload('signup'));
  const cases: Request[] = [
    new Request(good.url, { method: 'POST', body: payload('signup') }),
    await signed(payload('signup'), { key: new Uint8Array(32).fill(9) }),
    await signed(payload('signup'), { ts: NOW - 301 }),
  ];
  const tampered = await signed(payload('signup'));
  cases.push(new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: payload('signup', { email: 'mallory@example.com' }) }));
  for (const req of cases) {
    const w = world();
    const got = await call(w, req);
    assertEquals(got.status, 401);
    assertEquals([w.taken.length, w.sent.length], [0, 0]);
  }
});

Deno.test('missing secrets: no hook secret refuses every call; no Resend key or From refuses a sign-up mail', async () => {
  for (const hookSecret of [null, 'not-a-secret', ['whsec', btoa('k'.repeat(32))].join('_')]) {
    const w = world({ hookSecret });
    assertRefusal(await call(w, await signed(payload('signup'))), 500);
    assertEquals([w.taken.length, w.sent.length], [0, 0]);
    assert(JSON.stringify(w.logs).includes('SEND_EMAIL_HOOK_SECRET'));
  }
  for (const over of [{ resendKey: null }, { from: null }]) {
    const w = world(over);
    assertRefusal(await call(w, await signed(payload('signup'))), 500);
    assertEquals([w.taken.length, w.sent.length], [0, 0]);
    assert(JSON.stringify(w.logs).includes('RESEND_API_KEY or RESEND_FROM'));
    assertQuietLogs(w);
  }
});

Deno.test('the per-address cap: a capped address is refused with 429 and gets no mail', async () => {
  const w = world({}, { capped: true });
  assertRefusal(await call(w, await signed(payload('signup'))), 429);
  assertEquals([w.taken.length, w.sent.length], [1, 0]);
  assertQuietLogs(w);
});

Deno.test('a cap that cannot be checked sends nothing (fail closed)', async () => {
  const w = world({ takeMail: () => Promise.reject(new Error('db down')) });
  assertRefusal(await call(w, await signed(payload('signup'))), 500);
  assertEquals(w.sent.length, 0);
});

Deno.test('Resend refusing or not answering is a 502 refusal, logged with its status and reason only', async () => {
  const w = world({}, { delivery: { sent: false, status: 403, reason: 'validation_error' } });
  assertRefusal(await call(w, await signed(payload('signup'))), 502);
  assert(JSON.stringify(w.logs).includes('validation_error'));
  assertQuietLogs(w);
});

Deno.test('a payload that is not Auth’s shape, a code that is not digits or an odd address is refused with 400', async () => {
  for (const body of [
    'not json',
    JSON.stringify({ user: { id: USER } }),
    payload('signup', { token: '12ab5678' }),
    payload('signup', { token: '' }),
    payload('signup', { email: 'no-at-sign' }),
  ]) {
    const w = world();
    assertRefusal(await call(w, await signed(body)), 400);
    assertEquals([w.taken.length, w.sent.length], [0, 0], body);
  }
});

Deno.test('only POST', async () => {
  const w = world();
  const got = await call(w, new Request('http://localhost/', { method: 'GET' }));
  assertEquals(got.status, 405);
});

Deno.test('a body over the cap with its length declared is refused (413) before it is read', async () => {
  const w = world();
  const big = await signed('x'.repeat(MAX_BODY_BYTES + 1));
  assertEquals((await call(w, big)).status, 413);
  assertEquals([w.taken.length, w.sent.length], [0, 0]);
});

Deno.test('a chunked body with no length is cut off at the cap: the stream is cancelled, never read to its end', async () => {
  const chunk = new Uint8Array(16_384).fill(120);
  let pulled = 0;
  let cancelled = false;
  // An endless stream: reading it whole would never finish.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request('http://localhost/functions/v1/send-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': 'msg_x', 'webhook-timestamp': String(NOW), 'webhook-signature': 'v1,x' },
    body: stream,
  });
  assertEquals(req.headers.get('content-length'), null);
  const w = world();
  assertEquals((await call(w, req)).status, 413);
  assert(cancelled, 'the stream was cancelled');
  // The cap (64 KB) is passed on the 5th 16 KB chunk; nothing much past it is pulled.
  assert(pulled <= 6, `pulled ${pulled} chunks`);
  assertEquals([w.taken.length, w.sent.length], [0, 0]);
});

Deno.test('a chunked body under the cap is read whole and checked as usual', async () => {
  const signedReq = await signed(payload('signup'));
  const text = await signedReq.text();
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 10));
      controller.enqueue(bytes.slice(10));
      controller.close();
    },
  });
  const headers = new Headers(signedReq.headers);
  headers.delete('content-length');
  const w = world();
  assertEquals(await call(w, new Request(signedReq.url, { method: 'POST', headers, body: stream })), { status: 200, body: {} });
  assertEquals(w.sent.length, 1);
});

Deno.test('the cap key: one inbox, one cap (lower case, no +tag anywhere, Gmail without dots on gmail.com)', () => {
  assertEquals(capKey('victim+1@gmail.com'), 'victim@gmail.com');
  assertEquals(capKey('v.ictim@gmail.com'), 'victim@gmail.com');
  assertEquals(capKey(' Victim@GoogleMail.com '), 'victim@gmail.com');
  assertEquals(capKey('V.i.c.t.i.m+roadwise@googlemail.com'), 'victim@gmail.com');
  assertEquals(capKey('Ava+x@Example.com'), 'ava@example.com');
  // Elsewhere a dot is part of the name.
  assertEquals(capKey('a.b@example.com'), 'a.b@example.com');
  // A name that is only a tag keeps it rather than becoming empty.
  assertEquals(capKey('+x@example.com'), '+x@example.com');
});

Deno.test('spellings of one Gmail inbox are counted as one address, and each mail still goes where it was asked', async () => {
  const w = world();
  for (const email of ['victim+1@gmail.com', 'v.ictim@gmail.com', 'Victim@GoogleMail.com']) {
    assertEquals((await call(w, await signed(payload('signup', { email })))).status, 200);
  }
  const key = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('victim@gmail.com')));
  assertEquals(w.taken, [key, key, key]);
  assertEquals(
    w.sent.map((s) => s.mail.to),
    ['victim+1@gmail.com', 'v.ictim@gmail.com', 'Victim@GoogleMail.com']
  );
});
