"use strict";

// Outbound HTTP helpers.
//
// The previous code did `require("node-fetch")`, which was never declared in
// functions/package.json - it only resolved because a transitive dependency happened to
// install it. On the declared Node 24 runtime `fetch` is a global, so the undeclared
// dependency is gone. Every outbound call now also has a timeout: a hung upstream used to
// hold a function instance until the 60 s function timeout expired.

const DEFAULT_TIMEOUT_MS = 10000;

async function fetchJson(url, options = {}) {
  const {timeoutMs = DEFAULT_TIMEOUT_MS, ...init} = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {...init, signal: controller.signal});
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        body = null;
      }
    }
    return {ok: response.ok, status: response.status, body, text};
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {fetchJson, DEFAULT_TIMEOUT_MS};
