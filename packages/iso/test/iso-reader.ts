/**
 * A small, independent ISO 9660 + Joliet reader for the tests. It shares no
 * code with the writer on purpose: a mistake copied into both would pass.
 * It is strict where the writer must be: both-endian halves agree, records
 * never cross a sector, "." and ".." point where they should, records are
 * sorted, and the path tables describe exactly the directory tree.
 */

const SECTOR = 2048;

export interface ReadFile {
  kind: "file";
  name: string;
  lba: number;
  size: number;
}

export interface ReadDirectory {
  kind: "dir";
  name: string;
  lba: number;
  size: number;
  children: ReadNode[];
}

export type ReadNode = ReadFile | ReadDirectory;

export interface PathTableRecord {
  name: string;
  lba: number;
  parent: number;
}

export interface ReadVolume {
  volumeId: string;
  applicationId: string;
  volumeSpaceSize: number;
  creationDate: string;
  root: ReadDirectory;
  pathTable: PathTableRecord[];
}

export interface ParsedIso {
  primary: ReadVolume;
  joliet: ReadVolume;
}

function both32(buffer: Buffer, offset: number, what: string): number {
  const le = buffer.readUInt32LE(offset);
  const be = buffer.readUInt32BE(offset + 4);
  if (le !== be) throw new Error(`${what}: little-endian ${le} and big-endian ${be} differ`);
  return le;
}

function both16(buffer: Buffer, offset: number, what: string): number {
  const le = buffer.readUInt16LE(offset);
  const be = buffer.readUInt16BE(offset + 2);
  if (le !== be) throw new Error(`${what}: little-endian ${le} and big-endian ${be} differ`);
  return le;
}

function decode(bytes: Buffer, joliet: boolean): string {
  if (!joliet) return bytes.toString("latin1");
  if (bytes.length % 2 !== 0) throw new Error("odd-length Joliet identifier");
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
  return out;
}

function field(descriptor: Buffer, start: number, end: number, joliet: boolean): string {
  return decode(descriptor.subarray(start, joliet ? end - ((end - start) % 2) : end), joliet).replace(/ +$/, "");
}

interface RawRecord {
  length: number;
  lba: number;
  size: number;
  isDirectory: boolean;
  identifier: Buffer;
}

function parseRecord(buffer: Buffer, offset: number): RawRecord {
  const length = buffer.readUInt8(offset);
  const identifierLength = buffer.readUInt8(offset + 32);
  const expected = 33 + identifierLength + (identifierLength % 2 === 0 ? 1 : 0);
  if (length !== expected) throw new Error(`record at ${offset}: length ${length}, expected ${expected}`);
  if (both16(buffer, offset + 28, "volume sequence number") !== 1) throw new Error("volume sequence number is not 1");
  return {
    length,
    lba: both32(buffer, offset + 2, "extent location"),
    size: both32(buffer, offset + 10, "data length"),
    isDirectory: (buffer.readUInt8(offset + 25) & 0x02) !== 0,
    identifier: Buffer.from(buffer.subarray(offset + 33, offset + 33 + identifierLength)),
  };
}

function primaryKey(name: string): [string, string] {
  const bare = name.replace(/;1$/, "");
  const dot = bare.indexOf(".");
  return dot === -1 ? [bare, ""] : [bare.slice(0, dot), bare.slice(dot + 1)];
}

function inOrder(a: string, b: string, joliet: boolean): boolean {
  if (joliet) return a < b;
  const [an, ae] = primaryKey(a);
  const [bn, be] = primaryKey(b);
  return an < bn || (an === bn && ae < be);
}

function readDirectory(image: Buffer, self: RawRecord, parent: RawRecord, name: string, joliet: boolean): ReadDirectory {
  if (self.size % SECTOR !== 0) throw new Error(`directory "${name}" has a size that is not whole sectors`);
  const extent = image.subarray(self.lba * SECTOR, self.lba * SECTOR + self.size);
  if (extent.length !== self.size) throw new Error(`directory "${name}" extends past the image`);
  const records: RawRecord[] = [];
  let offset = 0;
  while (offset < extent.length) {
    const length = extent.readUInt8(offset);
    if (length === 0) {
      offset = (Math.floor(offset / SECTOR) + 1) * SECTOR;
      continue;
    }
    if ((offset % SECTOR) + length > SECTOR) throw new Error(`a record in "${name}" crosses a sector boundary`);
    records.push(parseRecord(extent, offset));
    offset += length;
  }
  const [dot, dotdot, ...rest] = records;
  if (!dot || dot.identifier.length !== 1 || dot.identifier[0] !== 0 || dot.lba !== self.lba || dot.size !== self.size) {
    throw new Error(`"." of "${name}" is wrong`);
  }
  if (!dotdot || dotdot.identifier.length !== 1 || dotdot.identifier[0] !== 1 || dotdot.lba !== parent.lba || dotdot.size !== parent.size) {
    throw new Error(`".." of "${name}" is wrong`);
  }
  const children: ReadNode[] = [];
  let previous: string | undefined;
  for (const record of rest) {
    const childName = decode(record.identifier, joliet);
    if (previous !== undefined && !inOrder(previous, childName, joliet)) {
      throw new Error(`records in "${name}" are not sorted: "${previous}" before "${childName}"`);
    }
    previous = childName;
    if (record.isDirectory) children.push(readDirectory(image, record, self, childName, joliet));
    else {
      if (record.size > 0 && (record.lba + Math.ceil(record.size / SECTOR)) * SECTOR > image.length) {
        throw new Error(`file "${childName}" extends past the image`);
      }
      children.push({ kind: "file", name: childName, lba: record.lba, size: record.size });
    }
  }
  return { kind: "dir", name, lba: self.lba, size: self.size, children };
}

function readPathTable(image: Buffer, lba: number, size: number, bigEndian: boolean, joliet: boolean): PathTableRecord[] {
  const table = image.subarray(lba * SECTOR, lba * SECTOR + size);
  const out: PathTableRecord[] = [];
  let offset = 0;
  while (offset < table.length) {
    const identifierLength = table.readUInt8(offset);
    const identifier = table.subarray(offset + 8, offset + 8 + identifierLength);
    out.push({
      name: identifierLength === 1 && identifier[0] === 0 ? "" : decode(identifier, joliet),
      lba: bigEndian ? table.readUInt32BE(offset + 2) : table.readUInt32LE(offset + 2),
      parent: bigEndian ? table.readUInt16BE(offset + 6) : table.readUInt16LE(offset + 6),
    });
    offset += 8 + identifierLength + (identifierLength % 2);
  }
  if (offset !== size) throw new Error("the path table size does not match its records");
  return out;
}

/** What the path table must say: directories breadth first, each with its parent's 1-based number. */
function expectedPathTable(root: ReadDirectory): PathTableRecord[] {
  const order: { dir: ReadDirectory; parent: number }[] = [{ dir: root, parent: 1 }];
  for (let i = 0; i < order.length; i++) {
    for (const child of order[i]!.dir.children) if (child.kind === "dir") order.push({ dir: child, parent: i + 1 });
  }
  return order.map(({ dir, parent }) => ({ name: dir.name, lba: dir.lba, parent }));
}

function readVolume(image: Buffer, descriptor: Buffer, joliet: boolean): ReadVolume {
  if (both16(descriptor, 128, "block size") !== SECTOR) throw new Error("block size is not 2048");
  const volumeSpaceSize = both32(descriptor, 80, "volume space size");
  if (volumeSpaceSize * SECTOR !== image.length) {
    throw new Error(`volume space size ${volumeSpaceSize} sectors, image ${image.length / SECTOR} sectors`);
  }
  const rootRecord = parseRecord(descriptor, 156);
  if (!rootRecord.isDirectory) throw new Error("the root record is not a directory");
  const root = readDirectory(image, rootRecord, rootRecord, "", joliet);
  const pathTableSize = both32(descriptor, 132, "path table size");
  const little = readPathTable(image, descriptor.readUInt32LE(140), pathTableSize, false, joliet);
  const big = readPathTable(image, descriptor.readUInt32BE(148), pathTableSize, true, joliet);
  const expected = expectedPathTable(root);
  if (JSON.stringify(little) !== JSON.stringify(expected)) throw new Error("the L path table does not match the directories");
  if (JSON.stringify(big) !== JSON.stringify(expected)) throw new Error("the M path table does not match the directories");
  return {
    volumeId: field(descriptor, 40, 72, joliet),
    applicationId: field(descriptor, 574, 702, joliet),
    volumeSpaceSize,
    creationDate: descriptor.toString("latin1", 813, 830),
    root,
    pathTable: little,
  };
}

export function parseIso(image: Buffer): ParsedIso {
  if (image.length % SECTOR !== 0) throw new Error("the image is not whole sectors");
  let primary: ReadVolume | undefined;
  let joliet: ReadVolume | undefined;
  for (let sector = 16; ; sector++) {
    const descriptor = image.subarray(sector * SECTOR, (sector + 1) * SECTOR);
    if (descriptor.length < SECTOR || descriptor.toString("latin1", 1, 6) !== "CD001") {
      throw new Error(`no volume descriptor at sector ${sector}`);
    }
    const type = descriptor.readUInt8(0);
    if (type === 255) break;
    if (type === 1) primary = readVolume(image, descriptor, false);
    if (type === 2 && descriptor.toString("latin1", 88, 91) === "%/E") joliet = readVolume(image, descriptor, true);
  }
  if (!primary) throw new Error("no primary volume descriptor");
  if (!joliet) throw new Error("no Joliet supplementary volume descriptor");
  return { primary, joliet };
}

/** Every file under a directory, keyed by its "/"-joined path. */
export function listFiles(root: ReadDirectory, prefix = ""): Map<string, ReadFile> {
  const out = new Map<string, ReadFile>();
  for (const child of root.children) {
    const path = prefix === "" ? child.name : `${prefix}/${child.name}`;
    if (child.kind === "file") out.set(path, child);
    else for (const [nested, file] of listFiles(child, path)) out.set(nested, file);
  }
  return out;
}

/** Every directory under (not including) a directory, by path. */
export function listDirectories(root: ReadDirectory, prefix = ""): string[] {
  const out: string[] = [];
  for (const child of root.children) {
    if (child.kind !== "dir") continue;
    const path = prefix === "" ? child.name : `${prefix}/${child.name}`;
    out.push(path, ...listDirectories(child, path));
  }
  return out;
}

export function fileBytes(image: Buffer, file: ReadFile): Buffer {
  return image.subarray(file.lba * SECTOR, file.lba * SECTOR + file.size);
}
