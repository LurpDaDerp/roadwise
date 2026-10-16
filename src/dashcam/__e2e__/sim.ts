// The firmware's BLE link simulator (`deployment-stack/firmware/host/ble_sim.c`, its docs/BLE_PROTOCOL.md
// §9) as a child process: the real `ble_link.c`, `ble_auth.c` and `ble_proto.c` (with mbedTLS) behind a
// line protocol, run in WSL.
//
// The binary is built by the firmware's own `firmware/host/build_ble.sh` (into the firmware
// repository's ignored `firmware/host/build/`), which rebuilds it when it is missing or older than one
// of its sources, the build `tests/test_ble_sim.py` uses (mbedTLS from the ESP-IDF tree, compiled
// once). `DASHPAL_BLE_SIM` (a WSL path) points at another binary and skips the build;
// `DASHPAL_FW_REPO` (a WSL path) at another firmware checkout.
//
// Node's modules are reached through `require` with local shapes: the app's tsconfig does not load
// Node's types.

interface Readable {
  on(event: 'data', fn: (chunk: { toString(): string }) => void): void;
}
interface ChildProcess {
  stdin: { write(s: string): boolean; end(): void };
  stdout: Readable;
  stderr: Readable;
  on(event: 'exit', fn: (code: number | null) => void): void;
  kill(): void;
}
interface SpawnSyncResult {
  status: number | null;
  stdout: { toString(): string } | null;
  stderr: { toString(): string } | null;
  error?: Error;
}
interface ChildProcessModule {
  spawn(cmd: string, args: string[], opts?: { stdio?: string[] }): ChildProcess;
  spawnSync(cmd: string, args: string[], opts?: { timeout?: number; encoding?: string }): SpawnSyncResult;
}

declare const process: { env: Record<string, string | undefined>; platform: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node's module, typed locally (see above)
const cp = require('child_process') as ChildProcessModule;

export const FW_REPO = process.env.DASHPAL_FW_REPO ?? '/mnt/c/Users/lurpd/Documents/dev/deployment-stack';
export const SIM_PATH = process.env.DASHPAL_BLE_SIM ?? `${FW_REPO}/firmware/host/build/ble_sim`;

/** The simulator command line: `wsl -e <binary>` on Windows, the binary itself elsewhere. */
function command(args: string[]): [string, string[]] {
  return process.platform === 'win32' ? ['wsl', ['-e', SIM_PATH, ...args]] : [SIM_PATH, args];
}

function shell(script: string): SpawnSyncResult {
  // mbedTLS's first build takes about 30 s.
  return process.platform === 'win32'
    ? cp.spawnSync('wsl', ['-e', 'bash', '-c', script], { timeout: 300_000 })
    : cp.spawnSync('bash', ['-c', script], { timeout: 300_000 });
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Build the simulator if needed and say whether it can run. `ok: false` carries the reason the
 * suite is skipped (no WSL, no firmware checkout, no compiler or ESP-IDF tree, a failed build).
 */
export function prepareSimulator(): { ok: true; built: boolean } | { ok: false; why: string } {
  let r: SpawnSyncResult;
  if (process.env.DASHPAL_BLE_SIM) {
    r = shell(`test -x ${q(SIM_PATH)}`);
    if (r.error) return { ok: false, why: `cannot start ${process.platform === 'win32' ? 'wsl' : 'bash'}: ${r.error.message}` };
    return r.status === 0 ? { ok: true, built: false } : { ok: false, why: `DASHPAL_BLE_SIM=${SIM_PATH} is not an executable` };
  }
  const script = [
    `cd ${q(FW_REPO)} || { echo "no firmware checkout at ${FW_REPO}"; exit 3; }`,
    `[ -f firmware/host/build_ble.sh ] || { echo "no firmware/host/build_ble.sh in ${FW_REPO}"; exit 3; }`,
    'bash firmware/host/build_ble.sh',
  ].join('\n');
  r = shell(script);
  if (r.error) return { ok: false, why: `cannot start ${process.platform === 'win32' ? 'wsl' : 'bash'}: ${r.error.message}` };
  const out = `${r.stdout?.toString() ?? ''}${r.stderr?.toString() ?? ''}`.trim();
  if (r.status !== 0) return { ok: false, why: `the simulator could not be built (exit ${String(r.status)}): ${out}` };
  return { ok: true, built: out.includes('BUILT') };
}

/** One line the simulator printed, with the world time it was printed at. */
export interface SimLine {
  at: number;
  line: string;
}

/**
 * A running simulator. `send` writes lines, then `CTXQ` as a sentinel (it changes nothing), and
 * resolves with everything printed up to the sentinel's `CTX` answer (that line excluded).
 */
export class SimProcess {
  private readonly child: ChildProcess;
  private buf = '';
  private readonly lines: string[] = [];
  private waiter: { ctxLeft: number; resolve: (lines: string[]) => void; reject: (e: Error) => void } | null = null;
  private exited: string | null = null;
  private stderr = '';
  /** every line written, for failure messages */
  readonly input: string[] = [];

  constructor(args: string[]) {
    const [cmd, argv] = command(args);
    this.child = cp.spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.on('exit', (code) => {
      this.exited = `the simulator exited (${String(code)}) ${this.stderr}`;
      const w = this.waiter;
      this.waiter = null;
      w?.reject(new Error(this.exited));
    });
  }

  private onData(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      const w = this.waiter;
      if (w && line.startsWith('CTX ')) {
        w.ctxLeft -= 1;
        if (w.ctxLeft === 0) {
          this.waiter = null;
          const got = this.lines.splice(0);
          got.pop(); // the sentinel's answer
          w.resolve(got);
        }
      }
    }
  }

  send(lines: string[]): Promise<string[]> {
    if (this.exited) return Promise.reject(new Error(this.exited));
    if (this.waiter) return Promise.reject(new Error('simulator: overlapping send'));
    const ctxLeft = lines.filter((l) => l.trim() === 'CTXQ').length + 1;
    return new Promise<string[]>((resolve, reject) => {
      this.waiter = { ctxLeft, resolve, reject };
      this.input.push(...lines);
      this.child.stdin.write(`${[...lines, 'CTXQ'].join('\n')}\n`);
    });
  }

  close(): void {
    if (this.exited) return;
    try {
      this.child.stdin.write('Q\n');
      this.child.stdin.end();
    } catch {
      // already gone
    }
    this.child.kill();
  }
}
