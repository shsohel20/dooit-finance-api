// lib/encryption.js
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const SECRET_KEY = process.env.ENCRYPTION_KEY; // 32-char secret in .env.local
const KEY = Buffer.from(SECRET_KEY, "hex");

export function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag().toString("hex");
    return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decrypt(encryptedText) {
    const [iv, authTag, encrypted] = encryptedText.split(":");
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        KEY,
        Buffer.from(iv, "hex")
    );

    decipher.setAuthTag(Buffer.from(authTag, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}

export function hashForSearch(value) {
    return crypto
        .createHmac("sha256", process.env.SEARCH_HASH_SECRET)
        .update(value.toLowerCase())
        .digest("hex");
}