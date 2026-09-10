import type { Result } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Unwraps the Result envelope every IPC call returns, throwing on failure. */
export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) return result.data;
  throw new ApiError(result.error.message, result.error.code, result.error.detail);
}

export const api = window.api;

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return String(error);
}
