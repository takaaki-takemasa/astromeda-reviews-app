/**
 * IP-based rate limit using in-memory sliding window.
 *
 * Caveat: Vercel serverless functions are stateless across invocations,
 * so this is best-effort within a single warm function instance.
 * For production-grade rate limiting, swap to Upstash Redis or Vercel KV
 * in Phase A+ when we add Upstash for session storage.
 *
 * Threat Model T-08 / T-10 対応 (DoS / メールスパム緩和)。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const BUCKETS = new Map<string, Bucket>();
const MAX_BUCKETS = 10000; // Memory cap

function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export interface RateLimitOptions {
  /** Identifier (e.g. route name like "public.submit" or "admin.api") */
  scope: string;
  /** Max requests per window */
  max: number;
  /** Window in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  /** Number of requests in the current window before this check */
  count: number;
}

export function checkRateLimit(
  request: Request,
  opts: RateLimitOptions,
): RateLimitResult {
  const ip = getClientIp(request);
  const key = `${opts.scope}:${ip}`;
  const now = Date.now();

  // Lazy eviction: drop oldest if at capacity
  if (BUCKETS.size > MAX_BUCKETS) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of BUCKETS) {
      if (v.resetAt < oldestTime) {
        oldestTime = v.resetAt;
        oldestKey = k;
      }
    }
    if (oldestKey) BUCKETS.delete(oldestKey);
  }

  let bucket = BUCKETS.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + opts.windowMs };
    BUCKETS.set(key, bucket);
  }

  const count = bucket.count;
  bucket.count += 1;
  const allowed = bucket.count <= opts.max;
  return {
    allowed,
    remaining: Math.max(0, opts.max - bucket.count),
    resetAt: bucket.resetAt,
    count,
  };
}

/**
 * Throw a Response 429 when rate-limited. Convenience for Remix loaders/actions.
 */
export function enforceRateLimit(request: Request, opts: RateLimitOptions): void {
  const r = checkRateLimit(request, opts);
  if (!r.allowed) {
    throw new Response(
      JSON.stringify({
        error: "rate_limited",
        message: "Too many requests, please try again later.",
        retry_at: new Date(r.resetAt).toISOString(),
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(Math.ceil((r.resetAt - Date.now()) / 1000)),
          "x-ratelimit-limit": String(opts.max),
          "x-ratelimit-remaining": String(r.remaining),
          "x-ratelimit-reset": String(Math.floor(r.resetAt / 1000)),
        },
      },
    );
  }
}

/**
 * Predefined rate limit profiles (Threat Model 表 T-08 参照)
 */
export const RATE_LIMITS = {
  // Public review submission: お客様向け - 1 hour で 5 件
  PUBLIC_SUBMIT: { scope: "public.submit", max: 5, windowMs: 60 * 60 * 1000 },
  // Public auth (token check): 1 minute で 20 件
  PUBLIC_AUTH: { scope: "public.auth", max: 20, windowMs: 60 * 1000 },
  // Admin API: 1 minute で 100 件
  ADMIN_API: { scope: "admin.api", max: 100, windowMs: 60 * 1000 },
  // Admin login: 5 分で 10 件 (brute force 緩和)
  ADMIN_LOGIN: { scope: "admin.login", max: 10, windowMs: 5 * 60 * 1000 },
} as const;
