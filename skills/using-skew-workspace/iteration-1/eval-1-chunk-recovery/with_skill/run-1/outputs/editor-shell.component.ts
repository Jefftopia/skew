import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { trackUnsavedWork } from '@skewkit/angular-router';

/**
 * Example of the one line every form-bearing component needs so that chunk
 * recovery never reloads over a half-filled form (hard requirement #2).
 *
 * trackUnsavedWork(() => boolean) registers a predicate with the recovery
 * layer for this component's lifetime (it cleans itself up on destroy).
 * While ANY registered predicate returns true, provideSkewRecovery's
 * respectUnsavedWork guard downgrades automatic reloads to 'notify' — the
 * user sees the UpdateBannerComponent instead of losing their edits.
 *
 * Register it against the source of truth for dirtiness (form.dirty here;
 * a signal comparing draft vs saved works just as well). Do not gate it on
 * "probably fine" heuristics — a false negative costs the user their work.
 */
@Component({
  selector: 'app-editor-shell',
  standalone: true,
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form [formGroup]="form" (ngSubmit)="save()">
      <label>
        Title
        <input formControlName="title" />
      </label>
      <label>
        Body
        <textarea formControlName="body" rows="12"></textarea>
      </label>
      <button type="submit">Save</button>
    </form>
  `,
})
export class EditorShellComponent {
  private readonly fb = inject(FormBuilder);

  protected readonly form = this.fb.nonNullable.group({
    title: '',
    body: '',
  });

  constructor() {
    // The load-bearing line. Called in an injection context; unregisters
    // automatically when this component is destroyed.
    trackUnsavedWork(() => this.form.dirty);
  }

  protected save(): void {
    // ... persist ...
    // Once saved, mark the form pristine so recovery is unblocked again:
    this.form.markAsPristine();
  }
}
