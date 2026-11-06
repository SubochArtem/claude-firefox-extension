export interface ChatApiErrorDetails {
  status?: number;
  errorType?: string;
  retryable: boolean;
}

// A failed model request. The message never contains the API key.
export class ChatApiError extends Error {
  readonly status: number | undefined;
  readonly errorType: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, details: ChatApiErrorDetails) {
    super(message);
    this.name = 'ChatApiError';
    this.status = details.status;
    this.errorType = details.errorType;
    this.retryable = details.retryable;
  }
}

// The caller aborted the request through its AbortSignal.
export class ChatAbortError extends Error {
  constructor() {
    super('The request was aborted');
    this.name = 'ChatAbortError';
  }
}
