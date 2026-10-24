import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isRecord, type Auth, type ClientHello, type HostHello, type Ready } from './protocol';

// Anyone who can reach the bridge endpoint (a Windows pipe gets a default ACL, a stale bridge.json
// may name an endpoint another program took over) must not be able to drive the browser or feed the
// MCP server fake results, so both sides prove they know the secret from bridge.json. Each proof
// binds both fresh nonces and its own label, so it cannot be replayed on another connection or
// reflected back as the other side's proof.
//
//   client -> host  {"type":"hello","nonce":clientNonce}
//   host -> client  {"type":"hello","nonce":serverNonce,"proof":hostProof}
//   client -> host  {"type":"auth","proof":clientProof}
//   host -> client  {"type":"ready"}

export const HANDSHAKE_TIMEOUT_MS = 2_000;
export const MAX_UNAUTHENTICATED_CONNECTIONS = 8;

const HEX64 = /^[0-9a-f]{64}$/;

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

export function createNonce(): string {
  return randomBytes(32).toString('hex');
}

function proof(label: 'host' | 'client', secret: string, clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(`${label}:${clientNonce}:${serverNonce}`, 'utf8').digest('hex');
}

export function hostProof(secret: string, clientNonce: string, serverNonce: string): string {
  return proof('host', secret, clientNonce, serverNonce);
}

export function clientProof(secret: string, clientNonce: string, serverNonce: string): string {
  return proof('client', secret, clientNonce, serverNonce);
}

export function verifyProof(expected: string, actual: unknown): boolean {
  if (!isHex64(expected) || !isHex64(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function parseClientHello(value: unknown): ClientHello | undefined {
  if (!isRecord(value) || value['type'] !== 'hello' || !isHex64(value['nonce'])) return undefined;
  return { type: 'hello', nonce: value['nonce'] };
}

export function parseHostHello(value: unknown): HostHello | undefined {
  if (!isRecord(value) || value['type'] !== 'hello') return undefined;
  const { nonce, proof: claimed } = value;
  if (!isHex64(nonce) || !isHex64(claimed)) return undefined;
  return { type: 'hello', nonce, proof: claimed };
}

export function parseAuth(value: unknown): Auth | undefined {
  if (!isRecord(value) || value['type'] !== 'auth' || !isHex64(value['proof'])) return undefined;
  return { type: 'auth', proof: value['proof'] };
}

export function parseReady(value: unknown): Ready | undefined {
  if (!isRecord(value) || value['type'] !== 'ready') return undefined;
  return { type: 'ready' };
}
