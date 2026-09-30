/**
 * The part of jsdom's API the browser job's markup scripts use: jsdom ships no types, and the
 * suite reaches it otherwise only through Vitest's `jsdom` environment.
 */
declare module 'jsdom' {
  /** What a document is built with. */
  export interface ConstructorOptions {
    /** Whether the window runs animation frames and reports itself visible. */
    readonly pretendToBeVisual?: boolean;
  }

  /** A document and its window, parsed from markup. */
  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: Window & typeof globalThis;
  }
}
