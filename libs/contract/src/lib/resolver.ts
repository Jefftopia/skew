import {
  ReadOptions,
  SkewResult,
  VersionedSchema,
  registerSchema,
  versionedList,
} from '@skewkit/core';
import {
  SkewContractDocument,
  contractFingerprint,
  parseContractDocument,
} from './document.js';
import { ContractCodeStep, versionedFromContract } from './schema-from-contract.js';

/**
 * Runtime contract resolution — the async layer over `@skewkit/core`'s
 * synchronous reads.
 *
 * Trust model: a contract document is fetched from the same origin whose
 * *data* you already trust, and nothing in it is executable — ops are
 * interpreted against a closed whitelist, and `code` steps only name
 * implementations the consuming bundle itself ships. For belt-and-braces
 * deployments, `pinnedFingerprints` refuses a document whose content hash
 * moved.
 */

export interface ContractResolverOptions {
  /** Defaults to the global `fetch`. Injected for tests and odd runtimes. */
  readonly fetchImpl?: typeof fetch;
  /** Implementations for named `code` steps, passed through to every load. */
  readonly codeSteps?: Readonly<Record<string, ContractCodeStep<any, any>>>;
  /**
   * Expected content fingerprint per contract URL. A resolved document whose
   * fingerprint differs is refused — use when the deployment pipeline knows
   * exactly which contract it was built against.
   */
  readonly pinnedFingerprints?: Readonly<Record<string, string>>;
  /**
   * List-schema names to derive per contract name. An API publishes the
   * *item* contract (`portfolio-fund`); a client often reads the collection
   * through its own list schema (`portfolio-funds`). Declaring
   * `{ 'portfolio-fund': 'portfolio-funds' }` here makes every resolve also
   * register the item steps lifted element-wise under the list name.
   */
  readonly lists?: Readonly<Record<string, string>>;
}

export interface ContractResolver {
  /**
   * Fetches, validates, and caches a contract document. Subsequent calls for
   * the same URL revalidate with `If-None-Match` when the origin sent an
   * ETag, and fall back to the cached copy when the origin is unreachable —
   * a stale contract is still a better guide than none.
   */
  resolve(url: string): Promise<SkewContractDocument>;
  /**
   * Resolves a document and registers every runnable step with the shared
   * registry — after which any schema of the same contract name, in any
   * bundle of the page, can read across versions it never shipped.
   */
  resolveAndRegister(url: string): Promise<SkewContractDocument>;
  /**
   * The `ahead` cure, packaged: read; if the result is `ahead`, resolve the
   * contract (which the origin serves, and the origin is always at least as
   * new as the data it produced), then read again with the newly registered
   * down-steps. Any other outcome — success or failure — passes through
   * untouched.
   */
  readResolving<T>(
    schema: VersionedSchema<T>,
    raw: unknown,
    contractUrl: string,
    options?: ReadOptions,
  ): Promise<SkewResult<T>>;
  /** Drops the cache — the next resolve refetches unconditionally. */
  invalidate(url?: string): void;
}

interface CacheEntry {
  readonly doc: SkewContractDocument;
  readonly etag: string | null;
}

export function createContractResolver(options: ContractResolverOptions = {}): ContractResolver {
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<SkewContractDocument>>();

  // Wrapped rather than referenced: a bare `fetch` alias loses its `window`
  // receiver in browsers and throws "Illegal invocation".
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function fetchDocument(url: string): Promise<SkewContractDocument> {
    const cached = cache.get(url);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (cached?.etag) headers['if-none-match'] = cached.etag;

    let response: Response;
    try {
      response = await doFetch(url, { headers });
    } catch (cause) {
      if (cached) return cached.doc;
      const unreachable = new Error(`skew contract: could not reach ${url}`);
      (unreachable as { cause?: unknown }).cause = cause;
      throw unreachable;
    }

    if (response.status === 304 && cached) return cached.doc;
    if (!response.ok) {
      if (cached) return cached.doc;
      throw new Error(`skew contract: ${url} answered HTTP ${response.status}`);
    }

    const doc = parseContractDocument(await response.json());

    const pinned = options.pinnedFingerprints?.[url];
    if (pinned !== undefined) {
      const actual = contractFingerprint(doc);
      if (actual !== pinned) {
        throw new Error(
          `skew contract: ${url} resolved to fingerprint ${actual}, but this build pins ${pinned} — refusing the document`,
        );
      }
    }

    cache.set(url, { doc, etag: response.headers.get('etag') });
    return doc;
  }

  function resolve(url: string): Promise<SkewContractDocument> {
    const pending = inFlight.get(url);
    if (pending) return pending;

    const request = fetchDocument(url).finally(() => inFlight.delete(url));
    inFlight.set(url, request);
    return request;
  }

  return {
    resolve,

    async resolveAndRegister(url: string): Promise<SkewContractDocument> {
      const doc = await resolve(url);
      // Building at `current` materializes and registers every runnable step;
      // the schema itself is only kept long enough to lift it to a list.
      const schema = versionedFromContract(doc, { codeSteps: options.codeSteps });
      const listName = options.lists?.[doc.name];
      if (listName !== undefined) {
        registerSchema(versionedList(schema, listName));
      }
      return doc;
    },

    async readResolving<T>(
      schema: VersionedSchema<T>,
      raw: unknown,
      contractUrl: string,
      readOptions?: ReadOptions,
    ): Promise<SkewResult<T>> {
      const first = schema.read(raw, readOptions);
      if (first.ok || first.reason !== 'ahead') return first;

      try {
        await this.resolveAndRegister(contractUrl);
      } catch {
        // The refusal stands, with its original, accurate message — the cure
        // failed, the diagnosis didn't.
        return first;
      }
      return schema.read(raw, readOptions);
    },

    invalidate(url?: string): void {
      if (url === undefined) cache.clear();
      else cache.delete(url);
    },
  };
}
