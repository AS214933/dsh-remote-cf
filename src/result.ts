/**
 * Result envelope for the Durable Object RPC surface.
 *
 * Errors cannot be thrown across the RPC boundary: the structured clone drops
 * custom properties, so `error.code` / `error.status` arrive as `undefined` and the
 * Worker would have to guess a status. Every RPC that can fail therefore returns
 * this envelope instead of throwing, and the caller maps it to an HTTP response.
 */
export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err { readonly ok: false; readonly code: string; readonly status: number }
export type Result<T> = Ok<T> | Err

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

/**
 * Widened to `Err` rather than `Result<never>`: callers combine it with an `Ok<T>`
 * return, and a narrower type makes that union unusable.
 */
export function err(code: string, status: number): Err {
  return { ok: false, code, status }
}

/** Map a thrown StoreError (still fine *inside* the object) to an envelope. */
export function fromThrown(error: unknown): Err {
  const shaped = error as { code?: unknown; status?: unknown }
  if (typeof shaped?.code === 'string' && typeof shaped?.status === 'number') {
    return err(shaped.code, shaped.status)
  }
  // An unexpected failure is reported as a server error, never as a 4xx: a bug
  // must not look like the caller's mistake.
  return err('INTERNAL_ERROR', 500)
}
