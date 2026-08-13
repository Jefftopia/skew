import { Component, signal } from '@angular/core';

@Component({
  selector: 'billing-invoices',
  standalone: true,
  template: `
    <h3>Invoices</h3>
    <p class="hint">This markup is rendered by the remote Angular app, running in its own realm.</p>
    <ul>
      @for (invoice of invoices(); track invoice.id) {
        <li>
          <span class="id">{{ invoice.id }}</span>
          <span>{{ invoice.customer }}</span>
          <strong>{{ invoice.total }}</strong>
        </li>
      }
    </ul>
    <button type="button" (click)="addInvoice()">Add invoice (proves this app is live)</button>
  `,
  styles: `
    ul { list-style: none; padding: 0; display: grid; gap: 0.25rem; }
    li { display: grid; grid-template-columns: 5rem 1fr auto; gap: 1rem; padding: 0.4rem 0.6rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; }
    .id { font-family: ui-monospace, monospace; color: #64748b; }
    .hint { color: #64748b; font-size: 0.85rem; }
    button { margin-top: 0.75rem; }
  `,
})
export class Invoices {
  private nextId = 1004;

  readonly invoices = signal([
    { id: 'INV-1001', customer: 'Acme Corp', total: '$1,200.00' },
    { id: 'INV-1002', customer: 'Globex', total: '$840.50' },
    { id: 'INV-1003', customer: 'Initech', total: '$2,310.75' },
  ]);

  addInvoice(): void {
    const id = `INV-${this.nextId++}`;
    this.invoices.update((invoices) => [...invoices, { id, customer: 'New customer', total: '$0.00' }]);
  }
}
