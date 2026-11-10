/** @jest-environment node */
import { removeShareImage, setShareFsForTests, sweepShareImages, toFileUri, type ShareFsLike } from '@/lib/shareImages';

/** An in-memory file tree keyed by URI ("file:///app/Documents/snapshot-1.png"). */
function fakeFs(paths: string[], opts: { failDelete?: string } = {}) {
  const files = new Set(paths);
  const join = (parts: (string | { uri: string })[]) =>
    parts
      .map((p) => (typeof p === 'string' ? p : p.uri))
      .map((p, i) => (i === 0 ? p : p.replace(/^\/+/, '')).replace(/\/+$/, ''))
      .join('/');
  class FakeFile {
    constructor(readonly uri: string) {}
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get exists() {
      return files.has(this.uri);
    }
    delete() {
      if (this.uri === opts.failDelete) throw new Error('busy');
      files.delete(this.uri);
    }
  }
  class FakeDir extends FakeFile {
    override get exists() {
      return [...files].some((f) => f.startsWith(`${this.uri}/`));
    }
    get parentDirectory() {
      return new FakeDir(this.uri.slice(0, this.uri.lastIndexOf('/')));
    }
    override delete() {
      for (const f of [...files]) if (f.startsWith(`${this.uri}/`)) files.delete(f);
    }
    list() {
      const kids = new Set<string>();
      for (const f of files) if (f.startsWith(`${this.uri}/`)) kids.add(`${this.uri}/${f.slice(this.uri.length + 1).split('/')[0]}`);
      return [...kids].map((k) => (files.has(k) ? new FakeFile(k) : new FakeDir(k)));
    }
  }
  const fs = {
    Paths: { document: new FakeDir('file:///app/Documents'), cache: new FakeDir('file:///app/Library/Caches') },
    File: function File(...parts: (string | { uri: string })[]) {
      return new FakeFile(join(parts));
    },
    Directory: function Directory(...parts: (string | { uri: string })[]) {
      return new FakeDir(join(parts));
    },
  } as unknown as ShareFsLike;
  return { fs, files };
}

afterEach(() => setShareFsForTests(undefined));

test('a capture is deleted by its bare path or its file URI; a missing one, nothing or a data URI is a no-op', () => {
  const { fs, files } = fakeFs(['file:///app/tmp/ReactNative/a.png', 'file:///app/Documents/snapshot-1.png']);
  setShareFsForTests(fs);
  expect(toFileUri('/app/tmp/ReactNative/a.png')).toBe('file:///app/tmp/ReactNative/a.png');
  removeShareImage('/app/tmp/ReactNative/a.png');
  removeShareImage('file:///app/Documents/snapshot-1.png');
  expect([...files]).toEqual([]);
  expect(() => removeShareImage('file:///app/gone.png')).not.toThrow();
  expect(() => removeShareImage(null)).not.toThrow();
  expect(() => removeShareImage('data:image/png;base64,AAAA')).not.toThrow();
});

test('without the file module, or when a delete fails, nothing throws', () => {
  setShareFsForTests(null);
  expect(() => removeShareImage('/app/a.png')).not.toThrow();
  expect(() => sweepShareImages()).not.toThrow();
  const { fs } = fakeFs(['file:///app/tmp/ReactNative/a.png'], { failDelete: 'file:///app/tmp/ReactNative/a.png' });
  setShareFsForTests(fs);
  expect(() => removeShareImage('/app/tmp/ReactNative/a.png')).not.toThrow();
});

test('the sweep takes card captures, map snapshots and the export folder, and leaves everything else', () => {
  const { fs, files } = fakeFs(
    [
      'file:///app/tmp/ReactNative/card.png',
      'file:///app/tmp/ReactNative/other.jpg',
      'file:///app/tmp/keep.txt',
      'file:///app/Documents/snapshot-1730000000.1234.png',
      'file:///app/Documents/SQLite/roadwise.db',
      'file:///app/Documents/notes.png',
      'file:///app/Library/Caches/ReactNative-snapshot-image123.png',
      'file:///app/Library/Caches/AirMapSnapshot456.png',
      'file:///app/Library/Caches/export/roadwise-data-2026-11-09.json',
      'file:///app/Library/Caches/fonts/a.ttf',
    ],
    { failDelete: 'file:///app/tmp/ReactNative/other.jpg' }
  );
  setShareFsForTests(fs);
  sweepShareImages();
  expect([...files].sort()).toEqual([
    'file:///app/Documents/SQLite/roadwise.db',
    'file:///app/Documents/notes.png',
    'file:///app/Library/Caches/fonts/a.ttf',
    // its delete failed: the sweep went on to the rest
    'file:///app/tmp/ReactNative/other.jpg',
    'file:///app/tmp/keep.txt',
  ]);
});
