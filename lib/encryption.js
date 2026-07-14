import crypto from 'crypto';
import { config } from './config.js';
import logger from './logger.js';

const ENCRYPTION_PASSWORD = config.encryption.password;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

if (!ENCRYPTION_PASSWORD) {
  logger.warn('VAULT_ENCRYPTION_PASSWORD not set; vault will be stored in plain text.');
}

function _deriveKey(password) {
  return crypto.scryptSync(password, 'salt', 32);
}

export function encrypt(text) {
  if (!ENCRYPTION_PASSWORD) {
    return `plain:${text}`;
  }
  const key = _deriveKey(ENCRYPTION_PASSWORD);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  // Node format: enc:ivHex:tagHex:encryptedHex
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText) {
  if (!ENCRYPTION_PASSWORD) {
    if (encryptedText.startsWith('plain:')) {
      return encryptedText.substring(6);
    }
    return encryptedText;
  }
  if (encryptedText.startsWith('plain:')) {
    return encryptedText.substring(6);
  }
  if (!encryptedText.startsWith('enc:')) {
    return encryptedText; // fallback for plain text
  }

  const payload = encryptedText.substring(4);
  const parts = payload.split(':');

  // --- Format 1 (Node) : ivHex:tagHex:encryptedHex ---
  if (parts.length === 3) {
    const [ivHex, tagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const key = _deriveKey(ENCRYPTION_PASSWORD);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // --- Format 2 (Python) : nonce_b64:ct_b64 ---
  if (parts.length === 2) {
    const [nonceB64, ctB64] = parts;
    const nonce = Buffer.from(nonceB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const key = _deriveKey(ENCRYPTION_PASSWORD);
    // AESGCM.encrypt from cryptography appends the tag at the end
    const tag = ct.subarray(-TAG_LENGTH);
    const ciphertext = ct.subarray(0, -TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  throw new Error('Invalid encrypted format');
}