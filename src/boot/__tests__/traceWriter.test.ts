/** @jest-environment node */
import { createExpoTraceWriter, type ExpoWriterFileSystemLike } from '@/boot/traceWriter';
import { TRACES_DIRECTORY } from '@/data/sync/traceFs';

/** Backup exclusion is its own tests' subject, below; these pass a no-op. */
const noExclude = async (): Promise<void> => {};

/** A stand-in for `expo-file-system`: records how the directory and the file were addressed. */
function fakeFileSystem() {
  const created: { key: string; options: unknown }[] = [];
  const deleted: { key: string; options: unknown }[] = [];
  const written = new Map<string, Uint8Array>();
  const module: ExpoWriterFileSystemLike = {
    Paths: { document: 'DOCUMENTS' },
    Directory: class {
      readonly key: string;
      constructor(...uris: never[]) {
        this.key = (uris as unknown as string[]).join('/');
      }
      get uri(): string {
        return this.key;
      }
      create(options?: unknown): void {
        created.push({ key: this.key, options });
      }
      delete(options?: unknown): void {
        deleted.push({ key: this.key, options });
      }
    },
    File: class {
      readonly key: string;
      constructor(...uris: never[]) {
        this.key = (uris as unknown as string[]).join('/');
      }
      write(content: Uint8Array): void {
        written.set(this.key, content);
      }
    },
  };
  return { module, created, deleted, written };
}

test('writes the trace as gzip under the documents traces directory, creating it idempotently', async () => {
  const { module, created, written } = fakeFileSystem();
  const writer = await createExpoTraceWriter(TRACES_DIRECTORY, async () => module, noExclude);

  await writer.writeGzip('trip-1.bin.gz', new TextEncoder().encode('[]'));
  await writer.writeGzip('trip-1.bin.gz', new TextEncoder().encode('[1]'));

  // Once when the writer is made (so it can be excluded from backup), then before each write.
  const create = { key: `DOCUMENTS/${TRACES_DIRECTORY}`, options: { intermediates: true, idempotent: true } };
  expect(created).toEqual([create, create, create]);
  const file = written.get(`DOCUMENTS/${TRACES_DIRECTORY}/trip-1.bin.gz`);
  expect(file && [...file.slice(0, 2)]).toEqual([0x1f, 0x8b]);
  // The second write replaced the first: the trailer carries the new length.
  expect(file?.[file.length - 4]).toBe(3);
});

test('clear() removes the whole traces directory, and a directory that was never there is fine', async () => {
  const { module, deleted } = fakeFileSystem();
  const writer = await createExpoTraceWriter(TRACES_DIRECTORY, async () => module, noExclude);

  await writer.clear();

  // Idempotent, so a device that never recorded a drive is already in the state this asks for.
  expect(deleted).toEqual([
    { key: `DOCUMENTS/${TRACES_DIRECTORY}`, options: { idempotent: true } },
  ]);
});

// ---------------------------------------------------------------------------------------------
// iOS backup exclusion (plan R4, D2): the traces directory never reaches iCloud or Finder backups
// ---------------------------------------------------------------------------------------------

const TRACES_URI = `DOCUMENTS/${TRACES_DIRECTORY}`;

/** A `Directory` whose `uri` is its joined path, as `expo-file-system`'s is a `file://` URI. */
function fakeFileSystemWithUris() {
  const events: string[] = [];
  const module: ExpoWriterFileSystemLike = {
    Paths: { document: 'DOCUMENTS' },
    Directory: class {
      readonly uri: string;
      constructor(...uris: never[]) {
        this.uri = (uris as unknown as string[]).join('/');
      }
      create(): void {
        events.push(`create ${this.uri}`);
      }
      delete(): void {
        events.push(`delete ${this.uri}`);
      }
    },
    File: class {
      readonly uri: string;
      constructor(...uris: never[]) {
        this.uri = (uris as unknown as string[]).join('/');
      }
      write(): void {
        events.push(`write ${this.uri}`);
      }
    },
  };
  return { module, events };
}

test('every writer creation makes the traces directory and excludes it from backup', async () => {
  const { module, events } = fakeFileSystemWithUris();
  const excluded: string[] = [];
  const exclude = async (uri: string) => {
    excluded.push(uri);
    events.push(`exclude ${uri}`);
  };

  await createExpoTraceWriter(TRACES_DIRECTORY, async () => module, exclude);
  // A second launch on the same install does it again: idempotent, and it is how an install from
  // before this build gets its existing directory excluded.
  await createExpoTraceWriter(TRACES_DIRECTORY, async () => module, exclude);

  expect(excluded).toEqual([TRACES_URI, TRACES_URI]);
  // The directory exists before the call: iOS answers E_NOT_FOUND for a path with nothing at it.
  expect(events.slice(0, 2)).toEqual([`create ${TRACES_URI}`, `exclude ${TRACES_URI}`]);
});

test('an exclusion that rejects is reported and the writer still works', async () => {
  const { module, events } = fakeFileSystemWithUris();
  const errors: unknown[] = [];
  const writer = await createExpoTraceWriter(
    TRACES_DIRECTORY,
    async () => module,
    async () => {
      throw Object.assign(new Error('attribute could not be set'), { code: 'E_IO' });
    },
    (error) => errors.push(error)
  );

  await writer.writeGzip('trip-1.bin.gz', new TextEncoder().encode('[]'));

  // Reported at creation, tried once more before the write (still refused), and the trace written.
  expect(errors).toHaveLength(2);
  expect(events).toContain(`write ${TRACES_URI}/trip-1.bin.gz`);
});

test('a directory re-created after clear() is excluded again before the next trace lands in it', async () => {
  const { module, events } = fakeFileSystemWithUris();
  const exclude = async (uri: string) => {
    events.push(`exclude ${uri}`);
  };
  const writer = await createExpoTraceWriter(TRACES_DIRECTORY, async () => module, exclude);
  await writer.writeGzip('a.bin.gz', new TextEncoder().encode('[]'));
  events.length = 0;

  // The device changed hands: the whole directory goes, and the next drive recreates it.
  await writer.clear();
  await writer.writeGzip('b.bin.gz', new TextEncoder().encode('[]'));
  await writer.writeGzip('c.bin.gz', new TextEncoder().encode('[]'));

  expect(events).toEqual([
    `delete ${TRACES_URI}`,
    `create ${TRACES_URI}`,
    `exclude ${TRACES_URI}`,
    `write ${TRACES_URI}/b.bin.gz`,
    `create ${TRACES_URI}`,
    `write ${TRACES_URI}/c.bin.gz`,
  ]);
});
