import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS maintenance script
const setup = require('../setup-push.js') as {
  newSweepKey: () => string;
  pushSenderUrl: (ref: string) => string;
  vaultSql: (ref: string, key: string) => string;
  linkedRef: (root?: string) => string;
  KEY_RE: RegExp;
};

const REF = 'abcdefghij0123456789';
const KEY = 'a1'.repeat(32);

test('a new sweep key is 32 random bytes in hex: long enough for push-sender and for dispatch_push', () => {
  const key = setup.newSweepKey();
  expect(key).toMatch(setup.KEY_RE);
  // push-sender (MIN_SWEEP_KEY_BYTES) and private.dispatch_push (octet_length) both ask for 32 bytes or more
  expect(Buffer.byteLength(key, 'utf8')).toBeGreaterThanOrEqual(32);
  expect(setup.newSweepKey()).not.toBe(key);
});

test("the sweep posts to the project's own push-sender", () => {
  expect(setup.pushSenderUrl(REF)).toBe(`https://${REF}.supabase.co/functions/v1/push-sender`);
});

test('anything but a project ref is refused, so nothing else can reach the URL or the SQL', () => {
  for (const bad of ['', 'short', `${REF}x`, 'ABCDEFGHIJ0123456789', "abc'; drop table x; --"]) {
    expect(() => setup.pushSenderUrl(bad)).toThrow(/project ref/);
    expect(() => setup.vaultSql(bad, KEY)).toThrow(/project ref/);
  }
});

test('anything but a 64-hex key is refused', () => {
  for (const bad of ['', 'abc', `${KEY}0`, KEY.toUpperCase(), `${KEY.slice(0, 62)}';`]) {
    expect(() => setup.vaultSql(REF, bad)).toThrow(/64 hex/);
  }
});

test('the statement stores both Vault secrets under the names dispatch_push reads, creating or replacing each', () => {
  const sql = setup.vaultSql(REF, KEY);
  for (const name of ['push_sender_hmac_key', 'push_sender_url']) {
    expect(sql).toContain(`from vault.secrets s where s.name = '${name}'`);
    expect(sql).toMatch(new RegExp(`vault\\.create_secret\\('[^']+', '${name}', '[^']+'\\)`));
  }
  expect(sql).toContain(`vault.create_secret('${KEY}', 'push_sender_hmac_key'`);
  expect(sql).toContain(`vault.update_secret(v_id, '${KEY}')`);
  expect(sql).toContain(`vault.create_secret('https://${REF}.supabase.co/functions/v1/push-sender', 'push_sender_url'`);
  expect(sql).toContain(`vault.update_secret(v_id, 'https://${REF}.supabase.co/functions/v1/push-sender')`);
  // one DO block whose quote tag cannot appear in a hex key or a project URL
  expect(sql.startsWith('do $setup$')).toBe(true);
  expect(sql.trimEnd().endsWith('$setup$;')).toBe(true);
  expect(sql.split('$setup$')).toHaveLength(3);
});

describe('the linked project', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'setup-push-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("is read from the CLI's project-ref file", () => {
    mkdirSync(join(root, 'supabase', '.temp'), { recursive: true });
    writeFileSync(join(root, 'supabase', '.temp', 'project-ref'), `${REF}\n`);
    expect(setup.linkedRef(root)).toBe(REF);
  });

  test('a project that is not linked, or a file that holds something else, stops the script', () => {
    expect(() => setup.linkedRef(root)).toThrow(/not linked/);
    mkdirSync(join(root, 'supabase', '.temp'), { recursive: true });
    writeFileSync(join(root, 'supabase', '.temp', 'project-ref'), 'not a ref');
    expect(() => setup.linkedRef(root)).toThrow(/does not hold a project ref/);
  });
});
