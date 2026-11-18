// GitHub GraphQL v4 (/api/graphql): a small parser + executor for exactly the
// documents gh and github-mcp-server send, plus introspection. Unknown fields are
// HTTP 200 with an errors array; an unknown repository is data.repository = null
// with no errors; no token is HTTP 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  diffTrees,
  getObject,
  globalId,
  parseCommit,
  squashMerge,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { bearerToken, errJson, parseJsonBody, readBody, sendJson } from './http-util.ts';

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; type: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  type: string;
  selections: SelectionNode[];
}

class GqlParseError extends Error {}

class Lexer {
  pos = 0;
  src: string;
  constructor(src: string) {
    this.src = src;
  }
  skipIgnored(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos])) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }
  peek(): string {
    this.skipIgnored();
    return this.src[this.pos] ?? '';
  }
  take(): string {
    this.skipIgnored();
    return this.src[this.pos++] ?? '';
  }
  expect(ch: string): void {
    const got = this.take();
    if (got !== ch) throw new GqlParseError(`expected ${JSON.stringify(ch)}, got ${JSON.stringify(got)}`);
  }
  readName(): string {
    this.skipIgnored();
    let out = '';
    while (this.pos < this.src.length && /[_A-Za-z0-9]/.test(this.src[this.pos])) out += this.src[this.pos++];
    if (out === '') throw new GqlParseError('expected a name');
    return out;
  }
  readString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length) throw new GqlParseError('unterminated string');
      const ch = this.src[this.pos++];
      if (ch === '"') break;
      if (ch === '\\') {
        const esc = this.src[this.pos++];
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'u') {
          out += String.fromCharCode(parseInt(this.src.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc;
      } else out += ch;
    }
    return out;
  }
  readNumber(): { kind: 'int' | 'float'; value: number } {
    this.skipIgnored();
    let out = '';
    if (this.src[this.pos] === '-') out += this.src[this.pos++];
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) out += this.src[this.pos++];
    if (/[eE]/.test(this.src[this.pos] ?? '')) {
      out += this.src[this.pos++];
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') out += this.src[this.pos++];
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) out += this.src[this.pos++];
    }
    const value = Number(out);
    return { kind: out.includes('.') || /[eE]/.test(out) ? 'float' : 'int', value };
  }
}

function parseValue(lex: Lexer): Value {
  const ch = lex.peek();
  if (ch === '$') {
    lex.take();
    return { kind: 'var', name: lex.readName() };
  }
  if (ch === '"') return { kind: 'string', value: lex.readString() };
  if (ch === '[') {
    lex.take();
    const items: Value[] = [];
    while (lex.peek() !== ']') items.push(parseValue(lex));
    lex.take();
    return { kind: 'list', items };
  }
  if (ch === '{') {
    lex.take();
    const fields: Array<{ name: string; value: Value }> = [];
    while (lex.peek() !== '}') {
      const name = lex.readName();
      lex.expect(':');
      fields.push({ name, value: parseValue(lex) });
    }
    lex.take();
    return { kind: 'object', fields };
  }
  if (ch === '-' || /[0-9]/.test(ch)) {
    const n = lex.readNumber();
    return n.kind === 'int' ? { kind: 'int', value: n.value } : { kind: 'float', value: n.value };
  }
  const name = lex.readName();
  if (name === 'true') return { kind: 'bool', value: true };
  if (name === 'false') return { kind: 'bool', value: false };
  if (name === 'null') return { kind: 'null' };
  return { kind: 'enum', value: name };
}

function parseArguments(lex: Lexer): Array<{ name: string; value: Value }> {
  const args: Array<{ name: string; value: Value }> = [];
  if (lex.peek() !== '(') return args;
  lex.take();
  while (lex.peek() !== ')') {
    const name = lex.readName();
    lex.expect(':');
    args.push({ name, value: parseValue(lex) });
  }
  lex.take();
  return args;
}

function parseSelectionSet(lex: Lexer): SelectionNode[] {
  lex.expect('{');
  const sels: SelectionNode[] = [];
  while (lex.peek() !== '}') {
    if (lex.peek() === '.' && lex.src.slice(lex.pos, lex.pos + 3) === '...') {
      lex.pos += 3;
      const name = lex.readName();
      if (name === 'on') {
        const type = lex.readName();
        sels.push({ kind: 'fragment', type, selections: parseSelectionSet(lex) });
      } else {
        sels.push({ kind: 'spread', name });
      }
      continue;
    }
    const first = lex.readName();
    let alias: string | null = null;
    let name = first;
    if (lex.peek() === ':') {
      lex.take();
      alias = first;
      name = lex.readName();
    }
    const args = parseArguments(lex);
    // Directives: parse and ignore (none are used by the suite's documents).
    while (lex.peek() === '@') {
      lex.take();
      lex.readName();
      parseArguments(lex);
    }
    const selections = lex.peek() === '{' ? parseSelectionSet(lex) : [];
    sels.push({ kind: 'field', field: { alias, name, args, selections } });
  }
  lex.take();
  return sels;
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

function parseDocument(src: string): Document {
  const lex = new Lexer(src);
  const operations: Operation[] = [];
  const fragments = new Map<string, FragmentDef>();
  for (;;) {
    lex.skipIgnored();
    if (lex.pos >= src.length) break;
    if (lex.peek() === '{') {
      operations.push({ kind: 'query', name: null, selections: parseSelectionSet(lex) });
      continue;
    }
    const keyword = lex.readName();
    if (keyword === 'fragment') {
      const name = lex.readName();
      const on = lex.readName();
      if (on !== 'on') throw new GqlParseError('fragment needs "on"');
      const type = lex.readName();
      fragments.set(name, { name, type, selections: parseSelectionSet(lex) });
      continue;
    }
    if (keyword === 'query' || keyword === 'mutation') {
      let name: string | null = null;
      if (/[_A-Za-z]/.test(lex.peek())) name = lex.readName();
      // Variable definitions: ($x: Type = default, ...)
      if (lex.peek() === '(') {
        let depth = 0;
        while (lex.pos < src.length) {
          const ch = lex.take();
          if (ch === '(') depth += 1;
          else if (ch === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
      }
      operations.push({ kind: keyword, name, selections: parseSelectionSet(lex) });
      continue;
    }
    throw new GqlParseError(`unexpected document keyword ${JSON.stringify(keyword)}`);
  }
  return { operations, fragments };
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name] ?? null;
    case 'int':
    case 'float':
      return value.value;
    case 'string':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema knowledge

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title',
    'body', 'createdAt', 'updatedAt', 'author', 'mergeCommit', 'mergedAt',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  RepositoryOwner: ['login', 'id'],
  Ref: ['name'],
  SearchType: [],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Schema: ['queryType', 'mutationType', 'types', 'directives'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'PACKAGE', 'MARKETPLACE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- execution

interface GqlContext {
  store: Store;
  token: string;
}

type AnyObj = Record<string, unknown>;

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function findRepoByGlobalId(ctx: GqlContext, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbid = Number(decoded.parts[0]);
  for (const repo of ctx.store.repos.values()) if (repo.databaseId === dbid) return repo;
  return null;
}

function findIssueByGlobalId(ctx: GqlContext, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const dbid = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId !== dbid) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(ctx: GqlContext, id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const dbid = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId !== dbid) continue;
    const pr = repo.pulls.find((p) => p.number === number);
    if (pr) return { repo, pr };
  }
  return null;
}

interface ExecState {
  errors: Array<{ message: string }>;
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

function issueNode(repo: Repo, issue: Issue): AnyObj {
  return {
    __type: 'Issue',
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    _repo: repo,
    _issue: issue,
  };
}

function pullNode(repo: Repo, pr: PullRequest): AnyObj {
  return {
    __type: 'PullRequest',
    id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: 'UNKNOWN',
    _repo: repo,
    _pr: pr,
  };
}

function repoNode(repo: Repo): AnyObj {
  return {
    __type: 'Repository',
    id: globalId('Repository', repo.databaseId),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 },
    defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    _repo: repo,
  };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function executeSelections(
  typeName: string,
  value: AnyObj | null,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  doc: Document,
  ctx: GqlContext,
  state: ExecState,
): AnyObj | null {
  if (value === null) return null;
  const out: AnyObj = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = doc.fragments.get(sel.name);
      if (!frag) continue;
      const sub = executeSelections(typeName, value, frag.selections, variables, doc, ctx, state);
      if (sub) Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'fragment') {
      if (sel.type !== null && sel.type !== typeName) continue;
      const sub = executeSelections(typeName, value, sel.selections, variables, doc, ctx, state);
      if (sub) Object.assign(out, sub);
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    const known = TYPE_FIELDS[typeName] ?? [];
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!known.includes(field.name)) {
      state.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    out[key] = resolveField(typeName, value, field, variables, doc, ctx, state);
  }
  return out;
}

function resolveField(
  typeName: string,
  value: AnyObj,
  field: FieldNode,
  variables: Record<string, unknown>,
  doc: Document,
  ctx: GqlContext,
  state: ExecState,
): unknown {
  const name = field.name;
  const sub = (v: AnyObj | null, t: string): unknown => executeSelections(t, v, field.selections, variables, doc, ctx, state);

  if (typeName === 'Query') {
    if (name === 'viewer') return sub({ __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, 'User');
    if (name === 'repository') {
      const owner = String(argValue(field, 'owner', variables) ?? '');
      const repoName = String(argValue(field, 'name', variables) ?? '');
      const repo = owner === VIEWER_LOGIN ? ctx.store.getRepo(owner, repoName) : undefined;
      if (!repo) return null;
      return sub(repoNode(repo), 'Repository');
    }
    if (name === 'node') {
      const id = String(argValue(field, 'id', variables) ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoByGlobalId(ctx, id);
        if (!repo) return null;
        return sub(repoNode(repo), 'Repository');
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueByGlobalId(ctx, id);
        if (!found) return null;
        return sub(issueNode(found.repo, found.issue), 'Issue');
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPullByGlobalId(ctx, id);
        if (!found) return null;
        return sub(pullNode(found.repo, found.pr), 'PullRequest');
      }
      return null;
    }
    if (name === '__type') {
      const typeNameArg = String(argValue(field, 'name', variables) ?? '');
      return sub(introspectionType(typeNameArg), '__Type');
    }
    if (name === '__schema') {
      return sub({ __type: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } }, '__Schema');
    }
  }

  if (typeName === 'Repository') {
    const repo = value._repo as Repo;
    if (name === 'issue') {
      const number = Number(argValue(field, 'number', variables));
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return null;
      return sub(issueNode(repo, issue), 'Issue');
    }
    if (name === 'issues') {
      const first = argValue(field, 'first', variables) as number | undefined;
      const after = argValue(field, 'after', variables) as string | null | undefined;
      const states = argValue(field, 'states', variables) as string[] | undefined;
      const orderBy = argValue(field, 'orderBy', variables) as { field?: string; direction?: string } | undefined;
      let list = [...repo.issues];
      if (states && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const direction = orderBy?.direction === 'ASC' ? 1 : -1;
      // CREATED_AT order with ties broken by number; seq is the creation order.
      list.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
      if (after !== undefined && after !== null && after !== '') {
        const cursorNum = decodeCursor(String(after));
        if (cursorNum !== null) {
          list = direction === -1 ? list.filter((i) => i.number < cursorNum) : list.filter((i) => i.number > cursorNum);
        }
      }
      const page = first !== undefined ? list.slice(0, first) : list;
      const hasNextPage = first !== undefined && list.length > first;
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
      return sub(
        {
          __type: 'IssueConnection',
          nodes: page.map((i) => issueNode(repo, i)),
          pageInfo: { __type: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor(page[0].number) : null },
          totalCount: list.length,
        },
        'IssueConnection',
      );
    }
    if (name === 'pullRequests') {
      const first = argValue(field, 'first', variables) as number | undefined;
      const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
      const page = first !== undefined ? list.slice(0, first) : list;
      return sub(
        {
          __type: 'PullRequestConnection',
          nodes: page.map((p) => pullNode(repo, p)),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
          totalCount: list.length,
        },
        'PullRequestConnection',
      );
    }
    if (name === 'pullRequest') {
      const number = Number(argValue(field, 'number', variables));
      const pr = repo.pulls.find((p) => p.number === number);
      if (!pr) return null;
      return sub(pullNode(repo, pr), 'PullRequest');
    }
    if (name === 'owner') return sub(value.owner as AnyObj, 'User');
    if (name === 'defaultBranchRef') return sub(value.defaultBranchRef as AnyObj, 'Ref');
    return value[name] ?? null;
  }

  if (typeName === 'IssueConnection') {
    if (name === 'nodes') {
      const nodes = value.nodes as AnyObj[];
      return nodes.map((n) => executeSelections('Issue', n, field.selections, variables, doc, ctx, state));
    }
    if (name === 'pageInfo') return sub(value.pageInfo as AnyObj, 'PageInfo');
    return value[name] ?? null;
  }

  if (typeName === 'PullRequestConnection') {
    if (name === 'nodes') {
      const nodes = value.nodes as AnyObj[];
      return nodes.map((n) => executeSelections('PullRequest', n, field.selections, variables, doc, ctx, state));
    }
    if (name === 'pageInfo') return sub(value.pageInfo as AnyObj, 'PageInfo');
    return value[name] ?? null;
  }

  if (typeName === 'PullRequest') {
    const pr = value._pr as PullRequest;
    const repo = value._repo as Repo;
    if (name === 'files') {
      const first = argValue(field, 'first', variables) as number | undefined;
      const baseCommit = getObject(repo, pr.baseSha);
      const headCommit = getObject(repo, pr.headSha);
      if (!baseCommit || !headCommit) return sub({ __type: 'PullRequestChangedFileConnection', nodes: [], pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null } }, 'PullRequestChangedFileConnection');
      const files = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
      const page = first !== undefined ? files.slice(0, first) : files;
      return sub(
        {
          __type: 'PullRequestChangedFileConnection',
          nodes: page.map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes })),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
          totalCount: files.length,
        },
        'PullRequestChangedFileConnection',
      );
    }
    return value[name] ?? null;
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      const nodes = value.nodes as AnyObj[];
      return nodes.map((n) => executeSelections('PullRequestChangedFile', n, field.selections, variables, doc, ctx, state));
    }
    if (name === 'pageInfo') return sub(value.pageInfo as AnyObj, 'PageInfo');
    return value[name] ?? null;
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') {
      const input = argValue(field, 'input', variables) as { repositoryId?: string; title?: string; body?: string };
      const repo = findRepoByGlobalId(ctx, String(input?.repositoryId ?? ''));
      if (!repo) {
        state.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        return sub(null, 'CreateIssuePayload');
      }
      repo.issueCounter += 1;
      const seq = ctx.store.nextSeq();
      const issue: Issue = {
        number: repo.issueCounter,
        title: String(input?.title ?? ''),
        body: String(input?.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        seq,
        globalId: globalId('Issue', repo.databaseId, repo.issueCounter),
      };
      repo.issues.push(issue);
      return sub({ __type: 'CreateIssuePayload', issue: issueNode(repo, issue) }, 'CreateIssuePayload');
    }
    if (name === 'closeIssue') {
      const input = argValue(field, 'input', variables) as { issueId?: string };
      const found = findIssueByGlobalId(ctx, String(input?.issueId ?? ''));
      if (!found) {
        state.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return sub(null, 'CloseIssuePayload');
      }
      found.issue.state = 'closed';
      return sub({ __type: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) }, 'CloseIssuePayload');
    }
    if (name === 'createPullRequest') {
      const input = argValue(field, 'input', variables) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
      const repo = findRepoByGlobalId(ctx, String(input?.repositoryId ?? ''));
      if (!repo) {
        state.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        return sub(null, 'CreatePullRequestPayload');
      }
      const headSha = repo.refs.get(`refs/heads/${input?.headRefName ?? ''}`);
      const baseSha = repo.refs.get(`refs/heads/${input?.baseRefName ?? ''}`);
      if (headSha === undefined || baseSha === undefined) {
        state.errors.push({ message: 'Head or base ref does not exist.' });
        return sub(null, 'CreatePullRequestPayload');
      }
      repo.pullCounter += 1;
      const seq = ctx.store.nextSeq();
      const pr: PullRequest = {
        number: repo.pullCounter,
        title: String(input?.title ?? ''),
        body: String(input?.body ?? ''),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: String(input?.headRefName ?? ''),
        baseRef: String(input?.baseRefName ?? ''),
        headSha,
        baseSha,
        seq,
        globalId: globalId('PullRequest', repo.databaseId, repo.pullCounter),
      };
      repo.pulls.push(pr);
      return sub({ __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pr) }, 'CreatePullRequestPayload');
    }
    if (name === 'mergePullRequest') {
      const input = argValue(field, 'input', variables) as { pullRequestId?: string; mergeMethod?: string };
      const found = findPullByGlobalId(ctx, String(input?.pullRequestId ?? ''));
      if (!found) {
        state.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
        return sub(null, 'MergePullRequestPayload');
      }
      if (found.pr.merged || found.pr.state !== 'open') {
        state.errors.push({ message: 'Pull request is already merged or closed.' });
        return sub({ __type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pr) }, 'MergePullRequestPayload');
      }
      const sha = squashMerge(found.repo, found.pr);
      if (sha === null) {
        state.errors.push({ message: 'Merge conflict: the pull request cannot be merged cleanly.' });
        return sub({ __type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pr) }, 'MergePullRequestPayload');
      }
      return sub({ __type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pr) }, 'MergePullRequestPayload');
    }
    if (name === 'addComment') {
      const input = argValue(field, 'input', variables) as { subjectId?: string; body?: string };
      const found = findIssueByGlobalId(ctx, String(input?.subjectId ?? ''));
      if (!found) {
        state.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return sub(null, 'AddCommentPayload');
      }
      found.repo.commentCounter += 1;
      const comment = {
        id: found.repo.commentCounter,
        body: String(input?.body ?? ''),
        globalId: globalId('IssueComment', found.repo.databaseId, found.issue.number, found.repo.commentCounter),
      };
      found.issue.comments.push(comment);
      return sub(
        {
          __type: 'AddCommentPayload',
          commentEdge: {
            __type: 'IssueCommentEdge',
            node: { __type: 'IssueComment', id: comment.globalId, body: comment.body },
            cursor: encodeCursor(comment.id),
          },
        },
        'AddCommentPayload',
      );
    }
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (name === 'issue') return sub(value.issue as AnyObj, 'Issue');
    return value[name] ?? null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return sub(value.pullRequest as AnyObj, 'PullRequest');
    return value[name] ?? null;
  }
  if (typeName === 'AddCommentPayload') {
    if (name === 'commentEdge') return sub(value.commentEdge as AnyObj, 'IssueCommentEdge');
    return value[name] ?? null;
  }
  if (typeName === 'IssueCommentEdge') {
    if (name === 'node') return sub(value.node as AnyObj, 'IssueComment');
    return value[name] ?? null;
  }
  if (typeName === '__Type') {
    if (name === 'fields') {
      const fields = (value._fields as string[]).map((f) => ({ __type: '__Field', name: f }));
      return fields.map((f) => executeSelections('__Field', f, field.selections, variables, doc, ctx, state));
    }
    if (name === 'enumValues') {
      const vals = (value._enumValues as string[]).map((v) => ({ __type: '__EnumValue', name: v }));
      return vals.map((v) => executeSelections('__EnumValue', v, field.selections, variables, doc, ctx, state));
    }
    return value[name] ?? null;
  }

  // Leaf types (User, Ref, PageInfo, Issue, IssueComment, PullRequestChangedFile, __Field, __EnumValue)
  return value[name] ?? null;
}

function introspectionType(name: string): AnyObj {
  const fields = TYPE_FIELDS[name] ?? [];
  const enumValues = TYPE_ENUM_VALUES[name] ?? [];
  return { __type: '__Type', name, kind: fields.length > 0 ? 'OBJECT' : enumValues.length > 0 ? 'ENUM' : 'OBJECT', _fields: fields, _enumValues: enumValues };
}

function executeOperation(op: Operation, variables: Record<string, unknown>, doc: Document, ctx: GqlContext): { data: AnyObj | null; errors?: Array<{ message: string }> } {
  const state: ExecState = { errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, { __type: rootType }, op.selections, variables, doc, ctx, state);
  if (state.errors.length > 0) return { data: data ?? null, errors: state.errors };
  return { data: data ?? null };
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: GqlContext): Promise<boolean> {
  if (req.url === undefined) return false;
  const path = req.url.split('?')[0];
  if (path !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    errJson(res, 404, 'Not Found');
    return true;
  }
  const token = bearerToken(req);
  if (token === null || token !== ctx.token) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  let raw: Buffer | null = null;
  try {
    raw = await readBody(req);
  } catch {
    errJson(res, 400, 'Bad Request');
    return true;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    errJson(res, 400, 'Problems parsing JSON');
    return true;
  }
  const body = parsed.value;
  // Batched operations: a JSON array of {query, variables}.
  if (Array.isArray(body)) {
    const results: Array<{ data: AnyObj | null; errors?: Array<{ message: string }> }> = [];
    for (const item of body) {
      const q = (item as Record<string, unknown>)?.query;
      const vars = ((item as Record<string, unknown>)?.variables ?? {}) as Record<string, unknown>;
      if (typeof q !== 'string') {
        results.push({ data: null, errors: [{ message: 'Query is required.' }] });
        continue;
      }
      try {
        const doc = parseDocument(q);
        const op = doc.operations[0];
        if (!op) results.push({ data: null, errors: [{ message: 'No operation in document.' }] });
        else results.push(executeOperation(op, vars, doc, ctx));
      } catch (err) {
        results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error.' }] });
      }
    }
    sendJson(res, 200, results);
    return true;
  }
  const q = (body as Record<string, unknown>)?.query;
  const vars = ((body as Record<string, unknown>)?.variables ?? {}) as Record<string, unknown>;
  if (typeof q !== 'string') {
    sendJson(res, 200, { data: null, errors: [{ message: 'Query is required.' }] });
    return true;
  }
  try {
    const doc = parseDocument(q);
    const op = doc.operations[0];
    if (!op) {
      sendJson(res, 200, { data: null, errors: [{ message: 'No operation in document.' }] });
      return true;
    }
    sendJson(res, 200, executeOperation(op, vars, doc, ctx));
    return true;
  } catch (err) {
    sendJson(res, 200, { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error.' }] });
    return true;
  }
}
