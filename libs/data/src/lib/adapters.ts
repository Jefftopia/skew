import type { VersionedSchema } from '@skewkit/core';

/**
 * Protocol adapters: the layer never learns how to fetch.
 *
 * Three shapes cover the four protocols teams actually have. Each is a function type rather than a
 * class or a registration, because the smallest thing that can be substituted is the thing most
 * likely to be substituted — a REST endpoint replaced by a GraphQL query should not be a change to
 * this package.
 *
 * | Shape     | Covers                                  |
 * | --------- | --------------------------------------- |
 * | `Pull`    | REST, RPC, GraphQL queries              |
 * | `Push`    | GraphQL subscriptions, WebSockets, SSE  |
 * | `Command` | REST writes, RPC calls, GraphQL mutations |
 */

/** Fetches one record. Cancellable, because a query that outlives its subscriber must stop. */
export type PullAdapter = (key: string, signal: AbortSignal) => Promise<unknown>;

/**
 * Sends a write.
 *
 * Takes *input*, never a closure, and that constraint comes from the outbox rather than from taste:
 * a queued command is replayed by a build that may not be the one that queued it.
 */
export type CommandAdapter<TInput = unknown> = (input: TInput) => Promise<unknown>;

/**
 * A record arriving from the server unbidden, and the key it belongs under.
 *
 * Push is the shape that bends the model — it is a third write source alongside optimistic and
 * confirmed — so it is deliberately expressed as records handed to the layer rather than as a
 * stream the layer subscribes to. Everything a push writes goes through the same enveloping path as
 * every other write; otherwise a WebSocket update is the one record in the system with no version
 * on it, which is exactly the record a fragment two majors behind will read.
 */
export interface PushRecord {
  key: string;
  value: unknown;
  /** Tags to mark stale, for queries that hold lists rather than this key. */
  tags?: string[];
  /**
   * Which tenant partition this record belongs to. Defaults to the client's current one.
   *
   * One socket often carries events for more than one tenant — an advisor subscribed to every client
   * they cover, a desk subscribed to every fund. Filing all of it under whichever tenant happened to
   * be on screen would put one client's position in another's cache, so a stream that knows better
   * says so.
   */
  partition?: string;
}

/** What a push adapter writes into. Supplied by the client; never implemented by callers. */
export interface PushSink {
  /** Lands one record, enveloped and stamped, and refreshes readers of that key. */
  receive(record: PushRecord): Promise<void>;
  /** Reports a stream-level failure without tearing the subscription down. */
  fail?(error: unknown): void;
}

/**
 * Subscribes to a stream and writes what arrives into `sink`.
 *
 * Returns a disposer, or nothing when the `signal` is all the cleanup it needs.
 */
export type PushAdapter = (sink: PushSink, signal: AbortSignal) => void | (() => void) | Promise<void | (() => void)>;

export interface PushConnection<T> {
  schema: VersionedSchema<T>;
  source: PushAdapter;
  /** Applied to every record the stream produces, when the stream reports bare tags. */
  tags?: (key: string) => string[];
}

/**
 * Adapts a pull into a query's `fetch`.
 *
 * Trivial by design — the value is in the *shape* being named, so a team writing a second transport
 * has something to conform to rather than a signature to reverse-engineer from a query definition.
 */
export function fromPull(key: string, adapter: PullAdapter): (signal: AbortSignal) => Promise<unknown> {
  return (signal) => adapter(key, signal);
}
