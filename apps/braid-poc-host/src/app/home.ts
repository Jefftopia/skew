import { Component } from '@angular/core';

@Component({
  selector: 'app-home',
  standalone: true,
  template: `
    <h2>Host application</h2>
    <p>
      This page is server-rendered by the host Angular app. It contains no fragment — follow
      <em>Billing</em> to see an independently deployed Angular app composed into this one.
    </p>
  `,
})
export class Home {}
