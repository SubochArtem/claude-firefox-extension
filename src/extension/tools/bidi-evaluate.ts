import { BIDI_EVALUATE_TIMEOUT_MS, type BidiEvaluateRequest, type BidiEvaluateResponse } from '../protocol';
import { BidiUnavailableError, createHostRequestChannel, type HostRequestChannel, hostFailure, withTabMarker } from './bidi-input';
import { ToolError } from './tool-error';

// value: the script's result as text; exception: its uncaught exception with the stack.
export type EvaluateOutcome = { value: string } | { exception: string };

export type BidiEvaluateResult = ({ ok: true } & EvaluateOutcome) | { ok: false; error: string; unavailable?: true };

export type BidiEvaluateChannel = HostRequestChannel<
  Pick<BidiEvaluateRequest, 'marker' | 'url' | 'code'>,
  BidiEvaluateResponse,
  BidiEvaluateResult
>;

export function createBidiEvaluateChannel(send: (message: BidiEvaluateRequest) => void): BidiEvaluateChannel {
  return createHostRequestChannel(send, {
    noun: 'script',
    timeoutMs: BIDI_EVALUATE_TIMEOUT_MS,
    toRequest: (requestId, input) => ({ type: 'bidi_evaluate_request' as const, requestId, ...input }),
    toResult: (response): BidiEvaluateResult => {
      if (!response.ok) return hostFailure(response);
      return 'value' in response ? { ok: true, value: response.value } : { ok: true, exception: response.exception };
    },
  });
}

// Runs `code` in the main realm of the tab's top frame through WebDriver BiDi script.evaluate in the
// native host. Throws BidiUnavailableError when the host reports BiDi itself unavailable.
export async function evaluateInTab(
  channel: BidiEvaluateChannel | undefined,
  tabId: number,
  url: string,
  code: string,
): Promise<EvaluateOutcome> {
  const failure = `Failed to run the script in tab ${tabId}`;
  if (!channel) throw new ToolError(`${failure}: the native host is not connected`);
  return withTabMarker(tabId, failure, async (marker) => {
    const result = await channel.request({ marker, url, code });
    if (!result.ok) throw result.unavailable ? new BidiUnavailableError(result.error) : new ToolError(result.error);
    return 'value' in result ? { value: result.value } : { exception: result.exception };
  });
}
