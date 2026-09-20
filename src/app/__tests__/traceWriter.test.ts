/** @jest-environment node */
import { createExpoTraceWriter, type ExpoWriterFileSystemLike } from '@/app/traceWriter';
import { TRACES_DIRECTORY } from '@/data/sync/traceFs';

/** A stand-in for `expo-file-system`: records how the directory and the file were addressed. */
function fakeFileSystem() {
  const created: { key: string; options: unknown }[] = [];
  const written = new Map<string, Uint8Array>();
  const module: ExpoWriterFileSystemLike = {
    Paths: { document: 'DOCUMENTS' },
    Directory: class {
      readonly key: string;
      constructor(...uris: never[]) {
        this.key = (uris as unknown as string[]).join('/');
      }
      create(options?: unknown): void {
        created.push({ key: this.key, options });
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
  return { module, created, written };
}

test('writes the trace as gzip under the documents traces directory, creating it idempotently', async () => {
  const { module, created, written } = fakeFileSystem();
  const writer = await createExpoTraceWriter(TRACES_DIRECTORY, async () => module);

  await writer.writeGzip('trip-1.bin.gz', new TextEncoder().encode('[]'));
  await writer.writeGzip('trip-1.bin.gz', new TextEncoder().encode('[1]'));

  expect(created).toEqual([
    { key: `DOCUMENTS/${TRACES_DIRECTORY}`, options: { intermediates: true, idempotent: true } },
    { key: `DOCUMENTS/${TRACES_DIRECTORY}`, options: { intermediates: true, idempotent: true } },
  ]);
  const file = written.get(`DOCUMENTS/${TRACES_DIRECTORY}/trip-1.bin.gz`);
  expect(file && [...file.slice(0, 2)]).toEqual([0x1f, 0x8b]);
  // The second write replaced the first: the trailer carries the new length.
  expect(file?.[file.length - 4]).toBe(3);
});
