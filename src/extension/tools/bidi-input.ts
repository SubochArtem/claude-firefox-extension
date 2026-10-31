import { BIDI_INPUT_TIMEOUT_MS, type BidiInputRequest, type BidiInputResponse, type TabMarker } from '../protocol';
import type { InputSource } from './input-actions';
import { errorMessage } from './tab-access';
import { ToolError } from './tool-error';

export type BidiInputResult = { ok: true } | { ok: false; error: string };

// Input requests to the native host over one native port. Never rejects: a timeout, a closed port or a
// failed send settles the request with an error.
export interface BidiInputChannel {
  request(input: Pick<BidiInputRequest, 'marker' | 'url' | 'actions'>): Promise<BidiInputResult>;
  handleResponse(response: BidiInputResponse): void;
  close(): void;
}

export function createBidiInputChannel(send: (message: BidiInputRequest) => void): BidiInputChannel {
  const pending = new Map<string, (result: BidiInputResult) => void>();
  let closed = false;

  return {
    request: (input) =>
      new Promise((resolve) => {
        if (closed) {
          resolve({ ok: false, error: 'The native host is not connected' });
          return;
        }
        const requestId = crypto.randomUUID();
        const finish = (result: BidiInputResult) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(result);
        };
        const timer = setTimeout(
          () => finish({ ok: false, error: `The native host did not finish the input within ${BIDI_INPUT_TIMEOUT_MS / 1000} s` }),
          BIDI_INPUT_TIMEOUT_MS,
        );
        pending.set(requestId, finish);
        try {
          send({ type: 'bidi_input_request', requestId, ...input });
        } catch (error) {
          finish({ ok: false, error: `Could not send the input to the native host: ${errorMessage(error)}` });
        }
      }),
    handleResponse(response) {
      pending.get(response.requestId)?.(response.ok ? { ok: true } : { ok: false, error: response.error });
    },
    close() {
      closed = true;
      for (const finish of [...pending.values()]) {
        finish({ ok: false, error: 'The native host disconnected before the input finished' });
      }
    },
  };
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
// carrying it. The tab is not activated.
export async function performInput(
  channel: BidiInputChannel | undefined,
  tabId: number,
  url: string,
  actions: InputSource[],
): Promise<void> {
  if (!channel) throw new ToolError(`Failed to send input to tab ${tabId}: the native host is not connected`);
  const marker = newTabMarker();
  try {
    try {
      await runInMainWorld(tabId, setMarker, [marker.name, marker.value]);
    } catch (error) {
      throw new ToolError(`Failed to send input to tab ${tabId}: ${errorMessage(error)}`);
    }
    const result = await channel.request({ marker, url, actions });
    if (!result.ok) throw new ToolError(result.error);
  } finally {
    await runInMainWorld(tabId, clearMarker, [marker.name]).catch(() => undefined);
  }
}
