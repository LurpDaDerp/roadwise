import { assert, assertEquals } from '@std/assert';
import { createSendEmail, MAX_BODY_BYTES, type SendEmailDeps } from './handler.ts';
import type { Delivery, Mail } from './mail.ts';

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

const payload = (type: string, over: { token?: string; email?: string } = {}) =>
  JSON.stringify({
    user: { id: USER, aud: 'authenticated', role: '', email: over.email ?? 'Ava@Example.com', user_metadata: { username: 'x' } },
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
  sent: { apiKey: string; mail: Mail }[];
  logs: unknown[][];
}

function world(over: Partial<SendEmailDeps> = {}, opts: { capped?: boolean; delivery?: Delivery } = {}): World {
  const w: World = { taken: [], sent: [], logs: [], deps: undefined as unknown as SendEmailDeps };
  const record = (...args: unknown[]) => void w.logs.push(args);
  w.deps = {
    hookSecret: SECRET,
    resendKey: 're_test_key',
    from: 'no-reply@mail.example.com',
    takeMail: (hash) => {
      w.taken.push(hash);
      return Promise.resolve(!opts.capped);
    },
    deliver: (apiKey, mail) => {
      w.sent.push({ apiKey, mail });
      return Promise.resolve(opts.delivery ?? { sent: true });
    },
    nowS: () => NOW,
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

Deno.test('the type allowlist: every type but signup is refused with 403, and nothing is taken or sent', async () => {
  for (const type of ['recovery', 'magiclink', 'email', 'invite', 'email_change', 'reauthentication', 'something_new']) {
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
