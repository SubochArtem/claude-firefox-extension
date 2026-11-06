import { DEFAULT_BIDI_SESSION_TIMEOUTS, runInMarkedTab, type BidiSessionTimeouts } from './bidi-session';
import type { BidiInputRequest } from './protocol';

export interface BidiInputTimeouts extends BidiSessionTimeouts {
  actions: number;
}

export const DEFAULT_BIDI_INPUT_TIMEOUTS: BidiInputTimeouts = { ...DEFAULT_BIDI_SESSION_TIMEOUTS, actions: 20_000 };

export async function runBidiInput(
  request: Pick<BidiInputRequest, 'marker' | 'url' | 'actions'>,
  port: number,
  timeouts: BidiInputTimeouts = DEFAULT_BIDI_INPUT_TIMEOUTS,
  signal?: AbortSignal,
): Promise<void> {
  await runInMarkedTab(
    request,
    port,
    timeouts,
    signal,
    async (connection, context) => {
      await connection.command('input.performActions', { context, actions: request.actions }, timeouts.actions);
    },
    'input.releaseActions',
  );
}
