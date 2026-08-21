import { useEffect, useRef, useState } from 'react';
import type { DiscoveryEntry } from '@braidlabs/gateway';
import {
  INTEGRATION_TARGETS,
  integrationSnippet,
  integrationWarnings,
  type IntegrationTarget,
} from './integration.js';

export interface IntegrationPanelProps {
  entry: DiscoveryEntry;
  onClose: () => void;
}

/**
 * "How do I embed this?", answered next to the thing being embedded.
 *
 * A dialog rather than a row expansion: the snippet is the whole reason the reader is here, and a
 * table that reflows every time someone asks this question loses the row they were comparing it
 * against.
 */
export function IntegrationPanel({ entry, onClose }: IntegrationPanelProps) {
  const [target, setTarget] = useState<IntegrationTarget>('html');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'unavailable'>('idle');
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const code = useRef<HTMLPreElement>(null);

  const snippet = integrationSnippet(entry, target);
  const warnings = integrationWarnings(entry);

  // Focus moves into the dialog on open, so a keyboard user is not left where the trigger was.
  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialog.current) return;

      // A modal that lets focus wander behind it is a modal only for people using a mouse.
      const focusable = dialog.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /**
   * Copies, and degrades usefully when it cannot.
   *
   * `navigator.clipboard` is unavailable on an insecure origin and can be refused by permission —
   * and an internal console on plain HTTP is a completely ordinary deployment, not an edge case.
   * A button that silently does nothing there is worse than no button, so the fallback selects the
   * snippet and says to press the shortcut, which leaves the reader one keystroke from the same
   * result.
   */
  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard api');
      await navigator.clipboard.writeText(snippet.code);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      selectSnippet();
      setCopyState('unavailable');
    }
  }

  /** Puts the whole snippet in the selection, so the keyboard fallback is one keystroke. */
  function selectSnippet(): void {
    const node = code.current;
    const selection = window.getSelection();
    if (!node || !selection) return;

    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return (
    <div className="braid-console__scrim" onClick={onClose}>
      <div
        className="braid-console__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="braid-integrate-title"
        ref={dialog}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="braid-console__dialoghead">
          <h3 className="braid-console__dialogtitle" id="braid-integrate-title">
            Embed <code>{entry.id}</code>
          </h3>
          <button
            type="button"
            className="braid-console__detailclose"
            onClick={onClose}
            aria-label="Close"
            ref={closeButton}
          >
            ✕
          </button>
        </div>

        {warnings.map((warning) => (
          <p className="braid-console__notice" key={warning} role="status">
            <span aria-hidden="true">◆</span>
            <span>{warning}</span>
          </p>
        ))}

        <div className="braid-console__tabs" role="tablist" aria-label="Framework">
          {INTEGRATION_TARGETS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="braid-console__tab"
              aria-selected={target === id}
              onClick={() => {
                setTarget(id);
                setCopyState('idle');
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <pre className="braid-console__code" tabIndex={0} ref={code}>
          <code>{snippet.code}</code>
        </pre>

        <div className="braid-console__dialogfoot">
          <button type="button" className="braid-console__primary" onClick={copy}>
            {copyState === 'copied' ? 'Copied' : 'Copy'}
          </button>
          <span className="braid-console__hint" role="status">
            {copyState === 'unavailable' ? (
              <>
                This browser will not let the page write to the clipboard — the snippet is selected,
                so press <kbd>⌘C</kbd> / <kbd>Ctrl+C</kbd>.
              </>
            ) : (
              <>
                Needs <code>@braidlabs/core</code> installed in the host, and this gateway in front of it.
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
