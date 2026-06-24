"use strict";

const crypto = require("crypto");

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";

/**
 * generatePassword — cryptographically random password from a safe character set.
 * Excludes visually ambiguous chars (0/O, 1/I/l).
 */
const generatePassword = (length = 10) =>
  Array.from(crypto.randomBytes(length))
    .map((b) => CHARS[b % CHARS.length])
    .join("");

module.exports = { generatePassword };
