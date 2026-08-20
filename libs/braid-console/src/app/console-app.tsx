import { useEffect, useState } from 'react';
import { RegistryConsole } from '../lib/registry-console.js';
import { RegistryEditor } from '../lib/registry-editor.js';
import { ensureStyles } from '../lib/styles.js';
import type { ConsoleApi } from '../lib/client.js';

/**
 * The standalone deployment's shell.
 *
 * This lives in `app/`, not `lib/`, on purpose: it owns a page — a title, a tab strip, and the
 * URL — and every one of those is something the library must *not* own when it mounts inside
 * someone else's admin app. Keeping the page-level concerns here is what lets `RegistryConsole`
 * stay embeddable.
 *
 * The view is in the URL hash rather than in state alone, so a topology someone is looking at is
 * a link they can paste into a ticket. That is the difference between a console an operator uses
 * and one they screenshot.
 */
export function ConsoleApp({ api, edit }: { api: ConsoleApi; edit: boolean }) {
  const [view, setView] = useState<View>(() => readView(edit));

  useEffect(() => {
    ensureStyles();
  }, []);

  // Back and forward should move between views, since the tabs put entries in history.
  useEffect(() => {
    const onHashChange = () => setView(readView(edit));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [edit]);

  function go(next: View): void {
    window.location.hash = next;
    setView(next);
  }

  const tabs: { id: View; label: string }[] = [
    { id: 'fragments', label: 'Fragments' },
    { id: 'topology', label: 'Topology' },
    ...(edit ? ([{ id: 'edit', label: 'Edit registry' }] as const) : []),
  ];

  return (
    <div className="braid-console">
      <div className="braid-console__shell">
        <div className="braid-console__titlebar">
          <h1 className="braid-console__producttitle">Braid gateway</h1>
          <span className="braid-console__breadcrumb">
            <span aria-hidden="true">·</span>
            <code>{api.baseUrl || window.location.host}</code>
          </span>
        </div>

        <div className="braid-console__commandbar">
          <div className="braid-console__tabs" role="tablist" aria-label="Console views">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="braid-console__tab"
                aria-selected={view === entry.id}
                onClick={() => go(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === 'edit' ? (
        <RegistryEditor api={api} />
      ) : (
        // `chrome={false}` because the shell above already renders the heading, and `view` because
        // it already renders the tabs — the console keeps its command bar, filter, and stats.
        <RegistryConsole api={api} chrome={false} view={view} />
      )}
    </div>
  );
}

type View = 'fragments' | 'topology' | 'edit';

function readView(edit: boolean): View {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'topology') return 'topology';
  if (hash === 'edit' && edit) return 'edit';
  return 'fragments';
}
