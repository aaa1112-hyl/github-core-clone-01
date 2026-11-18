// Git object model, packfile read/write and pkt-line framing, in Node stdlib only.
// Mirrors the wire formats the suite's own client (kit sdk/conformance/git-client.ts)
// speaks: SHA-1 object ids, no-delta pack output, delta resolution on pack input.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflateSync, deflateSync as zlibDeflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export class GitError extends Error {
  readonly code: string;
  constructor(message: string, code = 'git') {
    super(message);
    this.code = code;
  }
}

function asBuffer(value: string | Uint8Array): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new GitError('tree entry has no mode separator', 'tree-parse');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitError('tree entry has no name terminator', 'tree-parse');
    if (nul + 21 > buffer.length) throw new GitError('tree entry has a truncated object id', 'tree-parse');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new GitError(`tree entry ${entry.name} has a bad object id`, 'tree-build');
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new GitError('commit has no valid tree header', 'commit-parse');
  return { tree, parents, author, committer, message };
}

export const FORGE_IDENTITY = 'Forge <forge@localhost>';
/** Fixed commit timestamp: the forge never uses the wall clock in git data. */
export const FORGE_EPOCH_SEC = 1735689600;

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FORGE_EPOCH_SEC;
  const who = `${fields.author ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseTag(data: Uint8Array): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new GitError('tag has no valid object header', 'tag-parse');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new GitError('tag has bad type', 'tag-parse');
  return { object, type, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8') };
}

// ---------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new GitError(`object ${oid} is missing from the store`, 'missing-object');
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** The objects reachable from `newTips` that a store holding `serverTips` does not have. */
export function objectsToSend(lookup: ObjectLookup, serverTips: Iterable<string>, newTips: Iterable<string>): GitObject[] {
  const onServer = collectReachable(serverTips, lookup, { allowMissing: true });
  const wanted = collectReachable(newTips, lookup);
  const send: GitObject[] = [];
  for (const oid of wanted) {
    if (onServer.has(oid)) continue;
    const object = lookup(oid);
    if (object) send.push(object);
  }
  return send;
}

// ---------------------------------------------------------------- packfile read

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new GitError('pack entry has no size header', 'pack-truncated');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('pack entry size varint is truncated', 'pack-truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new GitError('pack entry size varint is too long', 'pack-corrupt');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new GitError('ofs-delta has no base offset', 'pack-truncated');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitError('ofs-delta base offset is truncated', 'pack-truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = zlibInflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new GitError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`, 'pack-zlib');
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new GitError(`zlib stream at offset ${offset} consumed no bytes`, 'pack-zlib');
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new GitError('delta size varint is truncated', 'delta-corrupt');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitError('delta size varint is too long', 'delta-corrupt');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new GitError(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`, 'delta-base-size');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new GitError('delta copy is out of the base', 'delta-corrupt');
      if (written + copySize > targetSize) throw new GitError('delta writes past its target size', 'delta-corrupt');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new GitError('delta insert is truncated', 'delta-corrupt');
      if (written + literal > targetSize) throw new GitError('delta writes past its target size', 'delta-corrupt');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitError('delta opcode 0 is invalid', 'delta-corrupt');
    }
  }
  if (written !== targetSize) throw new GitError(`delta produced ${written} of ${targetSize} bytes`, 'delta-size');
  return out;
}

export interface PackEntry {
  readonly offset: number;
  readonly type: GitObjectType;
  readonly size: number;
  readonly data: Buffer;
  readonly oid: string;
  readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOid: string } | null;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly entries: PackEntry[];
  readonly checksumOk: boolean;
  readonly deltaCount: number;
}

export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new GitError('pack is too short', 'pack-truncated');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitError('pack has no PACK magic', 'pack-corrupt');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`pack version ${version} is not supported`, 'pack-corrupt');
  const count = buffer.readUInt32BE(8);
  const trailer = buffer.subarray(buffer.length - 20).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  let offset = 12;
  let deltaCount = 0;
  const raw: Array<{ offset: number; typeCode: number; size: number; data: Buffer; delta: PackEntry['delta'] }> = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(buffer, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    let delta: PackEntry['delta'] = null;
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      delta = { kind: 'ofs', baseOid: '' };
      // base offset resolves after the loop (needs byOffset map)
      raw.push({ offset: entryOffset, typeCode, size, data: Buffer.alloc(0), delta: { kind: 'ofs', baseOid: String(base.baseOffset) } });
      const inflated = inflateAt(buffer, offset);
      raw[raw.length - 1].data = inflated.data;
      offset = inflated.next;
      deltaCount += 1;
      continue;
    }
    if (typeCode === 7) {
      const baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      delta = { kind: 'ref', baseOid };
      const inflated = inflateAt(buffer, offset);
      raw.push({ offset: entryOffset, typeCode, size, data: inflated.data, delta });
      offset = inflated.next;
      deltaCount += 1;
      continue;
    }
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new GitError(`pack object type ${typeCode} is unknown`, 'pack-corrupt');
    const inflated = inflateAt(buffer, offset);
    if (inflated.data.length !== size) throw new GitError(`pack object at ${entryOffset} inflated to ${inflated.data.length} bytes, expected ${size}`, 'pack-corrupt');
    raw.push({ offset: entryOffset, typeCode, size, data: inflated.data, delta: null });
    offset = inflated.next;
  }
  // Resolve entries in offset order; deltas may point forward, so resolve lazily with memoisation.
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolveEntry = (entryOffset: number): GitObject => {
    const cached = resolved.get(entryOffset);
    if (cached) return cached;
    if (resolving.has(entryOffset)) throw new GitError('pack delta cycle', 'pack-corrupt');
    resolving.add(entryOffset);
    const rawEntry = raw.find((r) => r.offset === entryOffset);
    if (!rawEntry) throw new GitError(`pack entry at ${entryOffset} is missing`, 'pack-corrupt');
    let result: GitObject;
    if (rawEntry.delta === null) {
      const type = CODE_TYPE[rawEntry.typeCode]!;
      result = { type, data: rawEntry.data };
    } else if (rawEntry.delta.kind === 'ofs') {
      const baseOffset = Number(rawEntry.delta.baseOid);
      const baseEntryOffset = entryOffset - baseOffset;
      let base: GitObject;
      const byOff = byOffset.get(baseEntryOffset);
      if (byOff) {
        base = { type: byOff.type, data: byOff.data };
      } else {
        base = resolveEntry(baseEntryOffset);
      }
      const data = applyDelta(base.data, rawEntry.data);
      result = { type: base.type, data };
    } else {
      const baseOid = rawEntry.delta.baseOid;
      let base: GitObject | undefined = options.resolveBase?.(baseOid);
      if (!base) {
        const byId = byOid.get(baseOid);
        if (byId) base = { type: byId.type, data: byId.data };
      }
      if (!base) throw new GitError(`ref-delta base ${baseOid} is not available`, 'pack-corrupt');
      const data = applyDelta(base.data, rawEntry.data);
      result = { type: base.type, data };
    }
    resolving.delete(entryOffset);
    resolved.set(entryOffset, result);
    return result;
  };
  // First pass: register non-delta entries so ofs bases can be found directly.
  for (const r of raw) {
    if (r.delta === null) {
      const type = CODE_TYPE[r.typeCode]!;
      const oid = hashObject(type, r.data);
      const entry: PackEntry = { offset: r.offset, type, size: r.size, data: r.data, oid, delta: null };
      entries.push(entry);
      byOffset.set(r.offset, entry);
      byOid.set(oid, entry);
    }
  }
  for (const r of raw) {
    if (r.delta === null) continue;
    const obj = resolveEntry(r.offset);
    const oid = hashObject(obj.type, obj.data);
    const entry: PackEntry = { offset: r.offset, type: obj.type, size: obj.data.length, data: obj.data, oid, delta: r.delta };
    entries.push(entry);
    byOffset.set(r.offset, entry);
    byOid.set(oid, entry);
  }
  entries.sort((a, b) => a.offset - b.offset);
  const objects = new Map<string, GitObject>();
  for (const entry of entries) objects.set(entry.oid, { type: entry.type, data: entry.data });
  return { objects, entries, checksumOk: trailer === computed, deltaCount };
}

// ---------------------------------------------------------------- packfile write (no deltas)

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- pkt-line

export type GitPacket =
  | { kind: 'data'; line: string; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const body = asBuffer(payload);
  if (body.length + 4 > PKT_LINE_MAX) throw new GitError('pkt-line payload is too large', 'pkt-line');
  const len = body.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function encodePktLines(lines: Array<string | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktLineFlush());
    else if (line === 'delim') parts.push(pktLineDelim());
    else if (line === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/** Parse a whole buffer of pkt-lines (no streaming state). */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const buffer = asBuffer(bytes);
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new GitError('pkt-line header is truncated', 'pkt-line');
    const lenText = buffer.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len)) throw new GitError(`pkt-line length ${JSON.stringify(lenText)} is not hex`, 'pkt-line');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buffer.length) throw new GitError('pkt-line length is out of range', 'pkt-line');
    const raw = buffer.subarray(offset + 4, offset + len);
    packets.push({ kind: 'data', line: raw.toString('utf8'), raw: Buffer.from(raw) });
    offset += len;
  }
  return packets;
}

export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.line);
    else if (packet.kind === 'flush') lines.push('flush');
    else if (packet.kind === 'delim') lines.push('delim');
    else lines.push('response-end');
  }
  return lines;
}
