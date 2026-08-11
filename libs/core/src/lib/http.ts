import { VersionedEnvelope } from './versioned.js';

/**
 * HTTP-native version carriage.
 *
 * The `{ v, payload }` body envelope is right for storage, where there is
 * nothing but the bytes. HTTP already has places to carry a version — the
 * URL (`/v2/funds`), a header, the media type
 * (`application/vnd.acme.fund.v2+json`) — and requiring servers to reshape
 * every response body just to adopt Skew is an adoption tax with no payoff.
 *
 * These helpers extract the version from wherever the response carries it and
 * hand back a normal envelope, so the rest of the pipeline (`schema.read`)
 * never knows the difference:
 *
 * ```ts
 * const res = await fetch(`${API_BASE}/v1/funds`);
 * const body = await res.json();
 * const result = FundListSchema.read(envelopeFromResponse(res, body));
 * ```
 */

/** The subset of `Response` these helpers need — also satisfied by mocks. */
export interface ResponseLike {
  readonly url?: string;
  readonly headers?: { get(name: string): string | null };
}

export interface VersionCarriage {
  /**
   * Header carrying the version. The value may be a bare integer (`2`), a
   * `v=` parameter (`portfolio-fund; v=2`), or a Skew contract link
   * (`</.well-known/skew/contracts/portfolio-fund>; v=2`).
   */
  readonly header?: string;
  /** Pattern run against `content-type`; first capture group is the version. */
  readonly mediaType?: RegExp;
  /** Pattern run against the response URL; first capture group is the version. */
  readonly urlPattern?: RegExp;
}

/** The response header a Skew-aware server uses to name its contract. */
export const SKEW_CONTRACT_HEADER = 'skew-contract';

const DEFAULT_CARRIAGE: Required<VersionCarriage> = {
  header: SKEW_CONTRACT_HEADER,
  mediaType: /vnd\.[^+;]*\.v(\d+)\+json/i,
  urlPattern: /\/v(\d+)(?:\/|\?|$)/,
};

export interface SkewContractRef {
  /** Contract document URL, when the header carried one. */
  readonly url?: string;
  /** Contract name, when the header carried a bare name instead of a URL. */
  readonly name?: string;
  readonly v?: number;
}

/**
 * Parses a `Skew-Contract` header value.
 *
 * Accepted forms: `2` · `portfolio-fund; v=2` ·
 * `</.well-known/skew/contracts/portfolio-fund>; v=2`
 */
export function parseSkewContractHeader(value: string): SkewContractRef {
  const trimmed = value.trim();
  const ref: { url?: string; name?: string; v?: number } = {};

  const linked = trimmed.match(/^<([^>]+)>/);
  const bare = trimmed.split(';')[0]?.trim() ?? '';
  if (linked?.[1]) {
    ref.url = linked[1];
  } else if (bare && !/^\d+$/.test(bare)) {
    ref.name = bare;
  }

  const explicit = trimmed.match(/(?:^|;)\s*v\s*=\s*(\d+)/);
  const implicit = /^\d+$/.test(bare) ? bare : undefined;
  const version = explicit?.[1] ?? implicit;
  if (version !== undefined) ref.v = Number(version);

  return ref;
}

/** Formats the header the parser above accepts. */
export function formatSkewContractHeader(ref: SkewContractRef): string {
  const subject = ref.url !== undefined ? `<${ref.url}>` : (ref.name ?? '');
  const version = ref.v !== undefined ? `v=${ref.v}` : '';
  return [subject, version].filter((part) => part.length > 0).join('; ');
}

/**
 * Extracts the contract version a response carries, or `null` when it
 * carries none. Checks, in order: the header, the media type, the URL.
 */
export function versionFromResponse(res: ResponseLike, carriage: VersionCarriage = {}): number | null {
  const headerName = carriage.header ?? DEFAULT_CARRIAGE.header;
  const headerValue = res.headers?.get(headerName);
  if (headerValue) {
    const parsed = parseSkewContractHeader(headerValue);
    if (parsed.v !== undefined) return parsed.v;
  }

  const contentType = res.headers?.get('content-type');
  const mediaMatch = contentType?.match(carriage.mediaType ?? DEFAULT_CARRIAGE.mediaType);
  if (mediaMatch?.[1]) return Number(mediaMatch[1]);

  const urlMatch = res.url?.match(carriage.urlPattern ?? DEFAULT_CARRIAGE.urlPattern);
  if (urlMatch?.[1]) return Number(urlMatch[1]);

  return null;
}

/**
 * Normalizes a response + parsed body into something `schema.read` accepts.
 *
 * - Body already enveloped → returned as-is (the writer's statement wins).
 * - Version found in the response → the body wrapped at that version.
 * - Neither → the bare body, unchanged, which `read` treats as legacy data.
 */
export function envelopeFromResponse(
  res: ResponseLike,
  body: unknown,
  carriage: VersionCarriage = {},
): VersionedEnvelope | unknown {
  if (typeof body === 'object' && body !== null && typeof (body as { v?: unknown }).v === 'number' && 'payload' in body) {
    return body;
  }
  const version = versionFromResponse(res, carriage);
  return version === null ? body : { v: version, payload: body };
}
