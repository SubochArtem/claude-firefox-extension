import { createConnection, type Socket } from 'node:net';
import type { BridgeInfo } from './bridge-info';
import { authenticateToHost } from './handshake';

const LOG = '[host-probe]';
export const HOST_PROBE_TIMEOUT_MS = 1_000;
// Handshake lines are tiny; whatever else listens on the endpoint must not make the probe buffer more.
const PROBE_MAX_LINE_BYTES = 4 * 1024;

// True only if the endpoint from bridge.json is served by a native host that knows its secret. A
// bare connect is not enough on Windows: another program may have taken over the pipe name. The
// probe runs the full client handshake, so it never sends its proof to a listener that has not
// proved the secret first, and it disconnects right after ready without sending a request.
export function isAuthenticatedHostAlive(info: BridgeInfo, timeoutMs = HOST_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: Socket | undefined;
    const finish = (alive: boolean): void => {
      clearTimeout(timer);
      socket?.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = createConnection(info.endpoint);
    } catch {
      finish(false);
      return;
    }
    const connected = socket;
    connected.on('error', () => finish(false));
    connected.once('connect', () => {
      authenticateToHost(connected, info.secret, { logPrefix: LOG, timeoutMs, maxLineBytes: () => PROBE_MAX_LINE_BYTES }).then(
        () => finish(true),
        () => finish(false),
      );
    });
  });
}
