import type { Server } from 'node:net';

export function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

export async function listenWithRetry(server: Server, nextEndpoint: () => string, attempts = 3): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const endpoint = nextEndpoint();
    try {
      await listen(server, endpoint);
      return endpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= attempts) throw error;
    }
  }
}
