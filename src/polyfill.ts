interface BrowserPolyfillTarget {
  process?: {
    env: Record<string, string | undefined>;
  };
}

if (typeof window !== 'undefined') {
  const polyfilledGlobal = globalThis as unknown as BrowserPolyfillTarget;
  polyfilledGlobal.process = { env: {} };
}
