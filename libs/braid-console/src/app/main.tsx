import { createRoot } from 'react-dom/client';
import { RegistryConsole } from '../lib/registry-console.js';
import { RegistryEditor } from '../lib/registry-editor.js';
import type { ConsoleApi } from '../lib/client.js';

/**
 * Standalone entry — the deployable form.
 *
 * Configuration comes from the DOM rather than a build-time constant, so one bundle serves every
 * environment: the same artifact staging tested is the artifact production runs, pointed
 * elsewhere. Drop a `<script type="application/json" id="braid-console-config">` next to the mount
 * point, or leave it out and the console reads the origin it was served from.
 */
const mount = document.getElementById('root');
if (!mount) throw new Error('braid-console: no #root element to mount into');

const config = readConfig();

// Read-only unless the deployment says otherwise. Editing needs a write API the gateway may not
// have mounted, and defaulting to an editor that cannot save is a worse first impression than a
// listing that works.
createRoot(mount).render(config.edit ? <RegistryEditor api={config} /> : <RegistryConsole api={config} />);

function readConfig(): ConsoleApi & { edit?: boolean } {
  const element = document.getElementById('braid-console-config');
  if (!element?.textContent) return {};
  try {
    return JSON.parse(element.textContent) as ConsoleApi & { edit?: boolean };
  } catch {
    console.warn('braid-console: #braid-console-config is not valid JSON; using defaults');
    return {};
  }
}
