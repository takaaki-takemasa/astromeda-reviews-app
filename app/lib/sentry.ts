/**
 * Sentry initialization helper.
 *
 * Phase C-06: Sentry 連携。SENTRY_DSN env var が設定されている時のみ初期化。
 * 未設定の場合は no-op (Sentry 自体は今 install しないので、現状 stub)。
 *
 * Phase A+ で @sentry/remix を追加して実装を入れ替える前提。
 */

export interface CaptureContext {
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  initialized = true;
  if (!process.env.SENTRY_DSN) {
    // eslint-disable-next-line no-console
    console.info("[sentry] SENTRY_DSN not set - error reporting disabled");
    return;
  }
  // TODO Phase A+: import { init } from "@sentry/remix" and call here
  // eslint-disable-next-line no-console
  console.info("[sentry] init - SENTRY_DSN detected (TODO: wire @sentry/remix)");
}

export function captureException(err: unknown, ctx?: CaptureContext): void {
  // TODO Phase A+: forward to Sentry.captureException
  // eslint-disable-next-line no-console
  console.error("[error]", err, ctx ? `ctx=${JSON.stringify(ctx)}` : "");
}

export function captureMessage(message: string, ctx?: CaptureContext): void {
  // eslint-disable-next-line no-console
  console.warn("[warn]", message, ctx ? `ctx=${JSON.stringify(ctx)}` : "");
}
