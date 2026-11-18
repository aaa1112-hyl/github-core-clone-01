// Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack (v2 + v0
// fallback), git-receive-pack (v0). Pure Node stdlib; no git binary.
// The suite's client (kit sdk/conformance/git-client.ts) is the reference for
// every framing decision here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  parseCommit,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitPacket,
} from './git.ts';
import { branchRef, getObject, type Repo, type Store } from './store.ts';
import { bearerToken, errJson, pathOf, readBody } from './http-util.ts';

interface GitContext {
  store: Store;
  token: string;
}

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/1.0';

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function allRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  for (const [ref, oid] of repo.refs) out.push({ oid, name: ref });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

function headOid(repo: Repo): string {
  return repo.refs.get(branchRef(repo.defaultBranch)) ?? ZERO_OID;
}

/** Parse pkt-lines from the start of `buf` until a flush; returns lines + bytes after the flush. */
function parsePktLinesUntilFlush(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > buf.length) throw new Error('pkt-line header is truncated');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len)) throw new Error(`pkt-line length ${JSON.stringify(lenText)} is not hex`);
    if (len === 0) {
      offset += 4;
      return { lines, rest: buf.subarray(offset) };
    }
    if (len === 1 || len === 2) {
      // delim / response-end: treat as a separator and continue
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('pkt-line length is out of range');
    lines.push(buf.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
}

function sidebandPack(pack: Buffer): Buffer {
  // Band-1 pkt-lines, each carrying at most 65515 payload bytes after the band byte.
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
    offset += chunk.length;
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** Commits reachable from `wants` with BFS distance, up to `maxDepth` (Infinity = all). */
function commitsWithinDepth(repo: Repo, wants: readonly string[], maxDepth: number): { included: Map<string, number>; shallow: string[] } {
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = wants.map((w) => ({ oid: w, depth: 0 }));
  const shallow: string[] = [];
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (included.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    included.set(oid, depth);
    const parents = parseCommit(obj.data).parents;
    if (depth + 1 >= maxDepth) {
      if (parents.length > 0) shallow.push(oid);
      continue;
    }
    for (const p of parents) queue.push({ oid: p, depth: depth + 1 });
  }
  return { included, shallow };
}

function objectsForFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  filter: string | null,
  clientShallow: readonly string[],
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const maxDepth = depth === null ? Infinity : depth;
  const { included, shallow } = commitsWithinDepth(repo, wants, maxDepth);
  const shallowSet = new Set(shallow);
  // What the client already has: the closure of its haves, EXCEPT anything
  // reachable through a shallow boundary's parents. A client that holds a
  // shallow tip does not hold that tip's parents, and a deepen request is
  // precisely asking for them.
  let haveClosure = collectReachable(haves, (oid) => repo.objects.get(oid), { allowMissing: true });
  if (clientShallow.length > 0) {
    const beyond = new Set<string>();
    for (const boundary of clientShallow) {
      const obj = repo.objects.get(boundary);
      if (obj?.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        for (const oid of collectReachable([parent], (o) => repo.objects.get(o), { allowMissing: true })) beyond.add(oid);
      }
    }
    haveClosure = new Set([...haveClosure].filter((oid) => !beyond.has(oid)));
  }
  // Phase 1: the send set — everything reachable from the included commits,
  // ignoring what the client has, stopping at shallow boundaries.
  const wanted = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (wanted.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    wanted.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      if (entry.mode === '40000') walkTree(entry.oid);
      else wanted.add(entry.oid);
    }
  };
  const walkCommit = (oid: string): void => {
    if (wanted.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return;
    wanted.add(oid);
    const commit = parseCommit(obj.data);
    walkTree(commit.tree);
    if (!shallowSet.has(oid)) {
      for (const parent of commit.parents) walkCommit(parent);
    }
  };
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'commit') walkCommit(want);
    else if (obj.type === 'tree') walkTree(want);
    else wanted.add(want);
  }
  // Phase 2: drop what the client already holds.
  const objects: GitObject[] = [];
  const noBlobs = filter !== null && filter.startsWith('blob:none');
  let blobLimit: number | null = null;
  if (filter !== null) {
    const m = /^blob:limit=(\d+)$/.exec(filter);
    if (m) blobLimit = Number(m[1]);
  }
  for (const oid of wanted) {
    if (haveClosure.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'blob') {
      if (noBlobs) continue;
      if (blobLimit !== null && obj.data.length > blobLimit) continue;
    }
    objects.push(obj);
  }
  // Boundaries the client held that are now interior (no longer shallow).
  const unshallow = clientShallow.filter((b) => included.has(b) && !shallowSet.has(b));
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------- advertisements

function uploadPackAdvertisement(repo: Repo, wantV2: boolean): Buffer {
  if (wantV2) {
    const lines = [
      '# service=git-upload-pack\n',
      'flush',
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow filter\n',
      'object-format=sha1\n',
      'flush',
    ];
    return encodePktLines(lines);
  }
  // v0: HEAD first with capabilities after NUL, then refs, then flush.
  const caps = `side-band-64k symref=HEAD:${branchRef(repo.defaultBranch)} agent=${AGENT} thin-pack ofs-delta multi_ack shallow`;
  const refs = allRefs(repo);
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii')];
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(encodePktLine(`${head} HEAD\u0000${caps}\n`));
    for (const ref of refs) parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = allRefs(repo);
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), Buffer.from('0000', 'ascii')];
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(encodePktLine(`${head} HEAD\u0000${caps}\n`));
    for (const ref of refs) parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 ls-refs

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const refs = allRefs(repo);
  const head = headOid(repo);
  const symrefAttr = symrefs ? ` symref-target:${branchRef(repo.defaultBranch)}` : '';
  if (refs.length === 0) {
    // Only HEAD is advertised for an unborn repo. A refs/heads/<branch>
    // 'unborn' line would make clients treat the branch as existing with a
    // zero tip and then fetch that zero oid.
    if (unborn) {
      if (keep('HEAD')) out.push(encodePktLine(`unborn HEAD${symrefAttr}\n`));
    }
  } else {
    if (keep('HEAD')) out.push(encodePktLine(`${head} HEAD${symrefAttr}\n`));
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const obj = repo.objects.get(ref.oid);
        if (obj && obj.type === 'tag') {
          // Peeled tag target (not exercised by the suite, but correct).
          const target = (obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m) ?? [])[1];
          if (target) line += ` peeled:${target}`;
        }
      }
      out.push(encodePktLine(`${line}\n`));
    }
  }
  out.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- v2 fetch

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let filter: string | null = null;
  void shallowBoundaries;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowBoundaries.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7));
    else if (text.startsWith('filter ')) filter = text.slice(7).trim();
    // thin-pack / no-progress / ofs-delta / done / agent / object-format: accepted, no action
  }
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLine('acknowledgments\n'));
  const knownHaves = haves.filter((h) => repo.objects.has(h));
  if (haves.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else if (knownHaves.length === haves.length) {
    for (const h of knownHaves) parts.push(encodePktLine(`ACK ${h}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  if (wants.length === 0) {
    // No wants: no packfile section at all.
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }
  // shallow-info
  const missing = wants.filter((w) => !repo.objects.has(w));
  const { objects, shallow, unshallow } = objectsForFetch(repo, wants, haves, depth, filter, shallowBoundaries);
  if ((depth !== null && shallow.length > 0) || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // packfile
  parts.push(encodePktLine('packfile\n'));
  if (missing.length > 0) {
    const msg = Buffer.from(`object not found: ${missing[0]}\n`, 'utf8');
    parts.push(encodePktLine(Buffer.concat([Buffer.from([3]), msg])));
  } else {
    const pack = writePack(objects);
    let offset = 0;
    while (offset < pack.length) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
      offset += chunk.length;
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 fetch

function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let inHaves = false;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === '') continue;
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const oid = rest.split(' ')[0];
      wants.push(oid);
      continue;
    }
    if (text.startsWith('shallow ')) continue;
    if (text.startsWith('deepen ')) {
      depth = Number(text.slice(7));
      continue;
    }
    if (text === 'done') {
      inHaves = true;
      continue;
    }
    if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
      continue;
    }
    void inHaves;
  }
  // The v0 request is two sections split by a flush, but decodePktLines already
  // flattened them; the want/have parsing above covers both sections.
  const parts: Buffer[] = [];
  const { objects, shallow } = objectsForFetch(repo, wants, haves, depth, null, []);
  for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
  const knownHaves = haves.filter((h) => repo.objects.has(h));
  if (haves.length === 0) parts.push(encodePktLine('NAK\n'));
  else if (knownHaves.length === haves.length) {
    for (const h of knownHaves) parts.push(encodePktLine(`ACK ${h}\n`));
  } else parts.push(encodePktLine('NAK\n'));
  const pack = writePack(objects);
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { lines, rest } = parsePktLinesUntilFlush(body);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef) {
    if (rest.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const read = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
        if (!read.checksumOk) throw new Error('pack checksum mismatch');
        for (const [oid, obj] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (repo.refs.has(cmd.ref)) {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        } else {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        }
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        if (!repo.objects.has(cmd.newOid)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (current === undefined || current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (cmd.newOid.toLowerCase() === cmd.oldOid.toLowerCase()) {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      const newObj = repo.objects.get(cmd.newOid);
      if (!newObj || newObj.type !== 'commit') {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      // Fast-forward: old tip must be an ancestor of the new tip.
      const reachable = collectReachable([cmd.newOid], (oid) => repo.objects.get(oid), { allowMissing: true });
      if (!reachable.has(cmd.oldOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }
  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  if (unpackOk) {
    for (const r of results) {
      reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
    }
  }
  const report = encodePktLines(reportLines);
  // Sideband band 1 wraps the report pkt-lines; a final flush ends the stream.
  const parts: Buffer[] = [encodePktLine(Buffer.concat([Buffer.from([1]), report]))];
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- router

export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: GitContext): Promise<boolean> {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const suffix = match[3] ?? '';
  const method = req.method ?? 'GET';
  const found = ctx.store.getRepo(owner, name);
  if (!found) {
    // Missing repository is 404 on both services' GET /info/refs, and the server stays up.
    if (method === 'GET' && suffix.startsWith('/info/refs')) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }
  const token = bearerToken(req);
  if (token === null || token !== ctx.token) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }

  if (method === 'GET' && suffix === '/info/refs') {
    const url = new URL(req.url ?? '/', 'http://forge');
    const service = url.searchParams.get('service');
    const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      sendRaw(res, 200, UPLOAD_AD_CT, uploadPackAdvertisement(found, wantV2));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, RECEIVE_AD_CT, receivePackAdvertisement(found));
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }

  if (method === 'POST' && suffix === '/git-upload-pack') {
    let body: Buffer | null = null;
    try {
      body = await readBody(req);
    } catch {
      errJson(res, 400, 'Bad Request');
      return true;
    }
    if (body === null || body.length === 0) {
      errJson(res, 400, 'Bad Request');
      return true;
    }
    const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const packets: GitPacket[] = decodePktLines(body);
      const lines = packets.filter((p): p is { kind: 'data'; line: string; raw: Buffer } => p.kind === 'data').map((p) => p.line);
      const command = lines[0]?.replace(/\n$/, '');
      if (wantV2 && command === 'command=ls-refs') {
        sendRaw(res, 200, UPLOAD_RESULT_CT, handleLsRefs(found, lines.slice(1)));
        return true;
      }
      if (wantV2 && command === 'command=fetch') {
        sendRaw(res, 200, UPLOAD_RESULT_CT, handleFetchV2(found, lines.slice(1)));
        return true;
      }
      if (!wantV2) {
        // v0 upload-pack request: want lines, flush, have lines, done.
        sendRaw(res, 200, UPLOAD_RESULT_CT, handleFetchV0(found, lines));
        return true;
      }
      errJson(res, 400, 'Unknown command');
      return true;
    } catch {
      errJson(res, 400, 'Bad Request');
      return true;
    }
  }

  if (method === 'POST' && suffix === '/git-receive-pack') {
    let body: Buffer | null = null;
    try {
      body = await readBody(req);
    } catch {
      errJson(res, 400, 'Bad Request');
      return true;
    }
    if (body === null || body.length === 0) {
      errJson(res, 400, 'Bad Request');
      return true;
    }
    try {
      sendRaw(res, 200, RECEIVE_RESULT_CT, handleReceivePack(found, body));
      return true;
    } catch {
      errJson(res, 400, 'Bad Request');
      return true;
    }
  }

  errJson(res, 404, 'Not Found');
  return true;
}
