// Minimal local typings for the jsdom API surface the widget DOM tests
// use, instead of @types/jsdom. The real @types/jsdom CANNOT be installed
// in this repo: vitest's `optional-types.d.ts` does an optional
// `import "jsdom"` that resolves the moment the package exists in
// node_modules, dragging `/// <reference lib="dom" />` into EVERY tsc
// program that touches vitest types — and lib.dom's CacheStorage /
// BufferSource globals conflict with @cloudflare/workers-types, breaking
// the root and test typecheck passes on files as far away as
// src/oauth/*. Scoped here (only test/widget/tsconfig.json includes it)
// so the other projects never see it.
declare module "jsdom" {
  interface JsdomOptions {
    url?: string;
    runScripts?: "dangerously" | "outside-only";
    pretendToBeVisual?: boolean;
    virtualConsole?: VirtualConsole;
  }

  type DOMWindow = Window & typeof globalThis & { close(): void };

  class JSDOM {
    constructor(html?: string, options?: JsdomOptions);
    readonly window: DOMWindow;
  }

  class VirtualConsole {
    on(event: string, callback: (...args: unknown[]) => void): this;
  }
}
