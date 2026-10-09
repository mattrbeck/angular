/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  ASTWithSource,
  BindingPipe,
  Interpolation,
  ParseLocation,
  ParseSourceFile,
  ParseSourceSpan,
  parseTemplate,
  TmplAstBoundText,
  TmplAstComponent,
  TmplAstElement,
  TypeCheckId,
} from '@angular/compiler';
import {ErrorCode} from '@angular/compiler-cli/private/hybrid_analysis';

import {RegistryDomSchemaChecker} from '../src/dom_schema_checker.js';
import {OutOfBandDiagnosticRecorderImpl} from '../src/oob.js';
import {buildTypeCheckingConfig} from '../src/tcb.js';
import {runPipeline, TestFile} from './utils.js';

function makeSpan(content: string, start: number, end: number): ParseSourceSpan {
  const file = new ParseSourceFile(content, '/test.ts');
  return new ParseSourceSpan(
    new ParseLocation(file, start, 0, start),
    new ParseLocation(file, end, 0, end),
  );
}

function parseFirstPipe(template: string): BindingPipe {
  const parsed = parseTemplate(template, '/test.ts');
  const boundText = parsed.nodes[0] as TmplAstBoundText;
  const astWithSource = boundText.value as ASTWithSource;
  const interp = astWithSource.ast as Interpolation;
  return interp.expressions[0] as BindingPipe;
}

describe('OOB & DOM Schema Diagnostic Parity', () => {
  describe('RegistryDomSchemaChecker.validateProperty', () => {
    it('reports security-sensitive event property bindings on template elements (8002)', () => {
      const checker = new RegistryDomSchemaChecker();
      const span = makeSpan('<div [onclick]="handler()"></div>', 5, 26);

      checker.checkTemplateElementProperty('tcb1' as TypeCheckId, 'div', 'onclick', span, [], true);

      expect(checker.diagnostics.length).toBe(1);
      expect(checker.diagnostics[0].code).toBe(Math.abs(ErrorCode.SCHEMA_INVALID_ATTRIBUTE));
      expect(checker.diagnostics[0].message).toContain(
        `Binding to event property 'onclick' is disallowed for security reasons`,
      );
      expect(checker.diagnostics[0].start).toBe(5);
      expect(checker.diagnostics[0].end).toBe(26);
    });

    it('reports security-sensitive event property bindings on host elements (8002)', () => {
      const checker = new RegistryDomSchemaChecker();
      const span = makeSpan("host: {'[onclick]': 'handler()'}", 7, 31);

      checker.checkHostElementProperty(
        'tcb1' as TypeCheckId,
        {tagNames: ['div']} as any,
        'onclick',
        span,
        [],
      );

      expect(checker.diagnostics.length).toBe(1);
      expect(checker.diagnostics[0].code).toBe(Math.abs(ErrorCode.SCHEMA_INVALID_ATTRIBUTE));
      expect(checker.diagnostics[0].message).toContain(
        `Binding to event property 'onclick' is disallowed for security reasons`,
      );
    });
  });

  describe('buildTypeCheckingConfig options parity', () => {
    it('respects strictUnclaimedEventNames and strictUnknownElements when provided', () => {
      const defaultConfig = buildTypeCheckingConfig({strictTemplates: true});
      expect(defaultConfig.checkUnclaimedEventNames).toBe(false);
      expect(defaultConfig.checkUnknownElements).toBe(false);

      const enabledConfig = buildTypeCheckingConfig({
        strictTemplates: true,
        strictUnclaimedEventNames: true,
        strictUnknownElements: true,
      });
      expect(enabledConfig.checkUnclaimedEventNames).toBe(true);
      expect(enabledConfig.checkUnknownElements).toBe(true);

      const disabledConfig = buildTypeCheckingConfig({
        strictTemplates: true,
        strictUnclaimedEventNames: false,
        strictUnknownElements: false,
      });
      expect(disabledConfig.checkUnclaimedEventNames).toBe(false);
      expect(disabledConfig.checkUnknownElements).toBe(false);
    });
  });

  describe('OutOfBandDiagnosticRecorderImpl parity', () => {
    const id = 'tcb1' as TypeCheckId;

    it('appends @angular/common import suggestion for known pipes in missingPipe and deduplicates via recordedPipes', () => {
      const recorder = new OutOfBandDiagnosticRecorderImpl();
      const pipeAst = parseFirstPipe('{{ val | async }}');

      recorder.missingPipe(id, pipeAst, true);
      // Second call with the same BindingPipe AST node should be deduplicated.
      recorder.missingPipe(id, pipeAst, true);
      recorder.deferredPipeUsedEagerly(id, pipeAst, null, null);

      expect(recorder.diagnostics.length).toBe(1);
      expect(recorder.diagnostics[0].code).toBe(Math.abs(ErrorCode.MISSING_PIPE));
      expect(recorder.diagnostics[0].message).toBe(
        `No pipe found with name 'async'.\n` +
          `To fix this, import the "AsyncPipe" class from "@angular/common" and add it to the "imports" array of the component.`,
      );

      const nonStandaloneRecorder = new OutOfBandDiagnosticRecorderImpl();
      const upperPipeAst = parseFirstPipe('{{ val | uppercase }}');
      nonStandaloneRecorder.missingPipe(id, upperPipeAst, false);
      expect(nonStandaloneRecorder.diagnostics.length).toBe(1);
      expect(nonStandaloneRecorder.diagnostics[0].message).toBe(
        `No pipe found with name 'uppercase'.\n` +
          `To fix this, import the "UpperCasePipe" class from "@angular/common" and add it to the "imports" array of the module declaring the component.`,
      );
    });

    it('reports conflictingHostDirectiveBinding (8024) highlighting only the tag name', () => {
      const recorder = new OutOfBandDiagnosticRecorderImpl();
      const parsed = parseTemplate('<my-comp [prop]="val"></my-comp>', '/test.ts');
      const element = parsed.nodes[0] as TmplAstElement;

      recorder.conflictingHostDirectiveBinding(id, element, 'HostDir', 'input', 'value', [
        'aliasA',
        'aliasB',
      ]);

      expect(recorder.diagnostics.length).toBe(1);
      const diag = recorder.diagnostics[0];
      expect(diag.code).toBe(Math.abs(ErrorCode.CONFLICTING_HOST_DIRECTIVE_BINDING));
      expect(diag.code).toBe(8024);
      expect(diag.message).toBe(
        'Input declared in HostDir.value is exposed under the following conflicting names: "aliasA", "aliasB". ' +
          'An input can only be exposed under a single name.',
      );
      // Tag name 'my-comp' is at offset [1, 8)
      expect(diag.start).toBe(1);
      expect(diag.end).toBe(8);
    });

    it('formats two-way bindings in formFieldUnsupportedBinding (8022)', () => {
      const recorder = new OutOfBandDiagnosticRecorderImpl();
      const parsed = parseTemplate('<input [formField]="f" [(ngModel)]="val">', '/test.ts');
      const element = parsed.nodes[0] as TmplAstElement;
      const twoWayAttr = element.inputs.find((i) => i.name === 'ngModel')!;

      recorder.formFieldUnsupportedBinding(id, twoWayAttr);

      expect(recorder.diagnostics.length).toBe(1);
      expect(recorder.diagnostics[0].code).toBe(Math.abs(ErrorCode.FORM_FIELD_UNSUPPORTED_BINDING));
      expect(recorder.diagnostics[0].code).toBe(8022);
      expect(recorder.diagnostics[0].message).toBe(
        `Binding to '[(ngModel)]' is not allowed on nodes using the '[formField]' directive`,
      );
    });

    it('distinguishes input vs output in unclaimedDirectiveBinding (8018)', () => {
      const recorder = new OutOfBandDiagnosticRecorderImpl();
      const parsed = parseTemplate(
        '<div @Dir([badInput]="1" (badOutput)="fn()")></div>',
        '/test.ts',
        {enableSelectorless: true},
      );
      const element = parsed.nodes[0] as TmplAstElement;
      const dir = element.directives[0];
      const boundAttr = dir.inputs[0];
      const boundEvent = dir.outputs[0];

      recorder.unclaimedDirectiveBinding(id, dir, boundAttr);
      recorder.unclaimedDirectiveBinding(id, dir, boundEvent);

      expect(recorder.diagnostics.length).toBe(2);
      expect(recorder.diagnostics[0].code).toBe(Math.abs(ErrorCode.UNCLAIMED_DIRECTIVE_BINDING));
      expect(recorder.diagnostics[0].message).toBe(
        'Directive Dir does not have an input named "badInput". Bindings to directives must target existing inputs or outputs.',
      );
      expect(recorder.diagnostics[1].code).toBe(Math.abs(ErrorCode.UNCLAIMED_DIRECTIVE_BINDING));
      expect(recorder.diagnostics[1].message).toBe(
        'Directive Dir does not have an output named "badOutput". Bindings to directives must target existing inputs or outputs.',
      );
    });

    it('reports specific @Component or @Directive type in incorrectTemplateDependencyType (2025)', () => {
      const recorder = new OutOfBandDiagnosticRecorderImpl();
      const parsed = parseTemplate('<NotAComp @NotADir/>', '/test.ts', {
        enableSelectorless: true,
      });
      const compNode = parsed.nodes[0] as TmplAstComponent;
      const dirNode = compNode.directives[0];

      recorder.incorrectTemplateDependencyType(id, compNode);
      recorder.incorrectTemplateDependencyType(id, dirNode);

      expect(recorder.diagnostics.length).toBe(2);
      expect(recorder.diagnostics[0].code).toBe(
        Math.abs(ErrorCode.INCORRECT_NAMED_TEMPLATE_DEPENDENCY_TYPE),
      );
      expect(recorder.diagnostics[0].code).toBe(2025);
      expect(recorder.diagnostics[0].message).toBe(
        'Incorrect reference type. Type must be a standalone @Component.',
      );
      expect(recorder.diagnostics[1].code).toBe(2025);
      expect(recorder.diagnostics[1].message).toBe(
        'Incorrect reference type. Type must be a standalone @Directive.',
      );
    });

    it('reports multipleMatchingComponents with code 8023 and tag name span', () => {
      const recorder = new OutOfBandDiagnosticRecorderImpl();
      const parsed = parseTemplate('<dup-comp id="1"></dup-comp>', '/test.ts');
      const element = parsed.nodes[0] as TmplAstElement;

      recorder.multipleMatchingComponents(id, element, ['CompA', 'CompB']);

      expect(recorder.diagnostics.length).toBe(1);
      expect(recorder.diagnostics[0].code).toBe(Math.abs(ErrorCode.MULTIPLE_MATCHING_COMPONENTS));
      expect(recorder.diagnostics[0].code).toBe(8023);
      expect(recorder.diagnostics[0].message).toBe(
        `Multiple components match node with tagname dup-comp: 'CompA', 'CompB'.`,
      );
      expect(recorder.diagnostics[0].start).toBe(1);
      expect(recorder.diagnostics[0].end).toBe(9);
    });
  });

  describe('end-to-end pipeline integration', () => {
    it('detects conflicting host directive bindings via R3TargetBinder (8024)', async () => {
      const files: TestFile[] = [
        {
          path: '/tsconfig.json',
          content: JSON.stringify({
            compilerOptions: {
              target: 'es2022',
              module: 'esnext',
              moduleResolution: 'bundler',
              experimentalDecorators: true,
            },
            files: ['app.ts'],
            angularCompilerOptions: {
              strictTemplates: true,
            },
          }),
        },
        {
          path: '/app.ts',
          content: `
import {Component, Directive, Input} from '@angular/core';

@Directive({standalone: true})
export class SharedDir {
  @Input() val = '';
}

@Directive({
  selector: '[dirA]',
  standalone: true,
  hostDirectives: [{directive: SharedDir, inputs: ['val: aliasA']}],
})
export class DirA {}

@Directive({
  selector: '[dirB]',
  standalone: true,
  hostDirectives: [{directive: SharedDir, inputs: ['val: aliasB']}],
})
export class DirB {}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DirA, DirB],
  template: '<div dirA dirB></div>',
})
export class AppComponent {}
`,
        },
      ];

      const outputs = await runPipeline(files, {optimize: true, format: false});
      const diagFile = outputs.find((f) => f.path.endsWith('.ngdiag.json'));
      expect(diagFile).toBeDefined();
      const parsed = JSON.parse(diagFile!.content);
      const conflictDiag = parsed.diagnostics.find((d: any) => d.code === 8024);
      expect(conflictDiag).toBeDefined();
      expect(conflictDiag.messageText).toContain(
        'Input declared in SharedDir.val is exposed under the following conflicting names: "aliasA", "aliasB".',
      );
    });
  });
});
