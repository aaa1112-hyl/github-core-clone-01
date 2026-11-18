# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aaa1112-hyl/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aaa1112-hyl/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, no dependencies: git smart HTTP (upload-pack v2 and v0, receive-pack with report-status), REST v3 (repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges), GraphQL v4 (the documents `gh` and `github-mcp-server` send) and MCP over streamable HTTP. Everything is in memory, deterministic (fixed commit identity and epoch, no wall clock or unseeded randomness in any response), and fast: it passes all 120 conformance checks and beats the house reference forge on every timed workload.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own; the flag is harmless there and makes an older local Node work too. There is nothing to install: the program imports `node:http` and its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The env records the address the request came from plus that port as your base URL and dials it from then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards, and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP checks again as the agent-native column, and four timed workloads. The version of the suite the trial runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Local results

Graded locally with the kit's own conformance suite, twice, same result both times:

- **Conformance: 120/120** — git 30/30, GraphQL 20/20, issues 15/15, MCP 15/15, protocol 5/5, pulls 20/20, repos 15/15.
- **Performance: 180/200 points** (median of 3 rounds) vs the house reference forge's ~100/200: push 660 ms (ref 1,641 ms), clone 98 ms (ref 267 ms), read 676 ms (ref 2,760 ms), write 110 ms (ref 349 ms). Estimated total ~980/1000 vs the reference's ~900/1000.

## Layout

- `main.ts`: the entry <-> env lifecycle. Kept as the starter ships it.
- `app.ts`: the server — routes `/healthz`, `/api/v3`, `/api/graphql`, `/mcp` and `/<owner>/<repo>.git` onto one in-memory store.
- `git.ts`: the git object model — SHA-1 ids, tree/commit parse/build, packfile read (OFS/REF deltas) and write (no deltas), pkt-line encode/decode.
- `githttp.ts`: git smart HTTP — v2/v0 advertisements, ls-refs, fetch with shallow/deepen/filter, receive-pack with per-ref report-status and fast-forward enforcement.
- `store.ts`: the in-memory store — repos, objects, refs, issues, PRs, labels, comments; the scenario-identity replication; merge, diff and history helpers.
- `rest.ts`: REST v3. `graphql.ts`: GraphQL v4 (parser + executor for the exact documents the suite sends). `mcp.ts`: MCP (modern era 2026-07-28). `http-util.ts`: shared HTTP helpers.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach. The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fhvxzr4c&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
