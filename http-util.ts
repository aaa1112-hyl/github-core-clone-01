// Shared HTTP helpers for the forge's surfaces.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}

export function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://forge').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://forge').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body (cap 64 MiB). Returns null when there is no body. */
export async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024 * 1024) throw new Error('body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

export function parseJsonBody(raw: Buffer | null): { ok: true; value: unknown } | { ok: false } {
  if (raw === null || raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match ? match[1] : null;
}

export function decodeBase64Loose(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]/g, ''), 'base64');
}

export function encodeBase64(data: Buffer): string {
  return data.toString('base64');
}
