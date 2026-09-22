import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  DEFAULT_EXPO_PUSH_URL,
  ExpoUnavailable,
  getReceipts,
  RECEIPT_CHUNK,
  SEND_CHUNK,
  sendPush,
  type ExpoMessage,
} from './expo_push.ts';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in: records every call and answers with `reply(call, index)`. */
function fakeFetch(reply: (call: Call, i: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url: String(input), headers, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return Promise.resolve(reply(call, calls.length - 1));
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const msg = (i: number): ExpoMessage => ({
  to: `ExponentPushToken[token-${i}]`,
  title: 't',
  body: 'b',
  data: { inboxId: `id-${i}`, url: '/permissions' },
  sound: 'default',
  priority: 'default',
  channelId: 'recording_problems',
});

/** Expo's answer for a /send chunk: one ok ticket per message. */
const tickets = (call: Call) => ok({ data: (call.body as ExpoMessage[]).map((m) => ({ status: 'ok', id: `ticket-${m.to}` })) });

Deno.test('sendPush chunks 250 messages into 100, 100 and 50 and keeps ticket order', async () => {
  assertEquals(SEND_CHUNK, 100);
  const f = fakeFetch(tickets);
  const messages = Array.from({ length: 250 }, (_, i) => msg(i));
  const out = await sendPush(messages, { fetch: f.fetch });
  assertEquals(f.calls.map((c) => (c.body as unknown[]).length), [100, 100, 50]);
  assertEquals(f.calls[0].url, `${DEFAULT_EXPO_PUSH_URL}/send`);
  assertEquals(DEFAULT_EXPO_PUSH_URL, 'https://exp.host/--/api/v2/push');
  assertEquals(out.length, 250);
  assertEquals(out[0], { status: 'ok', id: 'ticket-ExponentPushToken[token-0]' });
  assertEquals(out[249], { status: 'ok', id: 'ticket-ExponentPushToken[token-249]' });
});

Deno.test('sendPush sends no request for no messages', async () => {
  const f = fakeFetch(tickets);
  assertEquals(await sendPush([], { fetch: f.fetch }), []);
  assertEquals(f.calls.length, 0);
});

Deno.test('the access token header is sent only when configured, and a custom url is honoured', async () => {
  const f = fakeFetch(tickets);
  await sendPush([msg(1)], { fetch: f.fetch, accessToken: 'expo-access' });
  assertEquals(f.calls[0].headers['authorization'], 'Bearer expo-access');
  assertEquals(f.calls[0].headers['content-type'], 'application/json');
  assertEquals(f.calls[0].headers['accept'], 'application/json');
  const g = fakeFetch(tickets);
  await sendPush([msg(1)], { fetch: g.fetch, url: 'http://expo.local/push', accessToken: null });
  assertEquals(g.calls[0].headers['authorization'], undefined);
  assertEquals(g.calls[0].url, 'http://expo.local/push/send');
});

Deno.test('an error ticket keeps only its error code, never its message (which quotes the token)', async () => {
  const f = fakeFetch(() =>
    ok({
      data: [
        {
          status: 'error',
          message: '"ExponentPushToken[token-1]" is not a registered push notification recipient',
          details: { error: 'DeviceNotRegistered' },
        },
        { status: 'error', message: 'something' },
      ],
    })
  );
  const out = await sendPush([msg(1), msg(2)], { fetch: f.fetch });
  assertEquals(out, [
    { status: 'error', error: 'DeviceNotRegistered' },
    { status: 'error', error: 'ExpoError' },
  ]);
  assert(!JSON.stringify(out).includes('token-1'));
});

Deno.test('503, 429 and a network failure are ExpoUnavailable, with the tickets of the chunks already accepted', async () => {
  for (const status of [503, 500, 429]) {
    const f = fakeFetch((call, i) => (i === 0 ? tickets(call) : new Response('down', { status })));
    const messages = Array.from({ length: 150 }, (_, i) => msg(i));
    const err = await assertRejects(() => sendPush(messages, { fetch: f.fetch }), ExpoUnavailable);
    assertEquals(err.tickets.length, 150);
    assertEquals(err.tickets.filter((t) => t !== null).length, 100);
    assertEquals(err.tickets[100], null);
    assertEquals(f.calls.length, 2); // it stops at the first unavailable chunk
  }
  const net = fakeFetch(() => {
    throw new TypeError('connection refused');
  });
  const err = await assertRejects(() => sendPush([msg(1)], { fetch: net.fetch }), ExpoUnavailable);
  assertEquals(err.tickets, [null]);
});

Deno.test('another 4xx or a malformed answer fails the chunk\'s messages without a retry', async () => {
  const rejected = fakeFetch(() => new Response(JSON.stringify({ errors: [{ code: 'VALIDATION_ERROR' }] }), { status: 400 }));
  assertEquals(await sendPush([msg(1)], { fetch: rejected.fetch }), [{ status: 'error', error: 'ExpoRequestRejected' }]);
  const short = fakeFetch(() => ok({ data: [] }));
  assertEquals(await sendPush([msg(1)], { fetch: short.fetch }), [{ status: 'error', error: 'ExpoBadResponse' }]);
  const junk = fakeFetch(() => new Response('<html>', { status: 200 }));
  assertEquals(await sendPush([msg(1)], { fetch: junk.fetch }), [{ status: 'error', error: 'ExpoBadResponse' }]);
});

Deno.test('getReceipts chunks by 300 and returns the receipts Expo has, keyed by ticket id', async () => {
  assertEquals(RECEIPT_CHUNK, 300);
  const f = fakeFetch((call) => {
    const ids = (call.body as { ids: string[] }).ids;
    const data: Record<string, unknown> = {};
    for (const id of ids) {
      if (id === 'r-1') data[id] = { status: 'error', message: 'quoted token', details: { error: 'DeviceNotRegistered' } };
      else if (id !== 'r-2') data[id] = { status: 'ok' };
    }
    return ok({ data });
  });
  const ids = Array.from({ length: 650 }, (_, i) => `r-${i}`);
  const out = await getReceipts(ids, { fetch: f.fetch, accessToken: 'expo-access' });
  assertEquals(f.calls.map((c) => (c.body as { ids: string[] }).ids.length), [300, 300, 50]);
  assertEquals(f.calls[0].url, `${DEFAULT_EXPO_PUSH_URL}/getReceipts`);
  assertEquals(f.calls[0].headers['authorization'], 'Bearer expo-access');
  assertEquals(out['r-0'], { status: 'ok' });
  assertEquals(out['r-1'], { status: 'error', error: 'DeviceNotRegistered' });
  assertEquals(out['r-2'], undefined); // not ready yet
  assertEquals(Object.keys(out).length, 649);
});

Deno.test('getReceipts on 503 is ExpoUnavailable with the receipts already fetched', async () => {
  const f = fakeFetch((call, i) =>
    i === 0
      ? ok({ data: Object.fromEntries((call.body as { ids: string[] }).ids.map((id) => [id, { status: 'ok' }])) })
      : new Response('', { status: 503 })
  );
  const ids = Array.from({ length: 301 }, (_, i) => `r-${i}`);
  const err = await assertRejects(() => getReceipts(ids, { fetch: f.fetch }), ExpoUnavailable);
  assertEquals(Object.keys(err.receipts).length, 300);
});
