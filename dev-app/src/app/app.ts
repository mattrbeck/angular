import {Component, signal, ViewEncapsulation} from '@angular/core';

@Component({
  selector: 'cmp-three',
  template: `
    <p>component three</p>
  `,
  styles: `
    p {
      color: green;
    }
  `,
  encapsulation: ViewEncapsulation.Scope,
  standalone: true,
})
export class CmpThree {}

@Component({
  selector: 'other-cmp',
  imports: [CmpThree],
  template: `
    <p>I'm the other component</p>
    <cmp-three />
  `,
  styles: `
    p { color: blue; }
  `,
  encapsulation: ViewEncapsulation.Emulated,
  standalone: true,
})
export class OtherCmp {}

@Component({
  selector: 'app-root',
  imports: [OtherCmp],
  template: `
    <p>one</p>
    <other-cmp />
  `,
  styles: `
    p {
      color: red;
    }
  `,
  encapsulation: ViewEncapsulation.Scope,
  standalone: true,
})
export class App {
  protected readonly title = signal('dev-app');
}
