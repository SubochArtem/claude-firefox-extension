import { BIDI_INPUT_TIMEOUT_MS, type BidiInputRequest, type BidiInputResponse, type TabMarker } from '../protocol';
import type { InputSource } from './input-actions';
import { errorMessage } from './tab-access';
import { ToolError } from './tool-error';

export type HostFailure = { ok: false; error: string; unavailable?: true };

export type BidiInputResult = { ok: true } | HostFailure;

// The native host reported WebDriver BiDi itself as unusable; the message is the host's cause.
export class BidiUnavailableError extends ToolError {}

// Requests to the native host over one native port, matched to responses by requestId. Never rejects:
// a timeout, a closed port or a failed send settles the request with an error.
export interface HostRequestChannel<Input, Response, Result> {
  request(input: Input): Promise<Result | HostFailure>;
  handleResponse(response: Response): void;
  close(): void;
}

export interface HostRequestOptions<Input, Request, Response, Result> {
  // What the request carries, for the error messages: "input", "script".
  noun: string;
  timeoutMs: number;
  toRequest(requestId: string, input: Input): Request;
  toResult(response: Response): Result | HostFailure;
}

export function createHostRequestChannel<Input, Request, Response extends { requestId: string }, Result>(
  send: (message: Request) => void,
  options: HostRequestOptions<Input, Request, Response, Result>,
): HostRequestChannel<Input, Response, Result> {
  const pending = new Map<string, (result: Result | HostFailure) => void>();
  let closed = false;
  const { noun, timeoutMs } = options;

  return {
    request: (input) =>
      new Promise((resolve) => {
        if (closed) {
          resolve({ ok: false, error: 'The native host is not connected' });
          return;
        }
        const requestId = crypto.randomUUID();
        const finish = (result: Result | HostFailure) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(result);
        };
        const timer = setTimeout(
          () => finish({ ok: false, error: `The native host did not finish the ${noun} within ${timeoutMs / 1000} s` }),
          timeoutMs,
        );
        pending.set(requestId, finish);
        try {
          send(options.toRequest(requestId, input));
        } catch (error) {
          finish({ ok: false, error: `Could not send the ${noun} to the native host: ${errorMessage(error)}` });
        }
      }),
    handleResponse(response) {
      pending.get(response.requestId)?.(options.toResult(response));
    },
    close() {
      closed = true;
      for (const finish of [...pending.values()]) {
        finish({ ok: false, error: `The native host disconnected before the ${noun} finished` });
      }
    },
  };
}

export function hostFailure(response: { error: string; unavailable?: true }): HostFailure {
  return { ok: false, error: response.error, ...(response.unavailable ? { unavailable: true as const } : {}) };
}

export type BidiInputChannel = HostRequestChannel<Pick<BidiInputRequest, 'marker' | 'url' | 'actions'>, BidiInputResponse, BidiInputResult>;

export function createBidiInputChannel(send: (message: BidiInputRequest) => void): BidiInputChannel {
  return createHostRequestChannel(send, {
    noun: 'input',
    timeoutMs: BIDI_INPUT_TIMEOUT_MS,
    toRequest: (requestId, input) => ({ type: 'bidi_input_request' as const, requestId, ...input }),
    toResult: (response) => (response.ok ? { ok: true } : hostFailure(response)),
  });
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newTabMarker(): TabMarker {
  return { name: `__claudeTabMarker_${randomHex(8)}`, value: randomHex(16) };
}

function setMarker(name: string, value: string): void {
  Object.defineProperty(window, name, { value, configurable: true, enumerable: false, writable: false });
}

function clearMarker(name: string): void {
  delete (window as unknown as Record<string, unknown>)[name];
}

async function runInMainWorld<Args extends unknown[]>(tabId: number, func: (...args: Args) => void, args: Args): Promise<void> {
  const [main] = await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  if (main?.error !== undefined) throw main.error;
}

// WebDriver BiDi knows nothing of tabs.Tab.id, so the tab is marked with a random property in its
// page's main world, the realm BiDi script.evaluate sees, and the native host looks for the context
// carrying it. The tab is not activated. `failure` prefixes the error when the marker cannot be set.
export async function withTabMarker<T>(tabId: number, failure: string, run: (marker: TabMarker) => Promise<T>): Promise<T> {
  const marker = newTabMarker();
  try {
    try {
      await runInMainWorld(tabId, setMarker, [marker.name, marker.value]);
    } catch (error) {
      throw new ToolError(`${failure}: ${errorMessage(error)}`);
    }
    return await run(marker);
  } finally {
    await runInMainWorld(tabId, clearMarker, [marker.name]).catch(() => undefined);
  }
}

export async function performInput(
  channel: BidiInputChannel | undefined,
  tabId: number,
  url: string,
  actions: InputSource[],
): Promise<void> {
  const failure = `Failed to send input to tab ${tabId}`;
  if (!channel) throw new ToolError(`${failure}: the native host is not connected`);
  await withTabMarker(tabId, failure, async (marker) => {
    const result = await channel.request({ marker, url, actions });
    if (!result.ok) throw result.unavailable ? new BidiUnavailableError(result.error) : new ToolError(result.error);
  });
}
