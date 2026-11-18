// Model Context Protocol (/mcp): JSON-RPC 2.0 over Streamable HTTP, modern era
// (revision 2026-07-28 via server/discover). Six tools acting on the same store
// as REST. tools/list is byte-identical across calls.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  globalId,
  squashMerge,
  type Store,
} from './store.ts';
import { bearerToken, errJson, parseJsonBody, readBody, sendJson } from './http-util.ts';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'The repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListPayload(): unknown {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, required: t.required },
    })),
  };
}

const TOOL_ALIASES: Record<string, string> = {
  createrepository: 'create_repo',
  repocreate: 'create_repo',
  reposcreate: 'create_repo',
  repositorycreate: 'create_repo',
  getrepository: 'get_repo',
  repoget: 'get_repo',
  reposget: 'get_repo',
  repositoryget: 'get_repo',
  issuecreate: 'create_issue',
  issuescreate: 'create_issue',
  issueslist: 'list_issues',
  issuelist: 'list_issues',
  pullrequestcreate: 'create_pull_request',
  pullscreate: 'create_pull_request',
  createpr: 'create_pull_request',
  prcreate: 'create_pull_request',
  pullrequestmerge: 'merge_pull_request',
  pullsmerge: 'merge_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | null {
  const norm = normalizeName(name);
  const canonical = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
  for (const c of canonical) if (norm === normalizeName(c)) return TOOLS.find((t) => t.name === c) ?? null;
  const aliased = TOOL_ALIASES[norm];
  if (aliased) return TOOLS.find((t) => t.name === aliased) ?? null;
  for (const c of canonical) {
    if (norm.endsWith(normalizeName(c)) && norm.length > normalizeName(c).length) {
      return TOOLS.find((t) => t.name === c) ?? null;
    }
  }
  return null;
}

const ARG_SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'ownerlogin', 'org', 'organization', 'organisation', 'user', 'userlogin', 'login', 'account', 'namespace', 'ownername'],
  repo: ['repo', 'repository', 'repositoryname', 'reponame', 'reposlug', 'project', 'projectname'],
  title: ['title', 'issuetitle', 'prtitle', 'pullrequesttitle', 'subject'],
  body: ['body', 'issuebody', 'description', 'content', 'text', 'comment'],
  head: ['head', 'headref', 'headbranch', 'pullrequesthead', 'prhead', 'source', 'sourceref', 'sourcebranch', 'from', 'frombranch', 'branch'],
  base: ['base', 'baseref', 'basebranch', 'pullrequestbase', 'prbase', 'target', 'targetref', 'targetbranch', 'into', 'intobranch'],
  pull_number: ['pullnumber', 'pullrequestnumber', 'prnumber', 'number', 'issuenumber', 'index'],
  name: ['name', 'repo', 'repository', 'repositoryname', 'reponame'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'isprivate'],
  state: ['state', 'status'],
};

function pickArg(args: Record<string, unknown>, semantic: string): unknown {
  const synonyms = ARG_SYNONYMS[semantic] ?? [semantic];
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) byNorm.set(normalizeName(k), v);
  for (const syn of synonyms) {
    const v = byNorm.get(syn);
    if (v !== undefined) return v;
  }
  return undefined;
}

function splitFullName(args: Record<string, unknown>): { owner?: string; repo?: string } {
  for (const key of ['fullname', 'repofullname', 'repositoryfullname', 'fullName']) {
    const v = (args as Record<string, unknown>)[key] ?? args[normalizeName(key)];
    if (typeof v === 'string' && v.includes('/')) {
      const [owner, repo] = v.split('/');
      return { owner, repo };
    }
  }
  return {};
}

interface McpContext {
  store: Store;
  token: string;
}

type ToolResult =
  | { ok: true; text: string; structured?: unknown }
  | { ok: false; message: string };

function callTool(ctx: McpContext, tool: ToolDef, args: Record<string, unknown>): ToolResult {
  // Missing required argument -> failure (the suite accepts -32602 or isError:true).
  for (const req of tool.required) {
    if (pickArg(args, req) === undefined) {
      // full_name can supply owner+repo
      if ((req === 'owner' || req === 'repo') && splitFullName(args).owner !== undefined) continue;
      return { ok: false, message: `Missing required argument: ${req}` };
    }
  }
  const owner = (pickArg(args, 'owner') as string | undefined) ?? splitFullName(args).owner ?? VIEWER_LOGIN;
  const repoName = (pickArg(args, 'repo') as string | undefined) ?? splitFullName(args).repo;
  const store = ctx.store;

  if (tool.name === 'create_repo') {
    const name = String(pickArg(args, 'name') ?? '');
    const description = typeof pickArg(args, 'description') === 'string' ? (pickArg(args, 'description') as string) : '';
    const isPrivate = pickArg(args, 'private') === true;
    let repo = store.getRepo(VIEWER_LOGIN, name);
    if (!repo) {
      repo = store.createRepo(VIEWER_LOGIN, name, { private: isPrivate, description });
      if (!repo) return { ok: false, message: `Repository ${name} already exists` };
    }
    const payload = {
      id: repo.databaseId,
      node_id: globalId('Repository', repo.databaseId),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: repo.owner,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    };
    return { ok: true, text: JSON.stringify(payload), structured: payload };
  }

  if (repoName === undefined) return { ok: false, message: 'Missing required argument: repo' };
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} not found` };

  if (tool.name === 'get_repo') {
    const payload = {
      id: repo.databaseId,
      node_id: globalId('Repository', repo.databaseId),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: repo.owner,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    };
    return { ok: true, text: JSON.stringify(payload), structured: payload };
  }

  if (tool.name === 'create_issue') {
    const title = String(pickArg(args, 'title') ?? '');
    const bodyText = typeof pickArg(args, 'body') === 'string' ? (pickArg(args, 'body') as string) : '';
    repo.issueCounter += 1;
    const seq = store.nextSeq();
    const issue = {
      number: repo.issueCounter,
      title,
      body: bodyText,
      state: 'open' as const,
      labels: [] as string[],
      comments: [] as never[],
      seq,
      globalId: globalId('Issue', repo.databaseId, repo.issueCounter),
    };
    repo.issues.push(issue);
    const payload = {
      id: seq * 100000 + repo.databaseId,
      node_id: issue.globalId,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      full_name: `${repo.owner}/${repo.name}`,
    };
    return { ok: true, text: JSON.stringify(payload), structured: payload };
  }

  if (tool.name === 'list_issues') {
    const state = typeof pickArg(args, 'state') === 'string' ? String(pickArg(args, 'state')).toLowerCase() : 'open';
    const list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
    const payload = list.map((i) => ({ id: i.seq * 100000 + repo.databaseId, number: i.number, title: i.title, body: i.body, state: i.state }));
    return { ok: true, text: JSON.stringify(payload), structured: payload };
  }

  if (tool.name === 'create_pull_request') {
    const title = String(pickArg(args, 'title') ?? '');
    const bodyText = typeof pickArg(args, 'body') === 'string' ? (pickArg(args, 'body') as string) : '';
    const head = String(pickArg(args, 'head') ?? '');
    const base = String(pickArg(args, 'base') ?? repo.defaultBranch);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return { ok: false, message: 'Head or base branch does not exist' };
    repo.pullCounter += 1;
    const seq = store.nextSeq();
    const pr = {
      number: repo.pullCounter,
      title,
      body: bodyText,
      state: 'open' as const,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq,
      globalId: globalId('PullRequest', repo.databaseId, repo.pullCounter),
    };
    repo.pulls.push(pr);
    const payload = {
      id: seq * 100000 + repo.databaseId,
      node_id: pr.globalId,
      number: pr.number,
      pull_number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      full_name: `${repo.owner}/${repo.name}`,
    };
    return { ok: true, text: JSON.stringify(payload), structured: payload };
  }

  if (tool.name === 'merge_pull_request') {
    const num = Number(pickArg(args, 'pull_number'));
    const pr = repo.pulls.find((p) => p.number === num);
    if (!pr) return { ok: false, message: `Pull request ${num} not found` };
    if (pr.merged || pr.state !== 'open') return { ok: false, message: 'Pull request is already merged or closed' };
    const sha = squashMerge(repo, pr);
    if (sha === null) return { ok: false, message: 'Merge conflict: the pull request cannot be merged cleanly' };
    const payload = { number: pr.number, pull_number: pr.number, merged: true, sha, state: pr.state };
    return { ok: true, text: JSON.stringify(payload), structured: payload };
  }

  return { ok: false, message: `Unknown tool ${tool.name}` };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: McpContext): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/mcp') return false;
  const method = req.method ?? 'GET';

  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return true;
  }
  if (method !== 'POST') {
    errJson(res, 405, 'Method Not Allowed');
    return true;
  }

  // Auth is checked per request, before anything else (except the parse check below
  // needs the body; auth first matches the suite: a call without Authorization is 401).
  const token = bearerToken(req);
  if (token === null || token !== ctx.token) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }

  let raw: Buffer | null = null;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    // Modern era: HTTP 400 + JSON-RPC -32700. Recover the id if it is legible.
    let recoveredId: unknown = null;
    const text = raw?.toString('utf8') ?? '';
    const match = /"id"\s*:\s*(\d+|"(?:[^"\\]|\\.)*")/.exec(text);
    if (match) {
      try {
        recoveredId = JSON.parse(match[1]);
      } catch {
        recoveredId = null;
      }
    }
    sendJson(res, 400, rpcError(recoveredId, -32700, 'Parse error'));
    return true;
  }
  const body = parsed.value as Record<string, unknown> | Array<Record<string, unknown>>;

  const handleOne = (msg: Record<string, unknown>): Record<string, unknown> | null => {
    const id = (msg.id ?? null) as unknown;
    const rpcMethod = typeof msg.method === 'string' ? msg.method : '';
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (rpcMethod === 'server/discover') {
      const serverInfo = { name: 'forge', version: '1.0.0' };
      return rpcResult(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    if (rpcMethod === 'initialize') {
      return rpcResult(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    }
    if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
      return null; // notification: no response body
    }
    if (rpcMethod === 'ping') {
      return rpcResult(id, {});
    }
    if (rpcMethod === 'tools/list') {
      return rpcResult(id, toolsListPayload());
    }
    if (rpcMethod === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = findTool(name);
      if (!tool) return rpcError(id, -32601, `Method not found: ${name}`);
      const result = callTool(ctx, tool, args);
      if (!result.ok) return rpcError(id, -32602, result.message);
      const out: Record<string, unknown> = {
        content: [{ type: 'text', text: result.text }],
      };
      if (result.structured !== undefined) out.structuredContent = result.structured;
      return rpcResult(id, out);
    }
    return rpcError(id, -32601, `Method not found: ${rpcMethod}`);
  };

  if (Array.isArray(body)) {
    const results = body.map(handleOne).filter((r): r is Record<string, unknown> => r !== null);
    sendJson(res, 200, results);
    return true;
  }
  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  const out = handleOne(body);
  if (out === null) {
    // Notification: 202 with no body.
    res.writeHead(202, { 'x-github-request-id': 'req-mcp' });
    res.end();
    return true;
  }
  sendJson(res, 200, out);
  return true;
}
