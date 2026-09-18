"use strict";

// A bounded in-process cache. Function instances are reused between invocations, so this
// absorbs repeat lookups for free; it is a complement to the shared Firestore cache, not a
// replacement (instances come and go, and there are up to maxInstances of them).

class MemoryCache {
  constructor({maxEntries = 500, ttlMs = 10 * 60 * 1000} = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, {value, at: Date.now()});
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
}

module.exports = {MemoryCache};
