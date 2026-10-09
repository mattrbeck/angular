/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import type * as nga from './types.js';
import type {IAnalyzer} from './hybrid_compiler.js';

/** The wasm-bindgen `WasmAnalyzer` surface this adapter drives. */
export interface WasmInner {
  free(): void;
  pump(): string | undefined;
  analyze(): number;
  analyze_optimized(): number;
  analyze_delta(): number;
  analyze_optimized_delta(): number;
  update_file_content(updatesJson: string): string;
  invalidate_files(updatesJson: string): string;
  get_metadata_for_file(filePath: string): string | undefined;
  get_file_content(filePath: string): string;
  get_ts_file_for_template(templatePath: string): string | undefined;
  close_stream(id: number): void;
}

interface WasmEvent {
  id: number;
  event: 'analysisResult' | 'analysisComplete' | 'analysisError';
  data?: nga.CompilationChunk;
  error?: string;
}

/** JS-side state of one engine stream; `null` in `queue` marks its end. */
interface WasmStream {
  queue: (nga.CompilationChunk | null)[];
  nextResolve: ((val: nga.CompilationChunk | null) => void) | null;
  error?: Error;
}

export class WasmAnalyzer implements IAnalyzer {
  private inner: WasmInner;
  private streams = new Map<number, WasmStream>();
  private isPumping = false;

  constructor(inner: WasmInner) {
    this.inner = inner;
  }

  private schedulePump() {
    if (this.isPumping) {
      return;
    }
    this.isPumping = true;
    setTimeout(this.pumpLoop, 0);
  }

  private pumpLoop = () => {
    if (this.streams.size === 0) {
      this.isPumping = false;
      return;
    }

    const start = Date.now();
    let idleCount = 0;
    while (this.streams.size > 0 && Date.now() - start < 15) {
      const eventStr = this.inner.pump();
      if (!eventStr) {
        idleCount++;
        if (idleCount > 16) {
          break;
        }
        continue;
      }
      idleCount = 0;
      try {
        const event = JSON.parse(eventStr) as WasmEvent;
        const stream = this.streams.get(event.id);
        if (stream) {
          if (event.event === 'analysisResult' && event.data) {
            stream.queue.push(event.data);
          } else if (event.event === 'analysisComplete') {
            stream.queue.push(null);
          } else if (event.event === 'analysisError') {
            stream.error = new Error(event.error ?? 'Unknown analysis error');
          }
          if (stream.nextResolve) {
            const resolve = stream.nextResolve;
            stream.nextResolve = null;
            resolve(null);
          }
        }
      } catch (e) {
        console.error('Failed to parse WASM pump event', e);
      }
    }

    if (this.streams.size > 0) {
      setTimeout(this.pumpLoop, 0);
    } else {
      this.isPumping = false;
    }
  };

  analyze(): AsyncGenerator<nga.CompilationChunk, void, unknown> {
    return this.consumeStream(() => this.inner.analyze());
  }

  analyzeOptimized(): AsyncGenerator<nga.CompilationChunk, void, unknown> {
    return this.consumeStream(() => this.inner.analyze_optimized());
  }

  analyzeDelta(): AsyncGenerator<nga.CompilationChunk, void, unknown> {
    return this.consumeStream(() => this.inner.analyze_delta());
  }

  analyzeOptimizedDelta(): AsyncGenerator<nga.CompilationChunk, void, unknown> {
    return this.consumeStream(() => this.inner.analyze_optimized_delta());
  }

  /**
   * Opens an engine stream with `start` and yields its chunks until the engine ends it.
   *
   * `start` runs on the first `next()`, not when the generator is created. The `finally`
   * releases the stream however iteration ends: completion, an engine error, or a consumer
   * that stops early with `break`, `return()` or a throw. Without it an abandoned stream
   * would stay registered, and `pumpLoop`, which runs while any stream is registered,
   * would never stop.
   */
  private async *consumeStream(
    start: () => number,
  ): AsyncGenerator<nga.CompilationChunk, void, unknown> {
    const id = start();
    const stream: WasmStream = {queue: [], nextResolve: null};
    this.streams.set(id, stream);
    this.schedulePump();

    try {
      while (true) {
        const item = stream.queue.shift();
        if (item !== undefined) {
          if (item === null) {
            return;
          }
          yield item;
          continue;
        }
        if (stream.error) {
          throw stream.error;
        }
        await new Promise<void>((resolve) => {
          stream.nextResolve = () => resolve();
        });
      }
    } finally {
      this.releaseStream(id);
    }
  }

  /**
   * Unregisters stream `id` and drops the engine's receiver for it. Once a stream has ended
   * the engine has already dropped the receiver, so `close_stream` does nothing then.
   */
  private releaseStream(id: number): void {
    this.streams.delete(id);
    this.inner.close_stream(id);
  }

  async getMetadataForFile(filePath: string): Promise<nga.AnalysisResult | null> {
    return Promise.resolve(this.getMetadataForFileSync(filePath));
  }

  async updateFileContent(updates: {filePath: string; content: string}[]): Promise<string[]> {
    const jsonStr = JSON.stringify(updates);
    const res = this.inner.update_file_content(jsonStr);
    return Promise.resolve(JSON.parse(res) as string[]);
  }

  async invalidateFiles(updates: nga.FileInvalidation[]): Promise<string[]> {
    const stringNames = ['Created', 'Deleted', 'Changed'];
    const mapped = updates.map((u) => ({
      filePath: u.filePath,
      updateType:
        typeof u.updateType === 'number'
          ? (stringNames[u.updateType] ?? u.updateType)
          : u.updateType,
    }));
    const jsonStr = JSON.stringify(mapped);
    const res = this.inner.invalidate_files(jsonStr);
    return Promise.resolve(JSON.parse(res) as string[]);
  }

  async getTsFileForTemplate(templatePath: string): Promise<nga.TemplateUsage[] | null> {
    return Promise.resolve(this.getTsFileForTemplateSync(templatePath));
  }

  async getFileContent(filePath: string): Promise<string> {
    return Promise.resolve(this.getFileContentSync(filePath));
  }

  getMetadataForFileSync(filePath: string): nga.AnalysisResult | null {
    const res = this.inner.get_metadata_for_file(filePath);
    return res ? (JSON.parse(res) as nga.AnalysisResult) : null;
  }

  getFileContentSync(filePath: string): string {
    return this.inner.get_file_content(filePath);
  }

  getTsFileForTemplateSync(templatePath: string): nga.TemplateUsage[] | null {
    const res = this.inner.get_ts_file_for_template(templatePath);
    return res ? (JSON.parse(res) as nga.TemplateUsage[]) : null;
  }

  close(): void {
    for (const id of [...this.streams.keys()]) {
      this.releaseStream(id);
    }
  }
}
