/**
 * dsh-enter-newline — server (host) half.
 *
 * The behavior lives entirely in the client half (`src/client/index.ts`).
 * This half only needs to exist so the package is a mountable cordis plugin:
 * the profile's loader graph activates it, and the client-modules host scan
 * keys on live loader entries to discover `dsh.client` declarations.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export const name = 'dsh-enter-newline'

/** No host services required. */
export const inject: string[] = []

/**
 * Mount the plugin row. Nothing to do server-side — the composer Enter
 * policy is applied in the browser by the client half.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.logger?.info?.('[dsh-enter-newline] mounted (composer Enter policy lives in the client half)')
}
