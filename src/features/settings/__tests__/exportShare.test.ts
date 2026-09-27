import { exportFileName, shareExport, type ExportFsLike } from '../exportShare';

const NOW = new Date(2026, 8, 26, 10, 30).getTime();

function fakeFs(opts: { pick?: 'ok' | 'cancel'; writeFails?: boolean } = {}) {
  const files: { parts: unknown[]; content: string | null; deleted: boolean; created: boolean }[] = [];
  const picked: { name: string; mime: string | null; content: string | null }[] = [];
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
  const fs = {
    Paths: { cache: 'CACHE' },
    File,
    Directory: {
      pickDirectoryAsync: jest.fn(async () => {
        if (opts.pick === 'cancel') throw new Error('cancelled');
        return {
          createFile: (name: string, mime: string | null) => {
            const rec = { name, mime, content: null as string | null };
            picked.push(rec);
            return {
              uri: `content://picked/${name}`,
              exists: true,
              create() {},
              write(content: string) {
                if (opts.writeFails) throw new Error('disk full');
                rec.content = content;
              },
              delete() {},
            };
          },
        };
      }),
    },
  };
  return { fs: fs as unknown as ExportFsLike, files, picked };
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

describe('Android: saved into the folder the driver picks', () => {
  test('saved as JSON', async () => {
    const f = fakeFs();
    const share = jest.fn();
    expect(await shareExport('{"a":1}', { platform: 'android', share, loadFs: async () => f.fs, now: () => NOW })).toBe('saved');
    expect(f.picked).toEqual([{ name: 'roadwise-data-2026-09-26.json', mime: 'application/json', content: '{"a":1}' }]);
    expect(share).not.toHaveBeenCalled();
  });

  test('no folder chosen: dismissed; a write that fails: failed', async () => {
    const f = fakeFs({ pick: 'cancel' });
    expect(await shareExport('{}', { platform: 'android', loadFs: async () => f.fs, now: () => NOW })).toBe('dismissed');
    const g = fakeFs({ writeFails: true });
    expect(await shareExport('{}', { platform: 'android', loadFs: async () => g.fs, now: () => NOW })).toBe('failed');
  });
});
