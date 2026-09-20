/** @jest-environment node */
import {
  createExpoTraceFs,
  TRACES_DIRECTORY,
  type ExpoFileSystemLike,
} from '@/data/sync/traceFs';

const BYTES = new Uint8Array([31, 139, 8]);

/** A stand-in for `expo-file-system`: one in-memory tree, recording how it was addressed. */
function fakeFileSystem(present: Record<string, Uint8Array>) {
  const opened: string[][] = [];
  const deleted: string[] = [];
  const module: ExpoFileSystemLike = {
    Paths: { document: 'DOCUMENTS' },
    File: class {
      readonly key: string;

      constructor(...uris: never[]) {
        opened.push(uris as unknown as string[]);
        this.key = (uris as unknown as string[]).join('/');
      }

      get exists(): boolean {
        return this.key in present;
      }

      async bytes(): Promise<Uint8Array> {
        const found = present[this.key];
        if (!found) throw new Error(`no file at ${this.key}`);
        return found;
      }

      delete(): void {
        if (!(this.key in present)) throw new Error(`no file at ${this.key}`);
        deleted.push(this.key);
        delete present[this.key];
      }
    },
  };
  return { module, opened, deleted };
}

const KEY = `DOCUMENTS/${TRACES_DIRECTORY}/trip-1.bin.gz`;

test('a trace is addressed under the documents traces directory by its relative name', async () => {
  const { module, opened } = fakeFileSystem({ [KEY]: BYTES });
  const fs = await createExpoTraceFs(TRACES_DIRECTORY, async () => module);

  await expect(fs.exists('trip-1.bin.gz')).resolves.toBe(true);
  await expect(fs.exists('trip-2.bin.gz')).resolves.toBe(false);
  await expect(fs.read('trip-1.bin.gz')).resolves.toEqual(BYTES);
  expect(opened[0]).toEqual(['DOCUMENTS', TRACES_DIRECTORY, 'trip-1.bin.gz']);
});

test('removing a trace that is already gone is not an error', async () => {
  const { module, deleted } = fakeFileSystem({ [KEY]: BYTES });
  const fs = await createExpoTraceFs(TRACES_DIRECTORY, async () => module);

  await fs.remove('trip-1.bin.gz');
  expect(deleted).toEqual([KEY]);
  await expect(fs.remove('trip-1.bin.gz')).resolves.toBeUndefined();
  expect(deleted).toEqual([KEY]);
});
