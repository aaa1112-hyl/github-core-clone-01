// Entry point for the github-core-clone-01 forge.
//
// The trial harness starts this program beside the suite and hands it
// MAKEFUN_ENV_URL. The lifecycle, per the kit's wire contract, is:
//
//   1. bind the forge on an ephemeral port (port 0; never 8080, where the
//      suite itself listens);
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register so the suite
//      knows where to dial us;
//   3. keep serving until GET $MAKEFUN_ENV_URL/done answers {"done": true},
//      then exit 0.
//
// The suite answers /done immediately (never held open), so step 3 is a
// poll loop with exponential backoff, 250 ms doubling to 2 s.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set; the forge needs the trial environment URL to register.');
  process.exit(1);
}
const envBase = envUrl.replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function register(port: number): Promise<void> {
  const started = Date.now();
  let delayMs = 250;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      if (Date.now() - started > 30_000) {
        throw new Error(`could not reach ${envBase}/register: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 2000);
      continue;
    }
    if (res.status === 200 || res.status === 409) {
      // 200: registered. 409: an earlier register already won; the base
      // URL is set either way, so there is nothing more to do here.
      return;
    }
    throw new Error(`register failed: ${res.status} ${await res.text()}`);
  }
}

async function waitUntilDone(): Promise<void> {
  let delayMs = 250;
  for (;;) {
    try {
      const res = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { done?: unknown };
      if (body.done === true) return;
    } catch {
      // A failed poll is transient (the suite may be restarting a phase);
      // fall through to the backoff and poll again.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2000);
  }
}

function shutDown(server: ReturnType<typeof createApp>): void {
  server.closeAllConnections?.();
  server.close(() => {
    process.exit(0);
  });
  // Never hang on a lingering keep-alive socket: the suite is done, so
  // force the exit if the close has not finished within a second.
  setTimeout(() => process.exit(0), 1000);
}

const server = createApp();
server.on('error', (err) => {
  console.error(`forge listener failed: ${err.message}`);
  process.exit(1);
});
process.on('SIGTERM', () => shutDown(server));
process.on('SIGINT', () => shutDown(server));

server.listen(0, '0.0.0.0', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`forge listening on port ${port}`);
  void (async () => {
    try {
      await register(port);
      await waitUntilDone();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }
    console.log('suite done; exiting');
    shutDown(server);
  })();
});
