export const DEFAULT_ATTEMPTS = 3;

export interface RetryOptions {
  attempts?: number;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
