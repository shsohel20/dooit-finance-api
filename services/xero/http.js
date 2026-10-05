"use strict";

// Thin seam over axios so the whole Xero stack can be exercised in tests by
// mocking this one module. Never throws on HTTP status — callers decide.

const axios = require("axios");

const send = (config) =>
  axios.request({ validateStatus: () => true, timeout: 30_000, ...config });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { send, sleep };
