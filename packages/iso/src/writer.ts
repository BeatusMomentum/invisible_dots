/**
 * Writes an ISO 9660 image with a Joliet supplementary tree.
 *
 * Layout, in sectors of 2048 bytes:
 *
 *   0-15   system area (zeros)
 *   16     primary volume descriptor
 *   17     Joliet supplementary volume descriptor
 *   18     volume descriptor set terminator
 *   19..   path tables: primary L, primary M, Joliet L, Joliet M
 *          primary directory extents, breadth first
 *          Joliet directory extents, breadth first
 *          file data, each file starting on a sector; both trees point at
 *          the same extents, so file data is stored once
 *          150 sectors of zeros
 *
 * The trailing zeros are the 300 KiB pad the usual ISO mastering tools add: the
 * Linux block layer reads ahead past the last file, and a read past the end
 * of the device logs I/O errors in the guest.
 *
 * There is no Rock Ridge, so the image records no owners or permission bits.
 * Linux then shows every file as readable and executable by everyone (the
 * isofs default), which is what the runtime disk's binaries need, and which
 * means nothing on an image can be made private inside the guest.
 */
import { randomBytes } from "node:crypto";
import { open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  assertRecordableDate,
  encodeUcs2,
  IsoError,
  recordDate,
  SECTOR_SIZE,
  sectorsFor,
  SYSTEM_AREA_SECTORS,
  volumeDate,
  writeAsciiField,
  writeBothEndian16,
  writeBothEndian32,
  writeUcs2Field,
} from "./encoding.js";
import {
  compareJolietNames,
  comparePrimaryIds,
  MAX_PATH_COMPONENTS,
  PrimaryNamer,
  splitImagePath,
  validateVolumeId,
} from "./names.js";
import { replaceFile } from "@invisible-dots/shared/replace-file";

/** One item of the image. Directories that hold files are created implicitly. */
export type IsoEntry =
  /** Bytes held by the caller; a string is written as UTF-8. */
  | { path: string; data: Uint8Array | string }
  /** A file on the host, streamed into the image when it is written. */
  | { path: string; file: string }
  /** An empty directory (one that holds entries does not need this). */
  | { path: string; directory: true };

export interface WriteIsoOptions {
  /** 1 to 16 characters from A-Z, a-z, 0-9, "_" and "-", e.g. "cidata" or "IDOTS-RT". */
  volumeId: string;
  /**
   * Every date in the image. Pass a fixed value to make the output a pure
   * function of the inputs; the default is the current time.
   */
  timestamp?: Date;
  /** Recorded in the volume descriptors; at most 64 characters. */
  applicationId?: string;
  /**
   * Permission bits of the image file on the host. The default 0o600 is
   * because a seed image carries a Dot's token; QEMU runs as the same user.
   */
  mode?: number;
}

export interface IsoSummary {
  /** Size of the written image. */
  bytes: number;
  sectors: number;
  files: number;
  /** Including the root. */
  directories: number;
}

const PADDING_SECTORS = 150;
const COPY_CHUNK_BYTES = 1024 * 1024;
/** Data lengths are 32-bit; larger files would need multi-extent records, which this writer does not produce. */
const MAX_FILE_BYTES = 0xffffffff;
const DEFAULT_APPLICATION_ID = "INVISIBLE_DOTS";
const MAX_APPLICATION_ID_LENGTH = 64;

type FileSource = { kind: "data"; data: Buffer } | { kind: "file"; path: string };

interface FileNode {
  kind: "file";
  name: string;
  primaryId: string;
  size: number;
  source: FileSource;
  lba: number;
}

interface Extent {
  lba: number;
  sectors: number;
  /** 1-based position in the path table. */
  number: number;
}

interface DirNode {
  kind: "dir";
  name: string;
  parent: DirNode | null;
  children: Map<string, Node>;
  primaryId: string;
  primary: Extent;
  joliet: Extent;
}

type Node = FileNode | DirNode;

/** What differs between the primary and the Joliet tree; everything else is shared. */
interface TreeKind {
  extent(dir: DirNode): Extent;
  identifier(node: Node): Buffer;
  compare(a: Node, b: Node): number;
}

const PRIMARY: TreeKind = {
  extent: (dir) => dir.primary,
  identifier: (node) => Buffer.from(node.primaryId, "latin1"),
  compare: (a, b) => comparePrimaryIds(a.primaryId, b.primaryId),
};

const JOLIET: TreeKind = {
  extent: (dir) => dir.joliet,
  identifier: (node) => encodeUcs2(node.name),
  compare: (a, b) => compareJolietNames(a.name, b.name),
};

/** Writes `entries` to an image at `outputPath`, replacing it atomically. */
export async function writeIso(outputPath: string, entries: readonly IsoEntry[], options: WriteIsoOptions): Promise<IsoSummary> {
  validateVolumeId(options.volumeId);
  const timestamp = options.timestamp ?? new Date();
  assertRecordableDate(timestamp);
  const applicationId = options.applicationId ?? DEFAULT_APPLICATION_ID;
  if (!/^[\x20-\x7e]*$/.test(applicationId) || applicationId.length > MAX_APPLICATION_ID_LENGTH) {
    throw new IsoError(`the application identifier must be printable ASCII of at most ${MAX_APPLICATION_ID_LENGTH} characters`);
  }

  const root = await buildTree(entries);
  assignPrimaryIds(root);
  const layout = planLayout(root);
  const header = renderHeader(layout, options.volumeId, applicationId, timestamp);

  const temporary = `${outputPath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", options.mode ?? 0o600);
  try {
    await writeAll(handle, header, 0);
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (const file of layout.files) {
      if (file.size === 0) continue;
      const position = file.lba * SECTOR_SIZE;
      if (file.source.kind === "data") await writeAll(handle, file.source.data, position);
      else await copyInto(handle, position, file.source.path, file.size, chunk);
    }
    // Writing the pad also extends the file over the gaps after each file's last sector.
    await writeAll(handle, Buffer.alloc(PADDING_SECTORS * SECTOR_SIZE), layout.dataEndSector * SECTOR_SIZE);
    await handle.sync();
    await handle.close();
    await replaceFile(temporary, outputPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    bytes: layout.totalSectors * SECTOR_SIZE,
    sectors: layout.totalSectors,
    files: layout.files.length,
    directories: layout.primaryOrder.length,
  };
}

/**
 * Entries for every file and directory under `root`, placed under `prefix`
 * in the image. Symbolic links are followed: the image cannot store them.
 */
export async function entriesFromDirectory(root: string, prefix = ""): Promise<IsoEntry[]> {
  const entries: IsoEntry[] = [];
  const walk = async (dir: string, imagePath: string, depth: number): Promise<void> => {
    if (depth > MAX_PATH_COMPONENTS) {
      throw new IsoError(`${dir} is more than ${MAX_PATH_COMPONENTS} levels deep (or a symbolic link loops)`);
    }
    const names = (await readdir(dir)).sort();
    if (names.length === 0 && imagePath !== "") entries.push({ path: imagePath, directory: true });
    for (const name of names) {
      const hostPath = join(dir, name);
      const childPath = imagePath === "" ? name : `${imagePath}/${name}`;
      const info = await stat(hostPath);
      if (info.isDirectory()) await walk(hostPath, childPath, depth + 1);
      else if (info.isFile()) entries.push({ path: childPath, file: hostPath });
      else throw new IsoError(`${hostPath} is neither a regular file nor a directory`);
    }
  };
  const start = prefix.replace(/^\/+|\/+$/g, "");
  await walk(root, start, start === "" ? 0 : start.split("/").length);
  return entries;
}

function newDir(name: string, parent: DirNode | null): DirNode {
  return {
    kind: "dir",
    name,
    parent,
    children: new Map(),
    primaryId: "",
    primary: { lba: 0, sectors: 0, number: 0 },
    joliet: { lba: 0, sectors: 0, number: 0 },
  };
}

function childDir(parent: DirNode, name: string, entryPath: string): DirNode {
  const existing = parent.children.get(name);
  if (existing?.kind === "file") throw new IsoError(`"${entryPath}" needs "${name}" to be a directory, but it is a file`);
  if (existing) return existing;
  const dir = newDir(name, parent);
  parent.children.set(name, dir);
  return dir;
}

async function buildTree(entries: readonly IsoEntry[]): Promise<DirNode> {
  const root = newDir("", null);
  for (const entry of entries) {
    const parts = splitImagePath(entry.path);
    const name = parts[parts.length - 1]!;
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = childDir(dir, part, entry.path);

    if ("directory" in entry) {
      // A directory at level 9 would have to hold its own entries at level 9 too.
      if (parts.length >= MAX_PATH_COMPONENTS) {
        throw new IsoError(`"${entry.path}" would be a directory at level ${parts.length + 1}; ISO 9660 allows ${MAX_PATH_COMPONENTS}`);
      }
      childDir(dir, name, entry.path);
      continue;
    }

    const existing = dir.children.get(name);
    if (existing) {
      throw new IsoError(existing.kind === "dir" ? `"${entry.path}" is already a directory` : `"${entry.path}" is listed twice`);
    }

    let source: FileSource;
    let size: number;
    if ("data" in entry) {
      const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
      source = { kind: "data", data };
      size = data.length;
    } else {
      const info = await stat(entry.file).catch((error: NodeJS.ErrnoException) => {
        throw new IsoError(`cannot read "${entry.file}" for "${entry.path}": ${error.code ?? error.message}`, { cause: error });
      });
      if (!info.isFile()) throw new IsoError(`"${entry.file}" for "${entry.path}" is not a regular file`);
      source = { kind: "file", path: entry.file };
      size = info.size;
    }
    if (size > MAX_FILE_BYTES) throw new IsoError(`"${entry.path}" is ${size} bytes; files of 4 GiB or more are not supported`);

    dir.children.set(name, { kind: "file", name, primaryId: "", size, source, lba: 0 });
  }
  return root;
}

function assignPrimaryIds(dir: DirNode): void {
  // Children are named in Joliet order so the 8.3 names are a function of the input, not of its order.
  const namer = new PrimaryNamer();
  for (const child of sortedChildren(dir, JOLIET)) {
    child.primaryId = child.kind === "dir" ? namer.directory(child.name) : namer.file(child.name);
    if (child.kind === "dir") assignPrimaryIds(child);
  }
}

function sortedChildren(dir: DirNode, tree: TreeKind): Node[] {
  return [...dir.children.values()].sort(tree.compare);
}

/** Directories breadth first, children in tree order: the order ECMA-119 6.9.1 requires for the path table. */
function breadthFirst(root: DirNode, tree: TreeKind): DirNode[] {
  const order = [root];
  for (let i = 0; i < order.length; i++) {
    for (const child of sortedChildren(order[i]!, tree)) if (child.kind === "dir") order.push(child);
  }
  order.forEach((dir, index) => (tree.extent(dir).number = index + 1));
  return order;
}

function recordLength(identifierLength: number): number {
  // The record length must be even, hence a pad byte after an even-length identifier (33 is odd).
  return 33 + identifierLength + (identifierLength % 2 === 0 ? 1 : 0);
}

/** Offsets of records in a directory extent: a record never crosses a sector boundary (ECMA-119 6.8.1.1). */
function packRecords(lengths: readonly number[]): { offsets: number[]; sectors: number } {
  const offsets: number[] = [];
  let offset = 0;
  for (const length of lengths) {
    if ((offset % SECTOR_SIZE) + length > SECTOR_SIZE) offset = sectorsFor(offset) * SECTOR_SIZE;
    offsets.push(offset);
    offset += length;
  }
  return { offsets, sectors: Math.max(1, sectorsFor(offset)) };
}

function directoryRecordLengths(dir: DirNode, tree: TreeKind): number[] {
  // "." and ".." have the one-byte identifiers 0x00 and 0x01.
  return [recordLength(1), recordLength(1), ...sortedChildren(dir, tree).map((child) => recordLength(tree.identifier(child).length))];
}

function pathTableRecordLength(dir: DirNode, tree: TreeKind): number {
  const length = dir.parent === null ? 1 : tree.identifier(dir).length;
  return 8 + length + (length % 2);
}

interface Layout {
  primaryOrder: DirNode[];
  jolietOrder: DirNode[];
  primaryPathTableBytes: number;
  jolietPathTableBytes: number;
  pathTables: { primaryL: number; primaryM: number; jolietL: number; jolietM: number };
  files: FileNode[];
  /** First sector after the directories: where file data may start. */
  headerSectors: number;
  dataEndSector: number;
  totalSectors: number;
}

function planLayout(root: DirNode): Layout {
  const primaryOrder = breadthFirst(root, PRIMARY);
  const jolietOrder = breadthFirst(root, JOLIET);
  for (const dir of primaryOrder) dir.primary.sectors = packRecords(directoryRecordLengths(dir, PRIMARY)).sectors;
  for (const dir of jolietOrder) dir.joliet.sectors = packRecords(directoryRecordLengths(dir, JOLIET)).sectors;
  const primaryPathTableBytes = primaryOrder.reduce((sum, dir) => sum + pathTableRecordLength(dir, PRIMARY), 0);
  const jolietPathTableBytes = jolietOrder.reduce((sum, dir) => sum + pathTableRecordLength(dir, JOLIET), 0);

  let sector = SYSTEM_AREA_SECTORS + 3;
  const take = (count: number): number => {
    const start = sector;
    sector += count;
    return start;
  };
  const pathTables = {
    primaryL: take(sectorsFor(primaryPathTableBytes)),
    primaryM: take(sectorsFor(primaryPathTableBytes)),
    jolietL: take(sectorsFor(jolietPathTableBytes)),
    jolietM: take(sectorsFor(jolietPathTableBytes)),
  };
  for (const dir of primaryOrder) dir.primary.lba = take(dir.primary.sectors);
  for (const dir of jolietOrder) dir.joliet.lba = take(dir.joliet.sectors);
  const headerSectors = sector;

  const files: FileNode[] = [];
  const collect = (dir: DirNode): void => {
    for (const child of sortedChildren(dir, JOLIET)) {
      if (child.kind === "dir") collect(child);
      else files.push(child);
    }
  };
  collect(root);
  for (const file of files) {
    // An empty file owns no sector; location 0 is what other writers record for it.
    file.lba = file.size === 0 ? 0 : take(sectorsFor(file.size));
  }
  const dataEndSector = sector;
  const totalSectors = dataEndSector + PADDING_SECTORS;
  if (totalSectors > 0xffffffff) throw new IsoError("the image would exceed the 32-bit sector count ISO 9660 can record");

  return {
    primaryOrder,
    jolietOrder,
    primaryPathTableBytes,
    jolietPathTableBytes,
    pathTables,
    files,
    headerSectors,
    dataEndSector,
    totalSectors,
  };
}

function directoryRecord(identifier: Buffer, lba: number, size: number, isDirectory: boolean, date: Buffer): Buffer {
  const length = recordLength(identifier.length);
  const record = Buffer.alloc(length);
  record.writeUInt8(length, 0);
  record.writeUInt8(0, 1); // extended attribute record length
  writeBothEndian32(record, 2, lba);
  writeBothEndian32(record, 10, size);
  date.copy(record, 18);
  record.writeUInt8(isDirectory ? 0x02 : 0x00, 25);
  writeBothEndian16(record, 28, 1); // volume sequence number
  record.writeUInt8(identifier.length, 32);
  identifier.copy(record, 33);
  return record;
}

function recordFor(node: Node, tree: TreeKind, date: Buffer): Buffer {
  if (node.kind === "file") return directoryRecord(tree.identifier(node), node.lba, node.size, false, date);
  const extent = tree.extent(node);
  return directoryRecord(tree.identifier(node), extent.lba, extent.sectors * SECTOR_SIZE, true, date);
}

function directoryExtent(dir: DirNode, tree: TreeKind, date: Buffer): Buffer {
  const self = tree.extent(dir);
  const parent = tree.extent(dir.parent ?? dir);
  const records = [
    directoryRecord(Buffer.from([0x00]), self.lba, self.sectors * SECTOR_SIZE, true, date),
    directoryRecord(Buffer.from([0x01]), parent.lba, parent.sectors * SECTOR_SIZE, true, date),
    ...sortedChildren(dir, tree).map((child) => recordFor(child, tree, date)),
  ];
  const { offsets, sectors } = packRecords(records.map((record) => record.length));
  if (sectors !== self.sectors) throw new Error("directory size changed between planning and writing");
  const out = Buffer.alloc(sectors * SECTOR_SIZE);
  records.forEach((record, i) => record.copy(out, offsets[i]!));
  return out;
}

function pathTable(order: readonly DirNode[], tree: TreeKind, bigEndian: boolean): Buffer {
  const records = order.map((dir) => {
    const identifier = dir.parent === null ? Buffer.from([0x00]) : tree.identifier(dir);
    const record = Buffer.alloc(8 + identifier.length + (identifier.length % 2));
    record.writeUInt8(identifier.length, 0);
    const extent = tree.extent(dir);
    const parentNumber = tree.extent(dir.parent ?? dir).number;
    if (bigEndian) {
      record.writeUInt32BE(extent.lba, 2);
      record.writeUInt16BE(parentNumber, 6);
    } else {
      record.writeUInt32LE(extent.lba, 2);
      record.writeUInt16LE(parentNumber, 6);
    }
    identifier.copy(record, 8);
    return record;
  });
  return Buffer.concat(records);
}

function volumeDescriptor(
  joliet: boolean,
  layout: Layout,
  volumeId: string,
  applicationId: string,
  timestamp: Date,
): Buffer {
  const tree = joliet ? JOLIET : PRIMARY;
  const root = layout.primaryOrder[0]!;
  const text = joliet ? writeUcs2Field : writeAsciiField;
  const descriptor = Buffer.alloc(SECTOR_SIZE);
  descriptor.writeUInt8(joliet ? 2 : 1, 0);
  descriptor.write("CD001", 1, "latin1");
  descriptor.writeUInt8(1, 6);
  text(descriptor, 8, 32, ""); // system identifier
  text(descriptor, 40, 32, volumeId);
  writeBothEndian32(descriptor, 80, layout.totalSectors);
  // UCS-2 level 3: the escape sequence that makes a supplementary descriptor a Joliet one.
  if (joliet) descriptor.write("%/E", 88, "latin1");
  writeBothEndian16(descriptor, 120, 1); // volume set size
  writeBothEndian16(descriptor, 124, 1); // volume sequence number
  writeBothEndian16(descriptor, 128, SECTOR_SIZE);
  writeBothEndian32(descriptor, 132, joliet ? layout.jolietPathTableBytes : layout.primaryPathTableBytes);
  descriptor.writeUInt32LE(joliet ? layout.pathTables.jolietL : layout.pathTables.primaryL, 140);
  descriptor.writeUInt32BE(joliet ? layout.pathTables.jolietM : layout.pathTables.primaryM, 148);
  const rootExtent = tree.extent(root);
  directoryRecord(Buffer.from([0x00]), rootExtent.lba, rootExtent.sectors * SECTOR_SIZE, true, recordDate(timestamp)).copy(
    descriptor,
    156,
  );
  text(descriptor, 190, 128, ""); // volume set
  text(descriptor, 318, 128, ""); // publisher
  text(descriptor, 446, 128, ""); // data preparer
  text(descriptor, 574, 128, applicationId);
  text(descriptor, 702, 37, ""); // copyright file
  text(descriptor, 739, 37, ""); // abstract file
  text(descriptor, 776, 37, ""); // bibliographic file
  volumeDate(timestamp).copy(descriptor, 813); // creation
  volumeDate(timestamp).copy(descriptor, 830); // modification
  volumeDate(null).copy(descriptor, 847); // expiration
  volumeDate(null).copy(descriptor, 864); // effective
  descriptor.writeUInt8(1, 881); // file structure version
  return descriptor;
}

function renderHeader(layout: Layout, volumeId: string, applicationId: string, timestamp: Date): Buffer {
  const header = Buffer.alloc(layout.headerSectors * SECTOR_SIZE);
  const at = (sector: number) => sector * SECTOR_SIZE;
  volumeDescriptor(false, layout, volumeId, applicationId, timestamp).copy(header, at(SYSTEM_AREA_SECTORS));
  volumeDescriptor(true, layout, volumeId, applicationId, timestamp).copy(header, at(SYSTEM_AREA_SECTORS + 1));
  const terminator = header.subarray(at(SYSTEM_AREA_SECTORS + 2), at(SYSTEM_AREA_SECTORS + 3));
  terminator.writeUInt8(255, 0);
  terminator.write("CD001", 1, "latin1");
  terminator.writeUInt8(1, 6);

  pathTable(layout.primaryOrder, PRIMARY, false).copy(header, at(layout.pathTables.primaryL));
  pathTable(layout.primaryOrder, PRIMARY, true).copy(header, at(layout.pathTables.primaryM));
  pathTable(layout.jolietOrder, JOLIET, false).copy(header, at(layout.pathTables.jolietL));
  pathTable(layout.jolietOrder, JOLIET, true).copy(header, at(layout.pathTables.jolietM));

  const date = recordDate(timestamp);
  for (const dir of layout.primaryOrder) directoryExtent(dir, PRIMARY, date).copy(header, at(dir.primary.lba));
  for (const dir of layout.jolietOrder) directoryExtent(dir, JOLIET, date).copy(header, at(dir.joliet.lba));
  return header;
}

async function writeAll(handle: FileHandle, data: Uint8Array, position: number): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const { bytesWritten } = await handle.write(data, written, data.length - written, position + written);
    written += bytesWritten;
  }
}

/** Streams one host file into the image, and fails if it changed size since it was measured. */
async function copyInto(output: FileHandle, position: number, source: string, size: number, chunk: Buffer): Promise<void> {
  const input = await open(source, "r");
  try {
    let copied = 0;
    for (;;) {
      const { bytesRead } = await input.read(chunk, 0, chunk.length, copied);
      if (bytesRead === 0) break;
      if (copied + bytesRead > size) throw new IsoError(`"${source}" grew while the image was being written`);
      await writeAll(output, chunk.subarray(0, bytesRead), position + copied);
      copied += bytesRead;
    }
    if (copied !== size) throw new IsoError(`"${source}" shrank while the image was being written`);
  } finally {
    await input.close();
  }
}
