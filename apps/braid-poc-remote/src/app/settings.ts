import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'billing-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <h3>Billing settings</h3>
    <p class="hint">A second route inside the remote app — reached through the remote's own router.</p>
    <label>
      Billing email
      <input type="email" [(ngModel)]="email" name="email" />
    </label>
    <p>Current value: <code>{{ email() }}</code></p>
  `,
  styles: `
    label { display: grid; gap: 0.25rem; max-width: 22rem; }
    input { padding: 0.4rem 0.6rem; border: 1px solid #cbd5e1; border-radius: 6px; }
    .hint { color: #64748b; font-size: 0.85rem; }
  `,
})
export class Settings {
  readonly email = signal('billing@example.com');
}
