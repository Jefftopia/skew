import { Component } from '@angular/core';
import { Editor } from './editor/editor';

/**
 * The remote running on its own.
 *
 * A remote is a whole application, not a fragment — it has to be independently
 * buildable, servable and testable, or "independently deployed" is a fiction.
 * The same `Editor` renders here and inside the host; only the injector around
 * it differs.
 */
@Component({
  selector: 'remote-root',
  imports: [Editor],
  styleUrl: './app.css',
  template: `
    <header>
      <div class="badge">REMOTE · standalone</div>
      <h1>Skew — remote editor</h1>
      <p class="sub">
        The newer of the two deployments. Served on its own port, it also
        exposes
        <code>./Editor</code> for the host to fetch at runtime.
      </p>
    </header>

    <remote-editor />
  `,
})
export class App {}
