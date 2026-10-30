import { type ExtensionToHostMessage, NATIVE_HOST_NAME, parseHostMessage } from './protocol';
import { executeTool } from './tools';

const PONG_TIMEOUT_MS = 5_000;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
// A host that loses to an already running one may still connect and exit right away, so a pong alone
// does not reset the backoff; the connection has to stay up this long after its pong.
export const STABLE_CONNECTION_MS = 10_000;
export const RECONNECT_ALARM = 'reconnect-native-host';
// Firefox enforces no minimum alarm period; 0.5 min matches Chrome's floor and bounds how often a
// suspended event page is woken to retry.
const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;

let port: browser.runtime.Port | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let stableTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = INITIAL_RETRY_DELAY_MS;

export function connect(): void {
  if (port || retryTimer !== undefined) return;

  const current = browser.runtime.connectNative(NATIVE_HOST_NAME);
  port = current;
  current.onMessage.addListener((message) => handleMessage(current, message));
  current.onDisconnect.addListener(() => {
    // Firefox reports why a port closed on port.error, not on runtime.lastError as Chrome does.
    console.warn(`Native host disconnected: ${current.error?.message ?? 'no error reported'}`);
    handleLoss(current);
  });

  send(current, { type: 'ping' });
  pongTimer = setTimeout(() => {
    console.warn(`Native host did not answer ping within ${PONG_TIMEOUT_MS} ms`);
    // disconnect() does not fire onDisconnect on the calling side, so clean up here.
    current.disconnect();
    handleLoss(current);
  }, PONG_TIMEOUT_MS);
}

function handleMessage(source: browser.runtime.Port, message: unknown): void {
  if (source !== port) return;
  const parsed = parseHostMessage(message);
  if (!parsed) {
    console.warn('Ignoring unknown message from native host:', message);
    return;
  }
  if (parsed.type === 'pong') {
    // Only the first pong on a port starts the stability period; pongTimer is cleared by it.
    if (pongTimer !== undefined) {
      clearTimeout(pongTimer);
      pongTimer = undefined;
      stableTimer = setTimeout(() => {
        stableTimer = undefined;
        retryDelay = INITIAL_RETRY_DELAY_MS;
      }, STABLE_CONNECTION_MS);
    }
    void browser.alarms.clear(RECONNECT_ALARM);
    console.log('Connected to native host');
    return;
  }
  void executeTool(parsed).then((response) => {
    if (source === port) send(source, response);
  });
}

function handleLoss(lost: browser.runtime.Port): void {
  if (lost !== port) return;
  port = undefined;
  clearTimeout(pongTimer);
  pongTimer = undefined;
  clearTimeout(stableTimer);
  stableTimer = undefined;
  scheduleReconnect();
}

function scheduleReconnect(): void {
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
  console.log(`Reconnecting to native host in ${delay} ms`);
  // setTimeout does not survive the event page being suspended while the port is down; the alarm
  // wakes the page and retries until a connection succeeds.
  void browser.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES });
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, delay);
}

function send(target: browser.runtime.Port, message: ExtensionToHostMessage): void {
  target.postMessage(message);
}
