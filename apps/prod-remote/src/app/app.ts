import { Component, signal } from '@angular/core';
import { Editor } from './editor/editor';
import { Tutorials } from './tutorials/tutorials';

/**
 * The remote running on its own.
 *
 * A remote is a whole application, not a fragment — it has to be independently
 * buildable, servable and testable, or "independently deployed" is a fiction.
 * The same `Editor` renders here and inside the host; only the injector around
 * it differs. The same holds for `Tutorials`, which the host mounts at
 * `/tutorials` via the `./Tutorials` exposure.
 *
 * The view switch below is a signal, not a router — this app has no routes on
 * purpose, and adding a router to toggle two panes would smuggle in exactly
 * the kind of incidental machinery the demo tries to keep out of frame.
 */
@Component({
  selector: 'remote-root',
  imports: [Editor, Tutorials],
  styleUrl: './app.css',
  template: `
    <header>
      <div class="badge">REMOTE · standalone</div>
      <h1>Skew — remote editor</h1>
      <p class="sub">
        The newer of the two deployments. Independently built and served, it
        also exposes <code>./Editor</code>, <code>./FundDetail</code>, and
        <code>./Tutorials</code> for the host to fetch at runtime.
      </p>
      <nav class="views">
        <button
          [class.active]="view() === 'editor'"
          (click)="view.set('editor')"
        >
          Editor
        </button>
        <button
          [class.active]="view() === 'tutorials'"
          (click)="view.set('tutorials')"
        >
          Tutorials
        </button>
      </nav>
    </header>

    @if (view() === 'editor') {
      <remote-editor />
    } @else {
      <remote-tutorials />
    }
  `,
})
export class App {
  protected readonly view = signal<'editor' | 'tutorials'>('editor');
}
