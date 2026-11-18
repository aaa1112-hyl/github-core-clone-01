// GitHub REST v3 surface (/api/v3), per the conformance suite's contract.
// Extra response fields are always allowed by the checks; required fields are
// echoed exactly. All replies are JSON with X-GitHub-Request-Id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  blobAtPath,
  branchRef,
  commitFile,
  commitHistory,
  diffTrees,
  getObject,
  parseCommit,
  squashMerge,
  treeEntriesAt,
  VIEWER_LOGIN,
  VIEWER_ID,
  globalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import {
  decodeBase64Loose,
  encodeBase64,
  errJson,
  parseJsonBody,
  pathOf,
  queryOf,
  readBody,
  sendEmpty,
  sendJson,
  bearerToken,
} from './http-util.ts';

export interface RestContext {
  store: Store;
  token: string;
}

const SHA40 = /^[0-9a-f]{40}$/i;

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA40.test(value);
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: globalId('Repository', repo.databaseId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.seq * 100000 + repo.databaseId,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.seq * 100000 + repo.databaseId,
    node_id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  return {
    sha,
    commit: {
      // GitHub's API returns the message without the trailing newline the
      // raw commit object carries.
      message: view.message.replace(/\n$/, ''),
      author: { name: 'Forge', email: 'forge@localhost', date: '2025-01-01T00:00:00Z' },
      committer: { name: 'Forge', email: 'forge@localhost', date: '2025-01-01T00:00:00Z' },
      tree: { sha: view.tree },
    },
    parents: view.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

/** Resolve a repo by owner/name; 404 when the owner is not the viewer or the repo is missing. */
function lookupRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function linkHeader(base: string, page: number, perPage: number, total: number, query: URLSearchParams): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  const url = `${base}?${next.toString()}`;
  return `<${url}>; rel="next"`;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const segments = path.split('/').filter((s) => s !== '');

  // Public roots (no auth needed, matching api.github.com behaviour).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // Every other /api/v3 route requires the bearer token.
  const token = bearerToken(req);
  if (token === null || token !== ctx.token) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }

  // Body (for methods that carry one).
  let body: unknown = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
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
    body = parsed.value;
  }
  const b = (body ?? {}) as Record<string, unknown>;

  // GET /api/v3/user
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'Ada Iversen', email: 'adaiversen@example.invalid' });
    return true;
  }

  // /api/v3/user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const { page, perPage } = parsePage(query);
      const all = ctx.store.listRepos(VIEWER_LOGIN);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const origin = `http://${req.headers.host ?? 'localhost'}`;
      const link = linkHeader(`${origin}/api/v3/user/repos`, page, perPage, all.length, query);
      sendJson(res, 200, slice.map((r) => repoJson(r)), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') {
        errJson(res, 422, 'Validation Failed: name is required');
        return true;
      }
      const repo = ctx.store.createRepo(VIEWER_LOGIN, name, {
        private: b.private === true,
        description: typeof b.description === 'string' ? b.description : '',
      });
      if (repo === null) {
        errJson(res, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3]);
    const name = decodeURIComponent(segments[4]);
    const rest = segments.slice(5);
    const repo = lookupRepo(ctx, owner, name);

    // Repo itself: GET / PATCH / DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === null) return errJson(res, 404, 'Not Found'), true;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (repo === null) return errJson(res, 404, 'Not Found'), true;
        if (typeof b.description === 'string') repo.description = b.description;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (repo === null) return errJson(res, 404, 'Not Found'), true;
        ctx.store.deleteRepo(owner, name);
        sendEmpty(res, 204);
        return true;
      }
      return errJson(res, 404, 'Not Found'), true;
    }
    if (repo === null) return errJson(res, 404, 'Not Found'), true;

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const out: Array<Record<string, unknown>> = [];
        for (const [ref, sha] of repo.refs) {
          if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
        }
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        sendJson(res, 200, out);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1]);
        const sha = repo.refs.get(branchRef(branch));
        if (sha === undefined) return errJson(res, 404, 'Not Found'), true;
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return true;
      }
      return errJson(res, 404, 'Not Found'), true;
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !isSha(sha)) {
          errJson(res, 422, 'Validation Failed: ref and sha are required');
          return true;
        }
        if (getObject(repo, sha) === undefined && sha !== '0'.repeat(40)) {
          errJson(res, 422, 'Validation Failed: sha does not exist');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
        return true;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
        const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const sha = repo.refs.get(fullRef);
        if (sha === undefined) return errJson(res, 404, 'Not Found'), true;
        sendJson(res, 200, { ref: fullRef, object: { sha, type: 'commit' } });
        return true;
      }
      return errJson(res, 404, 'Not Found'), true;
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        if (isSha(shaParam)) tip = shaParam;
        else tip = repo.refs.get(branchRef(shaParam)) ?? repo.refs.get(shaParam);
      } else {
        tip = repo.refs.get(branchRef(repo.defaultBranch));
      }
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const history = commitHistory(repo, tip);
      sendJson(res, 200, history.map((sha) => commitJson(repo, sha)).filter(Boolean));
      return true;
    }

    // contents
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = query.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      const tip = repo.refs.get(branchRef(branch)) ?? (isSha(branch) ? branch : undefined);
      if (method === 'GET') {
        if (tip === undefined) return errJson(res, 404, 'Not Found'), true;
        const commit = parseCommit(getObject(repo, tip)!.data);
        const segments = contentPath === '' ? [] : contentPath.split('/');
        if (segments.length === 0) {
          const entries = treeEntriesAt(repo, commit.tree, []);
          if (entries === null) return errJson(res, 404, 'Not Found'), true;
          sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid, size: 0 })));
          return true;
        }
        const parentEntries = treeEntriesAt(repo, commit.tree, segments.slice(0, -1));
        if (parentEntries === null) return errJson(res, 404, 'Not Found'), true;
        const leaf = parentEntries.find((e) => e.name === segments[segments.length - 1]);
        if (!leaf) return errJson(res, 404, 'Not Found'), true;
        if (leaf.mode !== '40000') {
          const blob = getObject(repo, leaf.oid)!;
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: leaf.name,
            path: contentPath,
            content: encodeBase64(blob.data),
            sha: leaf.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
          });
          return true;
        }
        const entries = treeEntriesAt(repo, commit.tree, segments);
        if (entries === null) return errJson(res, 404, 'Not Found'), true;
        sendJson(
          res,
          200,
          entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: `${contentPath}/${e.name}`, sha: e.oid, size: 0 })),
        );
        return true;
      }
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : 'Update file';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const content = decodeBase64Loose(contentB64);
        const branchName = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const refName = branchRef(branchName);
        let tipOid = repo.refs.get(refName);
        if (tipOid === undefined && branchName !== repo.defaultBranch) {
          // Branch does not exist yet: start it from the default branch tip.
          tipOid = repo.refs.get(branchRef(repo.defaultBranch));
          if (tipOid !== undefined) repo.refs.set(refName, tipOid);
        }
        const existingBlob = tipOid === undefined ? null : blobAtPath(repo, parseCommit(getObject(repo, tipOid)!.data).tree, contentPath);
        const isUpdate = existingBlob !== null;
        if (typeof b.sha === 'string' && b.sha !== '') {
          if (existingBlob === null || b.sha.toLowerCase() !== existingBlob.toLowerCase()) {
            errJson(res, 409, 'Conflict: sha does not match the current blob');
            return true;
          }
        }
        // Create the branch ref if this is the first commit on a new branch.
        if (tipOid === undefined && branchName !== repo.defaultBranch) {
          // unborn repo + new branch: commitFile creates it below
        }
        const { commitOid, blobOid } = commitFile(repo, branchName, contentPath, content, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitOid, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const sha = typeof b.sha === 'string' ? b.sha : '';
        const tipOid = repo.refs.get(branchRef(repo.defaultBranch));
        if (tipOid === undefined) return errJson(res, 404, 'Not Found'), true;
        const existingBlob = blobAtPath(repo, parseCommit(getObject(repo, tipOid)!.data).tree, contentPath);
        if (existingBlob === null) return errJson(res, 404, 'Not Found'), true;
        if (sha !== '' && sha.toLowerCase() !== existingBlob.toLowerCase()) {
          errJson(res, 409, 'Conflict: sha does not match the current blob');
          return true;
        }
        const message = typeof b.message === 'string' ? b.message : 'Delete file';
        const { commitOid } = commitFile(repo, repo.defaultBranch, contentPath, null, message);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return true;
      }
      return errJson(res, 404, 'Not Found'), true;
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const name = typeof b.name === 'string' ? b.name : '';
        if (name === '') {
          errJson(res, 422, 'Validation Failed: name is required');
          return true;
        }
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color });
        return true;
      }
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
        return true;
      }
      return errJson(res, 404, 'Not Found'), true;
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const rawLabels = Array.isArray(b.labels) ? b.labels : [];
          const labelNames: string[] = [];
          for (const l of rawLabels) {
            const name = typeof l === 'string' ? l : (l as Record<string, unknown>)?.name;
            if (typeof name === 'string') labelNames.push(name);
          }
          for (const name of labelNames) {
            if (!repo.labels.has(name)) {
              errJson(res, 422, `Validation Failed: label "${name}" does not exist`);
              return true;
            }
          }
          repo.issueCounter += 1;
          const seq = ctx.store.nextSeq();
          const issue: Issue = {
            number: repo.issueCounter,
            title,
            body: bodyText,
            state: 'open',
            labels: labelNames,
            comments: [],
            seq,
            globalId: globalId('Issue', repo.databaseId, repo.issueCounter),
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
          if (sort === 'created') {
            list = [...list].sort((a, c2) => (direction === 'asc' ? a.seq - c2.seq : c2.seq - a.seq));
          }
          const { page, perPage } = parsePage(query);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          sendJson(res, 200, slice.map((i) => issueJson(repo, i)));
          return true;
        }
      }
      const num = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(num)) {
        const issue = repo.issues.find((i) => i.number === num);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (!issue) return errJson(res, 404, 'Not Found'), true;
            sendJson(res, 200, issueJson(repo, issue));
            return true;
          }
          if (method === 'PATCH') {
            if (!issue) return errJson(res, 404, 'Not Found'), true;
            if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
            if (typeof b.title === 'string') issue.title = b.title;
            if (typeof b.body === 'string') issue.body = b.body;
            sendJson(res, 200, issueJson(repo, issue));
            return true;
          }
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (!issue) return errJson(res, 404, 'Not Found'), true;
          if (method === 'POST') {
            const bodyText = typeof b.body === 'string' ? b.body : '';
            repo.commentCounter += 1;
            const comment = { id: repo.commentCounter, body: bodyText, globalId: globalId('IssueComment', repo.databaseId, issue.number, repo.commentCounter) };
            issue.comments.push(comment);
            sendJson(res, 201, { id: comment.id, node_id: comment.globalId, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: c.globalId, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })));
            return true;
          }
        }
      }
      return errJson(res, 404, 'Not Found'), true;
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const headSha = repo.refs.get(branchRef(head));
          const baseSha = repo.refs.get(branchRef(base));
          if (headSha === undefined || baseSha === undefined) {
            errJson(res, 422, 'Validation Failed: head or base branch does not exist');
            return true;
          }
          repo.pullCounter += 1;
          const seq = ctx.store.nextSeq();
          const pr: PullRequest = {
            number: repo.pullCounter,
            title,
            body: bodyText,
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            seq,
            globalId: globalId('PullRequest', repo.databaseId, repo.pullCounter),
          };
          repo.pulls.push(pr);
          sendJson(res, 201, pullJson(repo, pr));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
          const { page, perPage } = parsePage(query);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          sendJson(res, 200, slice.map((p) => pullJson(repo, p)));
          return true;
        }
      }
      const num = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(num)) {
        const pr = repo.pulls.find((p) => p.number === num);
        if (rest.length === 2 && method === 'GET') {
          if (!pr) return errJson(res, 404, 'Not Found'), true;
          sendJson(res, 200, pullJson(repo, pr));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          if (!pr) return errJson(res, 404, 'Not Found'), true;
          const baseCommit = getObject(repo, pr.baseSha);
          const headCommit = getObject(repo, pr.headSha);
          if (!baseCommit || !headCommit) return errJson(res, 404, 'Not Found'), true;
          const files = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
          sendJson(res, 200, files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (!pr) return errJson(res, 404, 'Not Found'), true;
          if (pr.merged || pr.state !== 'open') {
            errJson(res, 405, 'Pull request is already merged or closed');
            return true;
          }
          const squashOid = squashMerge(repo, pr);
          if (squashOid === null) {
            errJson(res, 405, 'Merge conflict: the pull request cannot be merged cleanly');
            return true;
          }
          sendJson(res, 200, { sha: squashOid, merged: true, message: 'Pull request successfully merged' });
          return true;
        }
      }
      return errJson(res, 404, 'Not Found'), true;
    }
  }

  // No route matched under /api/v3.
  errJson(res, 404, 'Not Found');
  return true;
}
