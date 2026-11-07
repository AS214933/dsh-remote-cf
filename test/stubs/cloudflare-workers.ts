/**
 * Stand-in for the `cloudflare:workers` module, which only exists inside the
 * Workers runtime.
 *
 * `Gateway` extends this base class. Lifecycle tests supply their own state and
 * cloned socket attachments but execute the real Gateway handlers. Real workerd
 * hibernation is exercised separately by test/gateway-runtime.mjs.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState
  protected readonly env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
