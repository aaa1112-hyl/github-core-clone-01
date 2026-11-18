// In-memory forge store: repositories, git objects, issues, pull requests, labels.
// Everything is in memory (no disk in the trial pod's read-only /bot; speed matters
// for the benchmark column). Deterministic where the suite can observe it.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  FORGE_EPOCH_SEC,
  FORGE_IDENTITY,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export { parseCommit, parseTree, buildTree, buildCommit, hashObject, collectReachable } from './git.ts';

// ---------------------------------------------------------------- scenario identity
// The suite names the token owner by the public seeded scenario (kit wire.ts):
// SCENARIO_SEED 0x6a09e667f3bcc909, users from scenarioRng('users'), viewer = users[0].
// Replicated here (FNV-1a + splitmix64 + xorshift64*) so the server answers the
// exact login the checks expect, without any kit file at runtime.

const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? 0x6a09e667f3bcc909n : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export function scenarioViewerLogin(): string {
  const seed = mix64(0x6a09e667f3bcc909n ^ fnv1a64('users'));
  const rng = new Rng(seed);
  // users[0]: first pick + last pick, login = first+last
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

export const VIEWER_LOGIN = scenarioViewerLogin();
export const VIEWER_ID = 1000;

// ---------------------------------------------------------------- ids

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

// ---------------------------------------------------------------- types

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  globalId: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  globalId: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  globalId: string;
}

export interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  issueCounter: number;
  pullCounter: number;
  commentCounter: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  repoSeq = 0;
  dbIdSeq = 0;
  seqCounter = 0;

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    this.dbIdSeq += 1;
    this.repoSeq += 1;
    const repo: Repo = {
      databaseId: this.dbIdSeq,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueCounter: 0,
      pullCounter: 0,
      commentCounter: 0,
      seq: this.repoSeq,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// ---------------------------------------------------------------- git object helpers on a repo

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** Entries of the tree at `segments` (empty = root tree of `treeOid`). */
export function treeEntriesAt(repo: Repo, treeOid: string, segments: readonly string[]): TreeEntry[] | null {
  let current = treeOid;
  for (const seg of segments) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const obj = repo.objects.get(current);
  if (!obj || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/** Blob oid at `path` in the tree `treeOid`, or null. */
export function blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) return null;
  const parent = treeEntriesAt(repo, treeOid, segments.slice(0, -1));
  if (parent === null) return null;
  const entry = parent.find((e) => e.name === segments[segments.length - 1]);
  if (!entry || entry.mode === '40000') return null;
  return entry.oid;
}

/** A new tree oid equal to `treeOid` but with `path` set to `blobOid` (or removed when null). */
export function treeWithPath(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw new Error('empty path');
  const build = (currentOid: string | null, depth: number): string => {
    const entries: TreeEntry[] = currentOid === null ? [] : parseTree(repo.objects.get(currentOid)!.data);
    const name = segments[depth];
    const rest = segments.slice(depth + 1);
    const kept = entries.filter((e) => e.name !== name);
    if (rest.length === 0) {
      if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
    } else {
      const existing = entries.find((e) => e.name === name && e.mode === '40000');
      const childOid = build(existing ? existing.oid : null, depth + 1);
      kept.push({ mode: '40000', name, oid: childOid });
    }
    return putObject(repo, 'tree', buildTree(kept));
  };
  return build(treeOid, 0);
}

/** Commit `message` on `branch` of `repo`, setting `path` to `content` (or deleting when content is null). */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null; treeOid: string } {
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref);
  let parentTree: string | null = null;
  const parents: string[] = [];
  if (tip !== undefined) {
    const commit = parseCommit(repo.objects.get(tip)!.data);
    parentTree = commit.tree;
    parents.push(tip);
  }
  let blobOid: string | null = null;
  if (content !== null) blobOid = putObject(repo, 'blob', content);
  const treeOid = treeWithPath(repo, parentTree, path, blobOid);
  const commitOid = putObject(repo, 'commit', buildCommit({ tree: treeOid, parents, message: message.endsWith('\n') ? message : `${message}\n` }));
  repo.refs.set(ref, commitOid);
  return { commitOid, blobOid, treeOid };
}

/** The commit oids reachable from `tip`, newest first (first-parent walk is enough for the suite). */
export function commitHistory(repo: Repo, tip: string | undefined): string[] {
  if (tip === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

/** Merge-base of two commits (first common ancestor in BFS order). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set(commitHistory(repo, a));
  for (const oid of commitHistory(repo, b)) if (ancestorsA.has(oid)) return oid;
  return null;
}

/** Flat map of path -> blob oid for a tree (recursive). */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [k, v] of flattenTree(repo, entry.oid, path)) out.set(k, v);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

function countLines(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Diff files between base tree and head tree (for pull request files). */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string): PullFile[] {
  const base = baseTreeOid === null ? new Map<string, string>() : flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const files: PullFile[] = [];
  for (const [path, headOid] of head) {
    const baseOid = base.get(path);
    if (baseOid === undefined) {
      const lines = countLines(repo.objects.get(headOid)!.data);
      files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (baseOid !== headOid) {
      const newLines = countLines(repo.objects.get(headOid)!.data);
      const oldLines = countLines(repo.objects.get(baseOid)!.data);
      files.push({ filename: path, status: 'modified', additions: newLines, deletions: oldLines, changes: newLines + oldLines });
    }
  }
  for (const path of base.keys()) {
    if (!head.has(path)) {
      const oldLines = countLines(repo.objects.get(base.get(path)!)!.data);
      files.push({ filename: path, status: 'removed', additions: 0, deletions: oldLines, changes: oldLines });
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return files;
}

/**
 * Three-way merge of `headTree` onto `currentTree` with `baseTree` as ancestor.
 * Returns the merged tree oid, or null on conflict.
 */
export function threeWayMerge(repo: Repo, baseTreeOid: string | null, headTreeOid: string, currentTreeOid: string): string | null {
  const base = baseTreeOid === null ? new Map<string, string>() : flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const current = flattenTree(repo, currentTreeOid);
  const paths = new Set([...base.keys(), ...head.keys(), ...current.keys()]);
  let mergedTreeOid: string | null = null;
  // Build the merged tree from scratch: start from current tree, apply per-path decisions.
  const merged = new Map<string, string>(current);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const c = current.get(path);
    if (h === b) {
      // head unchanged: keep current
      continue;
    }
    if (c === b) {
      // current unchanged: take head
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
      continue;
    }
    if (h === c) continue; // both changed the same way
    return null; // conflict
  }
  // Rebuild nested trees from the flat map.
  const build = (pathsMap: Map<string, string>): string | null => {
    const byDir = new Map<string, Map<string, string>>();
    const files = new Map<string, string>();
    for (const [path, oid] of pathsMap) {
      const slash = path.indexOf('/');
      if (slash < 0) files.set(path, oid);
      else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        if (!byDir.has(dir)) byDir.set(dir, new Map());
        byDir.get(dir)!.set(rest, oid);
      }
    }
    const entries: TreeEntry[] = [];
    for (const [name, oid] of files) entries.push({ mode: '100644', name, oid });
    for (const [dir, sub] of byDir) {
      const child = build(sub);
      if (child === null) return null;
      entries.push({ mode: '40000', name: dir, oid: child });
    }
    if (entries.length === 0) return null;
    return putObject(repo, 'tree', buildTree(entries));
  };
  mergedTreeOid = build(merged);
  if (mergedTreeOid === null) {
    // Empty tree (everything deleted): use the empty tree object.
    mergedTreeOid = putObject(repo, 'tree', buildTree([]));
  }
  return mergedTreeOid;
}

/** Is `ancestor` reachable from `tip`? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  return collectReachable([tip], (oid) => repo.objects.get(oid), { allowMissing: true }).has(ancestor);
}

/**
 * Squash-merge `pr` onto its base branch: three-way merge of the head tree onto the
 * current base tree, then one squash commit. Returns the squash commit oid, or null
 * on a merge conflict.
 */
export function squashMerge(repo: Repo, pr: PullRequest): string | null {
  const baseTip = repo.refs.get(branchRef(pr.baseRef));
  if (baseTip === undefined) return null;
  const baseCommit = repo.objects.get(pr.baseSha);
  const headCommit = repo.objects.get(pr.headSha);
  const currentBaseCommit = repo.objects.get(baseTip);
  if (!baseCommit || !headCommit || !currentBaseCommit) return null;
  const mergedTree = threeWayMerge(
    repo,
    parseCommit(baseCommit.data).tree,
    parseCommit(headCommit.data).tree,
    parseCommit(currentBaseCommit.data).tree,
  );
  if (mergedTree === null) return null;
  const squashMessage = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
  const squashOid = putObject(repo, 'commit', buildCommit({ tree: mergedTree, parents: [baseTip], message: squashMessage.endsWith('\n') ? squashMessage : `${squashMessage}\n` }));
  repo.refs.set(branchRef(pr.baseRef), squashOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = new Date().toISOString();
  pr.mergeCommitSha = squashOid;
  return squashOid;
}

export { ZERO_OID, isObjectId };
