/**
 * The byte-level encodings ECMA-119 (ISO 9660) asks for. Numbers are stored
 * "both-endian" (little-endian then big-endian copy) so that readers on any
 * CPU can take the half they prefer; a reader is allowed to check that the
 * two halves agree, so both must always be written.
 */

export const SECTOR_SIZE = 2048;

/** Sectors 0 to 15 are the system area; the first volume descriptor is at 16. */
export const SYSTEM_AREA_SECTORS = 16;

export class IsoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IsoError";
  }
}

export function sectorsFor(bytes: number): number {
  return Math.ceil(bytes / SECTOR_SIZE);
}

export function writeBothEndian16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
  buffer.writeUInt16BE(value, offset + 2);
}

export function writeBothEndian32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value, offset);
  buffer.writeUInt32BE(value, offset + 4);
}

/** An a-character field: ASCII, padded with spaces as ECMA-119 7.4 requires. */
export function writeAsciiField(buffer: Buffer, offset: number, length: number, text: string): void {
  buffer.fill(0x20, offset, offset + length);
  const bytes = Buffer.from(text, "latin1");
  if (bytes.length > length) throw new IsoError(`"${text}" does not fit in a ${length} byte field`);
  bytes.copy(buffer, offset);
}

/** Joliet text: UCS-2 big-endian, padded with UCS-2 spaces (0x0020). */
export function encodeUcs2(text: string): Buffer {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) out.writeUInt16BE(text.charCodeAt(i), i * 2);
  return out;
}

export function writeUcs2Field(buffer: Buffer, offset: number, length: number, text: string): void {
  // Fill pairs with 0x0020; an odd trailing byte (the 37 byte file id fields) stays 0.
  buffer.fill(0, offset, offset + length);
  for (let i = 0; i + 1 < length; i += 2) buffer.writeUInt16BE(0x0020, offset + i);
  const bytes = encodeUcs2(text);
  if (bytes.length > length) throw new IsoError(`"${text}" does not fit in a ${length} byte Joliet field`);
  bytes.copy(buffer, offset);
}

function digits(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * The 17 byte date of a volume descriptor (ECMA-119 8.4.26.1): sixteen ASCII
 * digits and a signed offset from GMT in 15 minute units. Always written in
 * UTC so the same instant gives the same bytes on every host, whatever its
 * time zone.
 */
export function volumeDate(date: Date | null): Buffer {
  const out = Buffer.alloc(17);
  if (date === null) {
    // "Not specified": sixteen ASCII zeros and a zero offset.
    out.write("0".repeat(16), 0, "latin1");
    return out;
  }
  const text =
    digits(date.getUTCFullYear(), 4) +
    digits(date.getUTCMonth() + 1, 2) +
    digits(date.getUTCDate(), 2) +
    digits(date.getUTCHours(), 2) +
    digits(date.getUTCMinutes(), 2) +
    digits(date.getUTCSeconds(), 2) +
    digits(Math.floor(date.getUTCMilliseconds() / 10), 2);
  out.write(text, 0, "latin1");
  out.writeInt8(0, 16);
  return out;
}

/** The 7 byte date of a directory record (ECMA-119 9.1.5), in UTC. */
export function recordDate(date: Date): Buffer {
  const out = Buffer.alloc(7);
  out.writeUInt8(date.getUTCFullYear() - 1900, 0);
  out.writeUInt8(date.getUTCMonth() + 1, 1);
  out.writeUInt8(date.getUTCDate(), 2);
  out.writeUInt8(date.getUTCHours(), 3);
  out.writeUInt8(date.getUTCMinutes(), 4);
  out.writeUInt8(date.getUTCSeconds(), 5);
  out.writeInt8(0, 6);
  return out;
}

/** Directory record dates hold the year as an offset from 1900 in one byte. */
export function assertRecordableDate(date: Date): void {
  if (Number.isNaN(date.getTime())) throw new IsoError("the timestamp is not a valid date");
  const year = date.getUTCFullYear();
  if (year < 1900 || year > 2155) throw new IsoError(`the timestamp year ${year} is outside 1900..2155, which ISO 9660 can record`);
}
