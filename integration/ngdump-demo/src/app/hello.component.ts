import {Component} from '@angular/core';

@Component({
  standalone: true,
  selector: 'app-hello',
  template: `
    <h1>Hello from ngdump!</h1>
    <p>This is a simple standalone component.</p>
  `,
})
export class HelloComponent {
  message = 'Hello, World!';
}
