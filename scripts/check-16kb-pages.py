"""Check that an Android APK's native libraries load on phones with 16 KB memory pages.

Google Play requires it of every app that targets Android 15 or later and ships native code
(React Native, Hermes and the Expo modules all do). Two things must hold for each 64-bit library
(lib/arm64-v8a, lib/x86_64; 32-bit ABIs never run with 16 KB pages):

1. Its ELF LOAD segments are aligned to at least 16 KB (p_align >= 16384): the library was linked
   for 16 KB pages (NDK r27+ with the right flags, or r28+ by default).
2. Stored uncompressed in the APK (the default, `expo.useLegacyPackaging=false`), its data starts at
   a 16 KB boundary of the file, so Android can map it straight from the APK. A compressed library
   is extracted at install instead, and only rule 1 applies.

Usage (CI's android job, or by hand after a build; plain Python 3, no packages):
    python scripts/check-16kb-pages.py android/app/build/outputs/apk/debug/app-debug.apk

Prints one line per library and exits 1 if any 64-bit library fails, 2 if the APK has no 64-bit
library at all (the check would prove nothing).
"""
import struct
import sys
import zipfile

PAGE = 16384
ABIS_64 = ('arm64-v8a', 'x86_64')
PT_LOAD = 1


def load_alignments(elf):
    """The p_align of every LOAD segment of an ELF file (bytes)."""
    if elf[:4] != b'\x7fELF':
        raise ValueError('not an ELF file')
    is64 = elf[4] == 2
    end = '<' if elf[5] == 1 else '>'
    if is64:
        phoff, = struct.unpack_from(end + 'Q', elf, 0x20)
        phentsize, phnum = struct.unpack_from(end + 'HH', elf, 0x36)
    else:
        phoff, = struct.unpack_from(end + 'I', elf, 0x1C)
        phentsize, phnum = struct.unpack_from(end + 'HH', elf, 0x2A)
    aligns = []
    for i in range(phnum):
        at = phoff + i * phentsize
        p_type, = struct.unpack_from(end + 'I', elf, at)
        if p_type != PT_LOAD:
            continue
        if is64:
            p_align, = struct.unpack_from(end + 'Q', elf, at + 0x30)
        else:
            p_align, = struct.unpack_from(end + 'I', elf, at + 0x1C)
        aligns.append(p_align)
    return aligns


def data_offset(apk_file, info):
    """Where an entry's data starts in the APK: after its local header, whose extra field (used
    for alignment padding) can differ from the central directory's."""
    apk_file.seek(info.header_offset)
    header = apk_file.read(30)
    if header[:4] != b'PK\x03\x04':
        raise ValueError(f'bad local header for {info.filename}')
    name_len, extra_len = struct.unpack_from('<HH', header, 26)
    return info.header_offset + 30 + name_len + extra_len


def main(path):
    failures = 0
    checked = 0
    with zipfile.ZipFile(path) as apk, open(path, 'rb') as raw:
        for info in apk.infolist():
            parts = info.filename.split('/')
            if len(parts) != 3 or parts[0] != 'lib' or not parts[2].endswith('.so'):
                continue
            abi = parts[1]
            aligns = load_alignments(apk.read(info))
            stored = info.compress_type == zipfile.ZIP_STORED
            offset = data_offset(raw, info) if stored else None
            if abi not in ABIS_64:
                print(f'skip  {info.filename} (32-bit)')
                continue
            checked += 1
            problems = []
            if not aligns or min(aligns) < PAGE:
                problems.append(f'LOAD p_align {min(aligns) if aligns else "none"} < {PAGE}')
            if stored and offset % PAGE != 0:
                problems.append(f'stored at offset {offset}, not a multiple of {PAGE}')
            how = f'stored @ {offset}' if stored else 'compressed'
            if problems:
                failures += 1
                print(f'FAIL  {info.filename}: ' + '; '.join(problems))
            else:
                print(f'ok    {info.filename} (p_align {min(aligns)}, {how})')
    if checked == 0:
        print('no 64-bit native libraries found: nothing was checked')
        return 2
    print(f'{checked} 64-bit libraries checked, {failures} not 16 KB ready')
    return 1 if failures else 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: python scripts/check-16kb-pages.py <app.apk>')
    sys.exit(main(sys.argv[1]))
