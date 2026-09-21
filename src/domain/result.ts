/**
 * The project-wide convention for an expected outcome (ADR-0010): every module
 * that can fail in a way a caller should branch on returns a Result instead of
 * throwing. Exceptions stay reserved for truly unexpected failures.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
