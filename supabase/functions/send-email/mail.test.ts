import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { codeMail, fromHeader, RESEND_URL, sendWithResend, signInReminderMail } from './mail.ts';

Deno.test('the mail carries the code, the warning and nothing from the request but the code', () => {
  const m = codeMail('signup', '12345678', 'no-reply@mail.example.com', 'ava@example.com');
  assertEquals(m.subject, '12345678 is your RoadWise code');
  assertEquals(m.to, 'ava@example.com');
  for (const body of [m.html, m.text]) {
    assertStringIncludes(body, '12345678');
    assertStringIncludes(body, 'It works for 10 minutes.');
    assertStringIncludes(body, 'Never share this code. RoadWise will never ask you for it.');
    // No address, no link.
    assert(!body.includes('ava@example.com'));
    assert(!/https?:|href=/i.test(body));
  }
});

Deno.test('the reset mail says what its code is for, and carries no address or link either', () => {
  const m = codeMail('recovery', '87654321', 'no-reply@mail.example.com', 'ava@example.com');
  assertEquals(m.subject, '87654321 is your RoadWise reset code');
  for (const body of [m.html, m.text]) {
    assertStringIncludes(body, '87654321');
    assertStringIncludes(body, 'Reset your password');
    assertStringIncludes(body, 'Enter this code in RoadWise to choose a new password.');
    assertStringIncludes(body, 'It works for 10 minutes.');
    assertStringIncludes(body, 'Never share this code. RoadWise will never ask you for it.');
    assert(!body.includes('ava@example.com'));
    assert(!/https?:|href=/i.test(body));
  }
  const signup = codeMail('signup', '87654321', 'no-reply@mail.example.com', 'ava@example.com');
  assert(!signup.text.includes('Reset your password'));
});

Deno.test('a bare From address gets the RoadWise name; a named one is kept', () => {
  assertEquals(fromHeader(' no-reply@mail.example.com '), 'RoadWise <no-reply@mail.example.com>');
  assertEquals(fromHeader('RoadWise Codes <codes@mail.example.com>'), 'RoadWise Codes <codes@mail.example.com>');
});

Deno.test('Resend gets one POST with the key, the From, one recipient and both bodies', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));
  }) as typeof fetch;
  const mail = codeMail('signup', '12345678', 'no-reply@mail.example.com', 'ava@example.com');
  assertEquals(await sendWithResend('re_test', mail, { idempotencyKey: 'msg_1' }, fake), { sent: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, RESEND_URL);
  assertEquals(calls[0].init.method, 'POST');
  assertEquals(new Headers(calls[0].init.headers).get('authorization'), 'Bearer re_test');
  assertEquals(new Headers(calls[0].init.headers).get('idempotency-key'), 'msg_1');
  const body = JSON.parse(String(calls[0].init.body));
  assertEquals(body.from, 'RoadWise <no-reply@mail.example.com>');
  assertEquals(body.to, ['ava@example.com']);
  assertEquals(body.subject, mail.subject);
  assertEquals([body.html, body.text], [mail.html, mail.text]);
});

Deno.test('a refusal reports Resend’s status and error name; no answer reports none', async () => {
  const refused = (() =>
    Promise.resolve(new Response(JSON.stringify({ name: 'validation_error', message: 'The domain is not verified' }), { status: 403 }))) as typeof fetch;
  assertEquals(await sendWithResend('re_test', codeMail('signup', '12345678', 'a@b.c', 'd@e.f'), {}, refused), {
    sent: false,
    status: 403,
    reason: 'validation_error',
  });
  const down = (() => Promise.reject(new TypeError('network'))) as typeof fetch;
  assertEquals(await sendWithResend('re_test', codeMail('signup', '12345678', 'a@b.c', 'd@e.f'), {}, down), {
    sent: false,
    status: null,
    reason: 'TypeError',
  });
});

Deno.test('the sign-in reminder names how the account signs in and carries no code or link', () => {
  const m = signInReminderMail('google', 'no-reply@mail.example.com', 'ava@example.com');
  assertEquals(m.subject, 'How you sign in to RoadWise');
  assertEquals(m.from, 'RoadWise <no-reply@mail.example.com>');
  for (const body of [m.html, m.text]) {
    assertStringIncludes(body, 'you sign in with Google. Open RoadWise and select Continue with Google.');
    assert(!body.includes('ava@example.com'));
    assert(!/https?:|href=/i.test(body));
    assert(!/d{6}/.test(body));
  }
});
