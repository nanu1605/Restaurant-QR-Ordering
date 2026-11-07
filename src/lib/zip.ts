import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';

const deflate = promisify(deflateRaw);

export type ZipEntry = { name: Buffer; crc: number; size: number; data: Buffer };

/** One file, compressed, ready for zipArchive. */
export async function zipEntry(name: string, text: string): Promise<ZipEntry> {
  const raw = Buffer.from(text);
  return { name: Buffer.from(name), crc: crc32(raw), size: raw.length, data: await deflate(raw) };
}

const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const VERSION = 20;

/**
 * A ZIP file: each file's header and data, then the directory of them and its
 * end record (PKWARE APPNOTE §4.3).
 * ponytail: no ZIP64, so under 4 GiB and 65,535 files; the export bucket
 * refuses anything over 50 MiB first.
 */
export function zipArchive(entries: ZipEntry[], at = new Date()): Buffer {
  const time =
    (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date =
    ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();

  const files: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.name.length, 26);
    files.push(header, entry.name, entry.data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(VERSION, 4);
    record.writeUInt16LE(VERSION, 6);
    record.writeUInt16LE(UTF8_NAMES, 8);
    record.writeUInt16LE(DEFLATE, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.size, 24);
    record.writeUInt16LE(entry.name.length, 28);
    record.writeUInt32LE(offset, 42);
    directory.push(record, entry.name);

    offset += header.length + entry.name.length + entry.data.length;
  }

  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, listing, end]);
}
