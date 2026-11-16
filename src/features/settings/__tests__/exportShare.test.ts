import { exportFileName, shareExport, type ExportFsLike } from '../exportShare';

const NOW = new Date(2026, 8, 26, 10, 30).getTime();

function fakeFs(opts: { writeFails?: boolean } = {}) {
  const files: { parts: unknown[]; content: string | null; deleted: boolean; created: boolean }[] = [];
  class File {
    parts: unknown[];
    rec: (typeof files)[number];
    constructor(...parts: unknown[]) {
      this.parts = parts;
      this.rec = { parts, content: null, deleted: false, created: false };
      files.push(this.rec);
    }
    get uri() {
      return `file:///cache/${this.parts.slice(1).join('/')}`;
    }
    get exists() {
      return this.rec.created && !this.rec.deleted;
    }
    create() {
      this.rec.created = true;
    }
    write(content: string) {
      if (opts.writeFails) throw new Error('disk full');
      this.rec.content = content;
    }
    delete() {
      this.rec.deleted = true;
    }
  }
  const fs = { Paths: { cache: 'CACHE' }, File };
  return { fs: fs as unknown as ExportFsLike, files };
}

test('the file is named for the day', () => {
  expect(exportFileName(NOW)).toBe('roadwise-data-2026-09-26.json');
});

describe('iOS: a file through the share sheet, deleted afterwards', () => {
  test('shared', async () => {
    const f = fakeFs();
    const share = jest.fn(async () => ({ action: 'sharedAction' }));
    expect(await shareExport('{"a":1}', { platform: 'ios', share, loadFs: async () => f.fs, now: () => NOW })).toBe('shared');
    expect(share).toHaveBeenCalledWith({ url: 'file:///cache/export/roadwise-data-2026-09-26.json' });
    expect(f.files[0]?.content).toBe('{"a":1}');
    expect(f.files[0]?.deleted).toBe(true);
  });

  test('dismissed, and still deleted', async () => {
    const f = fakeFs();
    const share = jest.fn(async () => ({ action: 'dismissedAction' }));
    expect(await shareExport('{}', { platform: 'ios', share, loadFs: async () => f.fs, now: () => NOW })).toBe('dismissed');
    expect(f.files[0]?.deleted).toBe(true);
  });

  test('a share that throws or a write that fails is a failure, and nothing is left behind', async () => {
    const f = fakeFs();
    const share = jest.fn(async () => {
      throw new Error('no sheet');
    });
    expect(await shareExport('{}', { platform: 'ios', share, loadFs: async () => f.fs, now: () => NOW })).toBe('failed');
    expect(f.files[0]?.deleted).toBe(true);
    const g = fakeFs({ writeFails: true });
    expect(await shareExport('{}', { platform: 'ios', share: jest.fn(), loadFs: async () => g.fs, now: () => NOW })).toBe('failed');
  });

  test('no file system: failed', async () => {
    expect(
      await shareExport('{}', {
        platform: 'ios',
        loadFs: async () => {
          throw new Error('no module');
        },
      })
    ).toBe('failed');
  });
});

describe('Android: a file through the share sheet, left for the app picked (the stale sweep deletes it)', () => {
  test('shared as JSON through the sheet; the file stays', async () => {
    const f = fakeFs();
    const share = jest.fn();
    const shareFile = jest.fn(async () => undefined);
    expect(await shareExport('{"a":1}', { platform: 'android', share, shareFile, loadFs: async () => f.fs, now: () => NOW })).toBe('shared');
    expect(shareFile).toHaveBeenCalledWith('file:///cache/export/roadwise-data-2026-09-26.json', { mimeType: 'application/json', dialogTitle: 'Export my data' });
    expect(share).not.toHaveBeenCalled();
    expect(f.files[0]?.content).toBe('{"a":1}');
    expect(f.files[0]?.deleted).toBe(false);
  });

  test('a sheet that fails or a write that fails is a failure, and the file goes', async () => {
    const f = fakeFs();
    const shareFile = jest.fn(async () => {
      throw new Error('no sheet');
    });
    expect(await shareExport('{}', { platform: 'android', shareFile, loadFs: async () => f.fs, now: () => NOW })).toBe('failed');
    expect(f.files[0]?.deleted).toBe(true);
    const g = fakeFs({ writeFails: true });
    expect(await shareExport('{}', { platform: 'android', shareFile, loadFs: async () => g.fs, now: () => NOW })).toBe('failed');
    expect(shareFile).toHaveBeenCalledTimes(1);
  });
});
