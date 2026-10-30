import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  clientProof,
  createNonce,
  HANDSHAKE_TIMEOUT_MS,
  hostProof,
  MAX_UNAUTHENTICATED_CONNECTIONS,
  parseAuth,
  parseClientHello,
  parseHostHello,
  parseReady,
  verifyProof,
} from '../handshake';

// Spec of the bridge handshake. The secret is 32 random bytes written as 64 lowercase hex chars in
// bridge.json; the HMAC key is those 32 bytes (hex-decoded), not the hex text. The HMAC input is the
// UTF-8 encoding of `${label}:${clientNonce}:${serverNonce}` with label 'host' or 'client', and
// proofs travel as 64 lowercase hex chars:
//   client -> host  {"type":"hello","nonce":clientNonce}
//   host -> client  {"type":"hello","nonce":serverNonce,"proof":hostProof}
//   client -> host  {"type":"auth","proof":clientProof}
//   host -> client  {"type":"ready"}
const SECRET = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const CLIENT_NONCE = '11'.repeat(32);
const SERVER_NONCE = '22'.repeat(32);
const HOST_PROOF = 'e182d79c9ab126579ef512b3d934fc7e74de800ed238cf18c0ec5775a1f2694a';
const CLIENT_PROOF = 'e42cdd381586d13cdcc7b69da3d92331e2e626ede5354987fd5d84cb73eec46b';
const HEX64 = /^[0-9a-f]{64}$/;

function reference(label: string, secret: string, clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${label}:${clientNonce}:${serverNonce}`, 'utf8')
    .digest('hex');
}

describe('handshake limits', () => {
  it('times out unauthenticated connections after 2 s and allows 8 of them at a time', () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(2_000);
    expect(MAX_UNAUTHENTICATED_CONNECTIONS).toBe(8);
  });
});

describe('createNonce', () => {
  it('returns 64 lowercase hex chars', () => {
    expect(createNonce()).toMatch(HEX64);
  });

  it('returns a different value on every call', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => createNonce()));
    expect(nonces.size).toBe(20);
  });
});

describe('hostProof and clientProof', () => {
  it('match the known vectors', () => {
    expect(reference('host', SECRET, CLIENT_NONCE, SERVER_NONCE)).toBe(HOST_PROOF);
    expect(reference('client', SECRET, CLIENT_NONCE, SERVER_NONCE)).toBe(CLIENT_PROOF);
    expect(hostProof(SECRET, CLIENT_NONCE, SERVER_NONCE)).toBe(HOST_PROOF);
    expect(clientProof(SECRET, CLIENT_NONCE, SERVER_NONCE)).toBe(CLIENT_PROOF);
  });

  it('are deterministic and agree with the reference for random inputs', () => {
    const secret = createNonce();
    const clientNonce = createNonce();
    const serverNonce = createNonce();
    expect(hostProof(secret, clientNonce, serverNonce)).toBe(hostProof(secret, clientNonce, serverNonce));
    expect(hostProof(secret, clientNonce, serverNonce)).toBe(reference('host', secret, clientNonce, serverNonce));
    expect(clientProof(secret, clientNonce, serverNonce)).toBe(reference('client', secret, clientNonce, serverNonce));
  });

  it('return 64 lowercase hex chars', () => {
    expect(hostProof(SECRET, CLIENT_NONCE, SERVER_NONCE)).toMatch(HEX64);
    expect(clientProof(SECRET, CLIENT_NONCE, SERVER_NONCE)).toMatch(HEX64);
  });

  it('differ between host and client for the same inputs', () => {
    expect(hostProof(SECRET, CLIENT_NONCE, SERVER_NONCE)).not.toBe(clientProof(SECRET, CLIENT_NONCE, SERVER_NONCE));
  });

  it('depend on the nonce order', () => {
    expect(hostProof(SECRET, SERVER_NONCE, CLIENT_NONCE)).not.toBe(HOST_PROOF);
    expect(clientProof(SECRET, SERVER_NONCE, CLIENT_NONCE)).not.toBe(CLIENT_PROOF);
  });

  it('depend on the secret and on both nonces', () => {
    const otherSecret = 'ff'.repeat(32);
    expect(hostProof(otherSecret, CLIENT_NONCE, SERVER_NONCE)).not.toBe(HOST_PROOF);
    expect(hostProof(SECRET, '33'.repeat(32), SERVER_NONCE)).not.toBe(HOST_PROOF);
    expect(hostProof(SECRET, CLIENT_NONCE, '33'.repeat(32))).not.toBe(HOST_PROOF);
  });

  it('use the decoded secret bytes as the key, not the hex text', () => {
    const textKeyed = createHmac('sha256', SECRET).update(`host:${CLIENT_NONCE}:${SERVER_NONCE}`, 'utf8').digest('hex');
    expect(hostProof(SECRET, CLIENT_NONCE, SERVER_NONCE)).not.toBe(textKeyed);
  });
});

describe('verifyProof', () => {
  it('accepts the expected proof', () => {
    expect(verifyProof(HOST_PROOF, HOST_PROOF)).toBe(true);
  });

  it.each([
    ['another proof', CLIENT_PROOF],
    ['a proof with the last char changed', `${HOST_PROOF.slice(0, 63)}${HOST_PROOF.endsWith('a') ? 'b' : 'a'}`],
    ['an empty string', ''],
    ['a short proof', HOST_PROOF.slice(0, 62)],
    ['an odd-length proof', HOST_PROOF.slice(0, 63)],
    ['a long proof', `${HOST_PROOF}00`],
    ['non-hex chars of the right length', 'zz'.repeat(32)],
    ['the expected proof in uppercase hex', HOST_PROOF.toUpperCase()],
    ['the proof with trailing whitespace', `${HOST_PROOF} `],
    ['a number', 42],
    ['undefined', undefined],
    ['null', null],
    ['an object', { proof: HOST_PROOF }],
  ])('rejects %s without throwing', (_label, actual) => {
    expect(verifyProof(HOST_PROOF, actual)).toBe(false);
  });
});

describe('parseClientHello', () => {
  it('accepts a hello with a nonce and drops unknown fields', () => {
    expect(parseClientHello({ type: 'hello', nonce: CLIENT_NONCE, extra: 1 })).toEqual({ type: 'hello', nonce: CLIENT_NONCE });
  });

  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['an array', [{ type: 'hello', nonce: CLIENT_NONCE }]],
    ['another type', { type: 'auth', nonce: CLIENT_NONCE }],
    ['a missing nonce', { type: 'hello' }],
    ['a numeric nonce', { type: 'hello', nonce: 1 }],
    ['a short nonce', { type: 'hello', nonce: 'ab'.repeat(31) }],
    ['a long nonce', { type: 'hello', nonce: 'ab'.repeat(33) }],
    ['a non-hex nonce', { type: 'hello', nonce: 'zz'.repeat(32) }],
    ['an uppercase hex nonce', { type: 'hello', nonce: 'AB'.repeat(32) }],
  ])('rejects %s', (_label, value) => {
    expect(parseClientHello(value)).toBeUndefined();
  });
});

describe('parseHostHello', () => {
  it('accepts a hello with a nonce and a proof and drops unknown fields', () => {
    expect(parseHostHello({ type: 'hello', nonce: SERVER_NONCE, proof: HOST_PROOF, extra: 1 })).toEqual({
      type: 'hello',
      nonce: SERVER_NONCE,
      proof: HOST_PROOF,
    });
  });

  it.each([
    ['null', null],
    ['a hello without a proof', { type: 'hello', nonce: SERVER_NONCE }],
    ['a hello without a nonce', { type: 'hello', proof: HOST_PROOF }],
    ['a short proof', { type: 'hello', nonce: SERVER_NONCE, proof: HOST_PROOF.slice(2) }],
    ['a non-hex nonce', { type: 'hello', nonce: 'zz'.repeat(32), proof: HOST_PROOF }],
    ['an uppercase hex nonce', { type: 'hello', nonce: 'AB'.repeat(32), proof: HOST_PROOF }],
    ['an uppercase hex proof', { type: 'hello', nonce: SERVER_NONCE, proof: HOST_PROOF.toUpperCase() }],
    ['another type', { type: 'ready', nonce: SERVER_NONCE, proof: HOST_PROOF }],
  ])('rejects %s', (_label, value) => {
    expect(parseHostHello(value)).toBeUndefined();
  });
});

describe('parseAuth', () => {
  it('accepts an auth message with a proof and drops unknown fields', () => {
    expect(parseAuth({ type: 'auth', proof: CLIENT_PROOF, extra: 1 })).toEqual({ type: 'auth', proof: CLIENT_PROOF });
  });

  it.each([
    ['null', null],
    ['an array', [{ type: 'auth', proof: CLIENT_PROOF }]],
    ['another type', { type: 'hello', proof: CLIENT_PROOF }],
    ['a missing proof', { type: 'auth' }],
    ['a numeric proof', { type: 'auth', proof: 7 }],
    ['a short proof', { type: 'auth', proof: CLIENT_PROOF.slice(1) }],
    ['a non-hex proof', { type: 'auth', proof: 'g'.repeat(64) }],
    ['an uppercase hex proof', { type: 'auth', proof: CLIENT_PROOF.toUpperCase() }],
  ])('rejects %s', (_label, value) => {
    expect(parseAuth(value)).toBeUndefined();
  });
});

describe('parseReady', () => {
  it('accepts ready and drops unknown fields', () => {
    expect(parseReady({ type: 'ready', extra: 1 })).toEqual({ type: 'ready' });
  });

  it.each([
    ['null', null],
    ['a string', 'ready'],
    ['an array', [{ type: 'ready' }]],
    ['another type', { type: 'hello' }],
    ['a tool response', { type: 'tool_response', id: '1', result: { content: [] } }],
  ])('rejects %s', (_label, value) => {
    expect(parseReady(value)).toBeUndefined();
  });
});
