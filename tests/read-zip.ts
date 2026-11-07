import { crc32, inflateRawSync } from 'node:zlib';

/** The files in a ZIP by name, with each checksum checked. */
export function readZip(zip: Buffer): Record<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('No end record');
  const files: Record<string, string> = {};
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Bad directory record');
    const [nameLength, extra, comment] = [28, 30, 32].map((field) => zip.readUInt16LE(at + field));
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength!);
    const offset = zip.readUInt32LE(at + 42);
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Bad header for ${name}`);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(at + 20)));
    if (data.length !== zip.readUInt32LE(at + 24)) throw new Error(`Bad size for ${name}`);
    if (crc32(data) !== zip.readUInt32LE(at + 16)) throw new Error(`Bad checksum for ${name}`);
    files[name] = data.toString();
    at += 46 + nameLength! + extra! + comment!;
  }
  return files;
}
