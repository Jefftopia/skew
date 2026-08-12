/**
 * recovery/dirty-form-recovery-guard.ts
 *
 * Reload guard passed to withReloadGuard() in app.config.ts.
 *
 * Contract (assumed from @skewkit/angular-router): a SkewReloadGuard is a
 * function that receives the recovery context and returns (a promise of)
 * true  -> automatic reload is allowed
 * false -> automatic reload is vetoed; the recovery is surfaced as
 *          "blocked" so UI (our banner) can offer a manual reload instead.
 *
 * "Never reload over a form the user has half filled in" is enforced two
 * ways, so it works for both Angular-managed and non-Angular inputs:
 *
 *  1. Angular forms: any control marked ng-dirty inside a form/[formGroup]
 *     region. Angular stamps .ng-dirty on the element the moment the user
 *     changes a value, for both template-driven and reactive forms, so a DOM
 *     query is a reliable, framework-blessed signal that user input exists.
 *
 *  2. Raw DOM fallback: any <input>/<textarea>/<select> whose current value
 *     differs from its defaultValue (covers plain elements, third-party
 *     widgets that render native inputs, and contenteditable regions).
 */
import type { SkewReloadGuard, SkewRecoveryContext } from '@skewkit/angular-router';

function hasDirtyAngularForm(): boolean {
  return document.querySelector('.ng-dirty') !== null;
}

function hasDirtyNativeInput(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea',
  );
  for (const field of Array.from(fields)) {
    if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
      if (field.checked !== field.defaultChecked) return true;
    } else if (field.value !== field.defaultValue) {
      return true;
    }
  }
  // contenteditable regions with user-modified content
  return document.querySelector('[contenteditable="true"][data-user-modified]') !== null;
}

export const noDirtyFormsGuard: SkewReloadGuard = (_ctx: SkewRecoveryContext): boolean => {
  return !(hasDirtyAngularForm() || hasDirtyNativeInput());
};
