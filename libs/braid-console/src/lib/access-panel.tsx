import { useMemo, useState } from 'react';
import type { FragmentManifest } from '@skewkit/braid-gateway';
import { accessMatrix, ANONYMOUS, parsePrincipal, type NamedPrincipal } from '@skewkit/braid-registry';

export interface AccessPanelProps {
  /** The draft being edited. */
  manifests: readonly FragmentManifest[];
  /** What is currently pinned, so the panel can show what the draft would change. */
  base?: readonly FragmentManifest[];
  principals: readonly NamedPrincipal[];
  onPrincipalsChange: (principals: NamedPrincipal[]) => void;
}

/**
 * Who can see and load what, and what the draft would do to that.
 *
 * The losses lead and the grid follows, because the losses are the finding. A grid on its own asks
 * an operator to scan for the one cell that moved, which is exactly the failure this exists to
 * prevent — a fragment quietly ceasing to be listed for the people who use it.
 *
 * Principals are named by the operator and held here, not persisted: the gateway has no principal
 * directory, and inventing one would make this look authoritative when it is a what-if.
 */
export function AccessPanel({ manifests, base, principals, onPrincipalsChange }: AccessPanelProps) {
  const [draftPrincipal, setDraftPrincipal] = useState('');

  const matrix = useMemo(
    () => accessMatrix(manifests, [ANONYMOUS, ...principals], base),
    [manifests, principals, base],
  );

  const addPrincipal = () => {
    const spec = draftPrincipal.trim();
    if (!spec) return;
    const parsed = parsePrincipal(spec);
    if (parsed.name === ANONYMOUS.name) return; // always present; adding it again would duplicate a column
    onPrincipalsChange([...principals.filter((p) => p.name !== parsed.name), parsed]);
    setDraftPrincipal('');
  };

  return (
    <section className="braid-console__access">
      <div className="braid-console__accesshead">
        <strong>Access</strong>
        <span className="braid-console__desc">
          Named principals, not real users — the gateway holds no directory.
        </span>
        <span className="braid-console__spacer" />
        <input
          className="braid-console__search"
          value={draftPrincipal}
          placeholder="trader:roles=trader"
          aria-label="Add a principal to test as"
          onChange={(event) => setDraftPrincipal(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && addPrincipal()}
        />
        <button className="braid-console__ghost" type="button" onClick={addPrincipal}>
          Test as
        </button>
      </div>

      {base && matrix.unchanged && <p className="braid-console__desc">This draft changes nobody’s access.</p>}

      {matrix.losses.length > 0 && (
        <ul className="braid-console__findings" role="alert">
          {matrix.losses.map((loss, index) => (
            <li key={index} className="braid-console__finding braid-console__finding--error">
              <strong>{loss.principal}</strong> can no longer {loss.action} <strong>{loss.fragmentId}</strong>
              {loss.to === 'absent' && <span className="braid-console__desc"> (fragment removed)</span>}
            </li>
          ))}
        </ul>
      )}

      {matrix.gains.length > 0 && (
        <ul className="braid-console__findings">
          {matrix.gains.map((gain, index) => (
            <li key={index} className="braid-console__finding">
              <strong>{gain.principal}</strong> can now {gain.action} <strong>{gain.fragmentId}</strong>
            </li>
          ))}
        </ul>
      )}

      <table className="braid-console__table braid-console__matrix">
        <thead>
          <tr>
            <th scope="col">Fragment</th>
            {matrix.principals.map((name) => (
              <th scope="col" key={name}>
                {name}
                {name !== ANONYMOUS.name && (
                  <button
                    className="braid-console__ghost braid-console__remove"
                    type="button"
                    aria-label={`Stop testing as ${name}`}
                    onClick={() => onPrincipalsChange(principals.filter((p) => p.name !== name))}
                  >
                    ×
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={`${row.fragmentId}:${row.action}`}>
              <td>
                <span className="braid-console__id">{row.fragmentId}</span>{' '}
                <span className="braid-console__mono">{row.action}</span>
              </td>
              {row.cells.map((cellValue) => (
                <td key={cellValue.principal}>
                  {cellValue.changed && base ? (
                    <>
                      <Mark outcome={cellValue.before} /> <span aria-hidden="true">→</span>{' '}
                      <Mark outcome={cellValue.after} />
                    </>
                  ) : (
                    <Mark outcome={cellValue.after} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Never colour alone — the label is what a screen reader and a colourblind reader both get. */
function Mark({ outcome }: { outcome: 'allowed' | 'denied' | 'absent' }) {
  const symbol = outcome === 'allowed' ? '✓' : outcome === 'denied' ? '✗' : '·';
  const label = outcome === 'allowed' ? 'allowed' : outcome === 'denied' ? 'denied' : 'not present';

  return (
    <span className={`braid-console__mark braid-console__mark--${outcome}`} title={label}>
      <span aria-hidden="true">{symbol}</span>
      <span className="braid-console__sronly">{label}</span>
    </span>
  );
}
