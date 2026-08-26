import {Component, NgModule, OnDestroy, Pipe, PipeTransform} from '@angular/core';

@Pipe({
    name: 'myPipe', pure: false,
    standalone: false
})
export class MyPipe implements PipeTransform, OnDestroy {
  transform(value: any, ...args: any[]) {
    return value;
  }
  ngOnDestroy(): void {}
}

@Component({
    selector: 'my-app',
    template: '0:{{myPipe(name)}}1:{{myPipe(name, 1)}}2:{{myPipe(name, 1, 2)}}3:{{myPipe(name, 1, 2, 3)}}4:{{myPipe(name, 1, 2, 3, 4)}}',
    standalone: false
})
export class MyApp {
  name = '';
}

@NgModule({declarations: [MyPipe, MyApp]})
export class MyModule {
}
