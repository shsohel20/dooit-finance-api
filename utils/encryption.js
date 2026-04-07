// lib/encryption.js
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

// Lazy — resolved on first use so the module can be required before .env loads
let _key = null;
function getKey() {
  if (!_key) {
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY environment variable is not set");
    }
    _key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  }
  return _key;
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText) {
  const [iv, authTag, encrypted] = encryptedText.split(":");
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(iv, "hex")
  );

  decipher.setAuthTag(Buffer.from(authTag, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function hashForSearch(value) {
  return crypto
    .createHmac("sha256", process.env.SEARCH_HASH_SECRET)
    .update(value.toLowerCase())
    .digest("hex");
}

const fieldMeta = (type, secret = false) => ({
  type,
  isDataSecret: secret,
});

module.exports = { encrypt, decrypt, hashForSearch, fieldMeta };
