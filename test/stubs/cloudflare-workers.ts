/**
 * Stand-in for the `cloudflare:workers` module, which only exists inside the
 * Workers runtime.
 *
 * `Gateway` extends `DurableObject` from that module. Vitest runs in Node, so the
 * import has to resolve to something; the tests in this project exercise routing
 * and protocol logic, never the Durable Object's lifecycle, so an inert base class
 * is sufficient and no behaviour is faked that a test depends on.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState
  protected readonly env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
