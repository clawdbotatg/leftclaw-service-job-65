// Polyfill for Node 25+ static export builds.
// Next.js prerender workers spawn fresh Node processes; localStorage in
// those processes lacks getItem/setItem on Node 25. This shim runs via
// NODE_OPTIONS="--require ./polyfill-localstorage.cjs".
if (typeof globalThis.localStorage !== "undefined" && typeof globalThis.localStorage.getItem !== "function") {
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: key => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: index => {
      const keys = [...store.keys()];
      return index < keys.length ? keys[index] : null;
    },
    get length() {
      return store.size;
    },
  };
}
