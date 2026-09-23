import { buildCardModel, captionFor } from '../cardModel';
import { shareCard, type ShareFsLike, type SvgSnapshot } from '../shareAdapter';
import { progressRow } from '@/features/rewards/__fixtures__/rows';

const model = buildCardModel({ kind: 'streak', progress: progressRow({ streak_days: 5, best_streak: 9 }) })!;

function fakeFs() {
  const files = new Map<string, { data: string; encoding?: string }>();
  const log: string[] = [];
  const fs: ShareFsLike = {
    Paths: { cache: 'file:///cache' },
    File: class {
      uri: string;
      constructor(...parts: unknown[]) {
        this.uri = parts.map(String).join('/');
      }
      get exists() {
        return files.has(this.uri);
      }
      create() {
        log.push(`create:${this.uri}`);
        files.set(this.uri, { data: '' });
      }
      write(data: string, options?: { encoding?: string }) {
        log.push(`write:${this.uri}:${options?.encoding}`);
        files.set(this.uri, { data, encoding: options?.encoding });
      }
      delete() {
        log.push(`delete:${this.uri}`);
        files.delete(this.uri);
      }
    } as unknown as ShareFsLike['File'],
  };
  return { fs, files, log };
}

const svg = (b64 = 'iVBORw0KGgo='): SvgSnapshot => ({
  toDataURL: (cb) => cb(b64),
});

describe('shareCard', () => {
  test('iOS: renders the PNG to the cache, shares it with the caption, then deletes it', async () => {
    const { fs, files, log } = fakeFs();
    const share = jest.fn(async (_c: { url?: string; message?: string }) => ({ action: 'sharedAction' }));
    const out = await shareCard(svg(), model, { platform: 'ios', share, loadFs: async () => fs, uuid: () => 'u-1' });
    expect(out).toBe('shared');
    expect(share).toHaveBeenCalledWith({ url: 'file:///cache/share/u-1.png', message: captionFor(model) });
    expect(log).toEqual([
      'create:file:///cache/share/u-1.png',
      'write:file:///cache/share/u-1.png:base64',
      'delete:file:///cache/share/u-1.png',
    ]);
    expect(files.size).toBe(0);
  });

  test('iOS: dismissed is dismissed, and the file still goes', async () => {
    const { fs, files } = fakeFs();
    const share = jest.fn(async () => ({ action: 'dismissedAction' }));
    expect(await shareCard(svg(), model, { platform: 'ios', share, loadFs: async () => fs, uuid: () => 'u-2' })).toBe('dismissed');
    expect(files.size).toBe(0);
  });

  test('iOS: a share that rejects is a failure, and the file is deleted anyway', async () => {
    const { fs, files, log } = fakeFs();
    const share = jest.fn(async () => {
      throw new Error('no activity');
    });
    expect(await shareCard(svg(), model, { platform: 'ios', share, loadFs: async () => fs, uuid: () => 'u-3' })).toBe('failed');
    expect(log.at(-1)).toBe('delete:file:///cache/share/u-3.png');
    expect(files.size).toBe(0);
  });

  test('iOS: a write that fails deletes what it made and shares nothing', async () => {
    const { fs, files } = fakeFs();
    const Base = fs.File as unknown as new (...p: unknown[]) => object;
    fs.File = class extends Base {
      write() {
        throw new Error('disk full');
      }
    } as unknown as ShareFsLike['File'];
    const share = jest.fn();
    expect(await shareCard(svg(), model, { platform: 'ios', share, loadFs: async () => fs, uuid: () => 'u-4' })).toBe('failed');
    expect(share).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  test('iOS: no picture (no ref, or it never answers) is a failure with nothing written', async () => {
    const { fs, log } = fakeFs();
    const share = jest.fn();
    expect(await shareCard(null, model, { platform: 'ios', share, loadFs: async () => fs })).toBe('failed');
    const silent: SvgSnapshot = { toDataURL: () => undefined };
    expect(
      await shareCard(silent, model, { platform: 'ios', share, loadFs: async () => fs, snapshotTimeoutMs: 20 })
    ).toBe('failed');
    expect(share).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  test('Android: text only — the caption, no url, nothing written (D10)', async () => {
    const { fs, log } = fakeFs();
    const loadFs = jest.fn(async () => fs);
    const toDataURL = jest.fn();
    const share = jest.fn(async (_c: { url?: string; message?: string }) => ({ action: 'sharedAction' }));
    expect(await shareCard({ toDataURL }, model, { platform: 'android', share, loadFs })).toBe('shared');
    expect(share).toHaveBeenCalledWith({ message: captionFor(model) });
    expect(loadFs).not.toHaveBeenCalled();
    expect(toDataURL).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  test('Android: a share that rejects is a failure', async () => {
    const share = jest.fn(async () => {
      throw new Error('x');
    });
    expect(await shareCard(null, model, { platform: 'android', share })).toBe('failed');
  });
});
