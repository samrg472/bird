// Rate-limit telemetry: parsed from X's `x-rate-limit-*` response headers and
// delivered to consumers through the `onResponse` client option.

/**
 * Rate-limit headers parsed off a single response. Fields are nullable because
 * X omits some (or all) headers depending on endpoint and response type.
 */
export interface RateLimitInfo {
  /** `x-rate-limit-limit` — requests allowed per window. */
  limit: number | null;
  /** `x-rate-limit-remaining` — requests left in the current window. */
  remaining: number | null;
  /** `x-rate-limit-reset` — unix epoch SECONDS when the current window resets. */
  resetEpochSeconds: number | null;
  /**
   * Cooldown hint attached to rejected requests: `x-rate-limit-retryafter`,
   * falling back to the standard `retry-after` header. Delta-seconds only —
   * an HTTP-date value parses to null.
   */
  retryAfterSeconds: number | null;
}

/** Minimal header surface needed here; real `Headers` and plain test doubles both fit. */
type HeadersLike = { get(name: string): string | null | undefined } | undefined | null;

/** Metadata about one completed HTTP response, as seen by the client's fetch layer. */
export interface ResponseObservation {
  /**
   * Stable operation identifier: the GraphQL operation name for
   * `/i/api/graphql/{queryId}/{Operation}` requests, or the last two path
   * segments for REST endpoints (`/i/api/1.1/guest/activate.json` →
   * `guest/activate.json`). The bare GraphQL POST fallback URL (query ID in
   * the body, no operation in the path) degrades to `api/graphql`.
   */
  operation: string;
  url: string;
  method: string;
  status: number;
  ok: boolean;
  /** Completion time, epoch milliseconds. */
  atMs: number;
  /** Null when the response carried none of the recognized rate-limit headers. */
  rateLimit: RateLimitInfo | null;
  /**
   * Raw `content-type` header value (e.g. `application/json`), null when the
   * header is absent. Consumers combine this with `ok`/`cfMitigated` to spot
   * edge-level HTML interstitials (Cloudflare challenges/blocks) — never
   * treated as such on OK responses, since bird fetches real HTML pages
   * (the settings-page fallback) deliberately.
   */
  contentType: string | null;
  /** Raw `cf-mitigated` header value (e.g. `challenge`), null when absent. */
  cfMitigated: string | null;
}

function parseHeaderInt(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Reads a response header defensively (test doubles may omit `headers`). */
export function headerOrNull(headers: HeadersLike, name: string): string | null {
  const value = headers?.get?.(name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parses the rate-limit headers off a response. Returns null when none of the
 * recognized headers are present (endpoints without limits, or test doubles
 * that stub fetch with headerless plain objects).
 */
export function parseRateLimitHeaders(headers: HeadersLike): RateLimitInfo | null {
  const limit = parseHeaderInt(headerOrNull(headers, 'x-rate-limit-limit'));
  const remaining = parseHeaderInt(headerOrNull(headers, 'x-rate-limit-remaining'));
  const resetEpochSeconds = parseHeaderInt(headerOrNull(headers, 'x-rate-limit-reset'));
  const retryAfterSeconds =
    parseHeaderInt(headerOrNull(headers, 'x-rate-limit-retryafter')) ??
    parseHeaderInt(headerOrNull(headers, 'retry-after'));

  if (limit === null && remaining === null && resetEpochSeconds === null && retryAfterSeconds === null) {
    return null;
  }

  return { limit, remaining, resetEpochSeconds, retryAfterSeconds };
}

/** Extracts the stable operation name from a request URL (see ResponseObservation.operation). */
export function extractOperation(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Relative URLs are fine — split them as-is.
  }

  const segments = path.split('/').filter(Boolean);
  const graphqlIndex = segments.indexOf('graphql');
  if (graphqlIndex !== -1 && segments.length > graphqlIndex + 2) {
    // /i/api/graphql/{queryId}/{Operation} — the name is the last segment.
    return segments[segments.length - 1] ?? path;
  }

  const tail = segments.slice(-2).join('/');
  return tail.length > 0 ? tail : path;
}
