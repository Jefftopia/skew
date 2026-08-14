import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiscoveryEntry } from '@skewkit/braid-gateway';
import { fetchRegistry, type ConsoleApi, type RegistryListing } from './client.js';
import { ensureStyles } from './styles.js';

export interface RegistryConsoleProps {
  /** How to reach the gateway. Defaults to this origin's `/__braid/registry`. */
  api?: ConsoleApi;
  /**
   * Force a theme. Omit to follow the viewer's OS setting — which is right for a standalone
   * deployment and usually wrong inside an admin shell that has already made the choice.
   */
  theme?: 'light' | 'dark';
  /** Extra class on the root, for hosts that want to size or position it. */
  className?: string;
  /** Called whenever a listing loads, for hosts that want their own chrome (counts, timestamps). */
  onLoaded?: (listing: RegistryListing) => void;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; listing: RegistryListing }
  | { status: 'error'; error: Error };

/**
 * A read-only view of what a gateway has registered.
 *
 * **Needs nothing deployed.** It reads the discovery endpoint the gateway already serves, so it
 * works against a gateway whose manifests are defined in code — which is every gateway today. No
 * snapshot store, no write API.
 *
 * What it deliberately does not do: own the URL, own a session, or style anything outside itself.
 * See `styles.ts` for the second, and `ConsoleApi` for the first two.
 */
export function RegistryConsole({ api, theme, className, onLoaded }: RegistryConsoleProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // The api object is usually an inline literal, so a new identity every render. Depending on it
  // directly would refetch forever; these fields are what actually determine the request.
  const apiKey = `${api?.baseUrl ?? ''}|${api?.discoveryPath ?? ''}`;

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    setState({ status: 'loading' });
    fetchRegistry(api, controller.signal).then(
      (listing) => {
        if (!current) return;
        setState({ status: 'ready', listing });
        onLoaded?.(listing);
      },
      (error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      },
    );

    return () => {
      current = false;
      controller.abort();
    };
    // Deliberately not exhaustive: `apiKey` stands in for the api object (see above), and
    // `onLoaded` is a notification — depending on it would retrigger the fetch that produced it.
  }, [apiKey, reloadToken]);

  const entries = state.status === 'ready' ? state.listing.entries : [];
  const visible = useMemo(() => filterEntries(entries, query), [entries, query]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return (
    <div className={`braid-console${className ? ` ${className}` : ''}`} {...(theme ? { 'data-theme': theme } : {})}>
      {state.status === 'error' ? (
        <ErrorPanel error={state.error} onRetry={reload} />
      ) : (
        <>
          <Header
            count={visible.length}
            total={entries.length}
            loading={state.status === 'loading'}
            query={query}
            onQueryChange={setQuery}
          />
          {state.status === 'ready' && state.listing.unfiltered && (
            <p className="braid-console__notice" role="status">
              <span aria-hidden="true">◆</span>
              <span>
                This gateway is in <strong>development mode</strong>, so the listing skips access filtering and may
                include endpoints. A production gateway shows only what the caller may list.
              </span>
            </p>
          )}
          {state.status === 'ready' && visible.length === 0 ? (
            <p className="braid-console__empty">
              {entries.length === 0 ? 'No fragments are registered.' : `Nothing matches “${query}”.`}
            </p>
          ) : (
            <FragmentTable entries={visible} />
          )}
        </>
      )}
    </div>
  );
}

function Header({
  count,
  total,
  loading,
  query,
  onQueryChange,
}: {
  count: number;
  total: number;
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
}) {
  return (
    <div className="braid-console__header">
      <h2 className="braid-console__title">Fragment registry</h2>
      <span className="braid-console__count">
        {loading ? 'loading…' : count === total ? `${total} fragment${total === 1 ? '' : 's'}` : `${count} of ${total}`}
      </span>
      <span className="braid-console__spacer" />
      <input
        className="braid-console__search"
        type="search"
        value={query}
        placeholder="Filter by id, title, tag, route"
        aria-label="Filter fragments"
        onChange={(event) => onQueryChange(event.target.value)}
      />
    </div>
  );
}

function FragmentTable({ entries }: { entries: DiscoveryEntry[] }) {
  return (
    <table className="braid-console__table">
      <thead>
        <tr>
          <th scope="col">Fragment</th>
          <th scope="col">Adapter</th>
          <th scope="col">Pierces</th>
          <th scope="col">Mount</th>
          <th scope="col">Access</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <td>
              <div className="braid-console__id">{entry.id}</div>
              {entry.title !== entry.id && <div className="braid-console__desc">{entry.title}</div>}
              {entry.description && <div className="braid-console__desc">{entry.description}</div>}
              {entry.tags?.map((tag) => (
                <span className="braid-console__tag" key={tag}>
                  {tag}
                </span>
              ))}
            </td>
            <td className="braid-console__mono">{entry.adapter}</td>
            <td>
              <div className="braid-console__patterns">
                {entry.pierce?.length ? (
                  entry.pierce.map((pattern) => (
                    <span className="braid-console__mono" key={pattern}>
                      {pattern}
                    </span>
                  ))
                ) : (
                  <span className="braid-console__mono">—</span>
                )}
              </div>
            </td>
            <td className="braid-console__mono">{entry.mount}</td>
            <td>
              {/* `loadable` is this caller's permission, not a property of the fragment: listing
                  and loading are separate rules, so "listed but gated" is a real, legitimate state
                  rather than a broken row. */}
              <span
                className={`braid-console__badge braid-console__badge--${entry.loadable ? 'loadable' : 'gated'}`}
                title={entry.loadable ? 'You may load this fragment' : 'Listed, but you may not load it'}
              >
                {entry.loadable ? 'loadable' : 'gated'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ErrorPanel({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="braid-console__error" role="alert">
      <h3>Could not read the registry</h3>
      <p>{error.message}</p>
      <button className="braid-console__retry" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** Matches across everything visible in a row, so the filter finds what the eye can see. */
export function filterEntries(entries: readonly DiscoveryEntry[], query: string): DiscoveryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];

  return entries.filter((entry) =>
    [entry.id, entry.title, entry.description, entry.adapter, ...(entry.tags ?? []), ...(entry.pierce ?? [])]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle)),
  );
}
