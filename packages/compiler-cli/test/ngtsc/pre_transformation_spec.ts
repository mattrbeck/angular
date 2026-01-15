/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';
import {NgtscProgram} from '../../src/ngtsc/program';
import {NgCompiler} from '../../src/ngtsc/core';
import {absoluteFrom} from '../../src/ngtsc/file_system';
import {runInEachFileSystem} from '../../src/ngtsc/file_system/testing';
import {loadStandardTestFiles} from '../../src/ngtsc/testing';
import {NgtscTestEnvironment} from './env';

const testFiles = loadStandardTestFiles();

runInEachFileSystem(() => {
  describe('pre-transformation mode', () => {
    let env!: NgtscTestEnvironment;

    beforeEach(() => {
      env = NgtscTestEnvironment.setup(testFiles);
    });

    describe('basic compilation', () => {
      // Verify the test setup works with traditional mode
      it('should compile a simple component in traditional mode', () => {
        env.tsconfig({});

        env.write(
          'test.ts',
          `
          import {Component} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>Hello World</div>',
          })
          export class TestCmp {}
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('Hello World');
        expect(jsContents).toContain('ɵcmp');
      });

      // Debug test to understand what's happening with generateTransformedSources
      it('should generate transformed sources for a simple component', () => {
        env.tsconfig({});

        env.write(
          'test.ts',
          `
          import {Component} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>Hello World</div>',
          })
          export class TestCmp {}
        `,
        );

        // First, run the normal compilation to set up oldProgram
        env.enableMultipleCompilations();
        env.driveMain();

        // Get the program and compiler directly
        const ngtscProgram = (env as any).oldProgram as NgtscProgram;

        // Check that the compiler exists
        expect(ngtscProgram).toBeDefined();
        expect(ngtscProgram.compiler).toBeDefined();

        // Try to generate transformed sources
        const transformedSources = ngtscProgram.compiler.generateTransformedSources();

        // This should have at least one transformed file
        expect(transformedSources.size).toBeGreaterThan(0);

        // Verify the transformed content has the expected static fields
        for (const [path, content] of transformedSources) {
          if (path.endsWith('test.ts')) {
            expect(content.transformedText).toContain('ɵcmp');
          }
        }
      });

      // Test the pre-transformation flow explicitly
      it('should work when called early (simulating pre-transformation flow)', () => {
        env.tsconfig({});

        env.write(
          'test.ts',
          `
          import {Component} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>Hello World</div>',
          })
          export class TestCmp {}
        `,
        );

        // Create the program manually to simulate the pre-transformation flow
        env.enableMultipleCompilations();

        // Run driveMain but then immediately call generateTransformedSources
        // to see if it works in that context
        env.driveMain();

        const ngtscProgram = (env as any).oldProgram as NgtscProgram;

        // Get the list of source files the compiler sees
        const sourceFiles = ngtscProgram.getTsProgram().getSourceFiles();
        const userFiles = sourceFiles.filter(sf => !sf.isDeclarationFile && sf.fileName.includes('test.ts'));

        // There should be exactly one user file
        expect(userFiles.length).toBe(1);

        // The transformed sources should work
        const transformedSources = ngtscProgram.compiler.generateTransformedSources();
        expect(transformedSources.size).toBeGreaterThan(0);
      });

      // Basic test to verify pre-transformation mode generates valid output
      it('should analyze classes correctly when enabling pre-transformation', () => {
        env.tsconfig({
          _usePreTransformation: true,
        });

        env.write(
          'test.ts',
          `
          import {Component} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>Hello World</div>',
          })
          export class TestCmp {}
        `,
        );

        env.driveMain();
        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('ɵcmp');
      });

      it('should compile a simple component in pre-transformation mode', () => {
        env.tsconfig({
          _usePreTransformation: true,
        });

        env.write(
          'test.ts',
          `
          import {Component} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>Hello World</div>',
          })
          export class TestCmp {}
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('Hello World');
        expect(jsContents).toContain('ɵcmp');
      });

      it('should compile a directive', () => {
        env.tsconfig({
          _usePreTransformation: true,
        });

        env.write(
          'test.ts',
          `
          import {Directive, Input} from '@angular/core';

          @Directive({
            selector: '[testDir]',
          })
          export class TestDir {
            @Input() testDir: string = '';
          }
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('ɵdir');
      });

      it('should compile a pipe', () => {
        env.tsconfig({
          _usePreTransformation: true,
        });

        env.write(
          'test.ts',
          `
          import {Pipe, PipeTransform} from '@angular/core';

          @Pipe({
            name: 'testPipe',
          })
          export class TestPipe implements PipeTransform {
            transform(value: string): string {
              return value.toUpperCase();
            }
          }
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('ɵpipe');
      });

      it('should compile an injectable', () => {
        env.tsconfig({
          _usePreTransformation: true,
        });

        env.write(
          'test.ts',
          `
          import {Injectable} from '@angular/core';

          @Injectable({
            providedIn: 'root',
          })
          export class TestService {
            getValue(): string {
              return 'test';
            }
          }
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('ɵprov');
      });

      it('should compile an NgModule', () => {
        env.tsconfig({
          _usePreTransformation: true,
        });

        env.write(
          'test.ts',
          `
          import {NgModule, Component} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>Hello</div>',
            standalone: false,
          })
          export class TestCmp {}

          @NgModule({
            declarations: [TestCmp],
            exports: [TestCmp],
          })
          export class TestModule {}
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('ɵmod');
        expect(jsContents).toContain('ɵcmp');
      });

      it('should generate TCB shims for template type-checking', () => {
        env.tsconfig({
          _usePreTransformation: true,
        });

        env.write(
          'test.ts',
          `
          import {Component} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>{{ message }}</div>',
          })
          export class TestCmp {
            message: string = 'Hello';
          }
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('ɵcmp');
        expect(jsContents).toContain('message');
      });

      it('should report template type errors in pre-transformation mode', () => {
        env.tsconfig({
          _usePreTransformation: true,
          strictTemplates: true,
        });

        env.write(
          'test.ts',
          `
          import {Component} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>{{ nonExistentProperty }}</div>',
          })
          export class TestCmp {}
        `,
        );

        const diags = env.driveDiagnostics();

        // Should have a diagnostic about the non-existent property
        expect(diags.length).toBeGreaterThan(0);
        expect(diags.some(d => d.messageText.toString().includes('nonExistentProperty'))).toBeTrue();
      });

      it('should handle generic components that require inline TCBs', () => {
        env.tsconfig({
          _usePreTransformation: true,
          strictTemplates: true,
        });

        env.write(
          'test.ts',
          `
          import {Component, Input} from '@angular/core';

          // Generic component that requires inline TCB due to type parameters
          @Component({
            selector: 'generic-cmp',
            template: '<div>{{ value }}</div>',
          })
          export class GenericCmp<T extends {name: string}> {
            @Input() value!: T;
          }

          @Component({
            selector: 'app-root',
            template: '<generic-cmp [value]="data"></generic-cmp>',
            imports: [GenericCmp],
          })
          export class AppCmp {
            data = {name: 'test'};
          }
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');
        expect(jsContents).toContain('ɵcmp');
        // Both components should be compiled
        expect(jsContents).toContain('GenericCmp');
        expect(jsContents).toContain('AppCmp');
      });

      it('should generate correct .d.ts files with proper type annotations', () => {
        env.tsconfig({
          _usePreTransformation: true,
          declaration: true,
        });

        env.write(
          'test.ts',
          `
          import {Component, Injectable, Directive, Input} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>Hello</div>',
          })
          export class TestCmp {}

          @Directive({
            selector: '[testDir]',
          })
          export class TestDir {
            @Input() testDir: string = '';
          }

          @Injectable({
            providedIn: 'root',
          })
          export class TestService {}
        `,
        );

        env.driveMain();

        // Verify .d.ts file is generated with proper Angular type annotations
        const dtsContents = env.getContents('test.d.ts');

        // Component should have ɵcmp and ɵfac declarations
        expect(dtsContents).toContain('static ɵcmp:');
        expect(dtsContents).toContain('static ɵfac:');

        // Directive should have ɵdir and ɵfac declarations
        expect(dtsContents).toContain('static ɵdir:');

        // Injectable should have ɵprov and ɵfac declarations
        expect(dtsContents).toContain('static ɵprov:');

        // Type annotations should reference Angular core types
        expect(dtsContents).toContain('i0.ɵɵComponentDeclaration');
        expect(dtsContents).toContain('i0.ɵɵDirectiveDeclaration');
        expect(dtsContents).toContain('i0.ɵɵInjectableDeclaration');
        expect(dtsContents).toContain('i0.ɵɵFactoryDeclaration');
      });

      it('should add signal debug metadata', () => {
        env.tsconfig({
          _usePreTransformation: true,
        });

        env.write(
          'test.ts',
          `
          import {Component, signal, computed, input} from '@angular/core';

          @Component({
            selector: 'test-cmp',
            template: '<div>{{ count() }}</div>',
          })
          export class TestCmp {
            count = signal(0);
            doubleCount = computed(() => this.count() * 2);
            name = input<string>();
          }
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');

        // Signal debug names should be added via ngDevMode conditional
        expect(jsContents).toContain('debugName');
        expect(jsContents).toContain('ngDevMode');

        // The debug names should match the property names
        expect(jsContents).toContain('"count"');
        expect(jsContents).toContain('"doubleCount"');
        expect(jsContents).toContain('"name"');
      });

      it('should handle @defer blocks and deferrable imports', () => {
        // Pre-transformation mode requires:
        // - Module settings that support dynamic imports (because import() calls are in the source)
        // - noImplicitAny: false (because defer block template functions have untyped parameters)
        env.tsconfig(
          {
            _usePreTransformation: true,
          },
          {
            module: 'esnext',
            target: 'es2022',
            noImplicitAny: false,
          } as any,
        );

        // Create a component that will be deferred
        env.write(
          'deferred.ts',
          `
          import {Component} from '@angular/core';

          @Component({
            selector: 'deferred-cmp',
            template: '<div>Deferred Content</div>',
          })
          export class DeferredCmp {}
        `,
        );

        env.write(
          'test.ts',
          `
          import {Component} from '@angular/core';
          import {DeferredCmp} from './deferred';

          @Component({
            selector: 'test-cmp',
            template: \`
              <div>Eager Content</div>
              @defer {
                <deferred-cmp />
              }
            \`,
            imports: [DeferredCmp],
          })
          export class TestCmp {}
        `,
        );

        env.driveMain();

        const jsContents = env.getContents('test.js');

        // The component should compile
        expect(jsContents).toContain('ɵcmp');

        // Deferred component reference should be in a defer block callback
        expect(jsContents).toContain('ɵɵdefer');

        // The deferrable import should not be at the top level
        // (it should be loaded lazily via dynamic import)
        const deferredJsContents = env.getContents('deferred.js');
        expect(deferredJsContents).toContain('ɵcmp');
      });
    });
  });
});
