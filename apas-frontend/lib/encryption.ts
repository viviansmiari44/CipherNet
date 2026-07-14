// lib/encryption.ts
import crypto from 'node:crypto';

const ENCRYPTION_PASSWORD = process.env.VAULT_ENCRYPTION_PASSWORD;
const TAG_LENGTH = 16;

function deriveKey(password: string): Buffer {
  // 🔍 Debug: log the derived key prefix (first 8 bytes in hex)
  const key = crypto.scryptSync(password, 'salt', 32, { N: 16384, r: 8, p: 1 });
  console.log(`[deriveKey] Derived key prefix: ${key.subarray(0, 8).toString('hex')}`);
  return key;
}

export function encrypt(text: string): string {
  if (!ENCRYPTION_PASSWORD) {
    throw new Error('VAULT_ENCRYPTION_PASSWORD is not set');
  }
  const key = deriveKey(ENCRYPTION_PASSWORD);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
  if (!ENCRYPTION_PASSWORD) {
    throw new Error('VAULT_ENCRYPTION_PASSWORD is not set');
  }
  if (!encryptedText.startsWith('enc:')) return encryptedText;

  // 🔍 Debug: log the password prefix
  console.log(`[decrypt] Password (first 4 chars): ${ENCRYPTION_PASSWORD.substring(0, 4)}`);

  const payload = encryptedText.substring(4);
  const parts = payload.split(':');

  // --- Python format (2 parts): nonce_base64 : ct_base64 (ciphertext + tag) ---
  if (parts.length === 2) {
    const [nonceB64, ctB64] = parts;
    const nonce = Buffer.from(nonceB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');

    console.log('[decrypt] Python format:');
    console.log(`  nonce length: ${nonce.length} bytes`);
    console.log(`  ct length: ${ct.length} bytes`);

    // The tag is the last 16 bytes
    if (ct.length < TAG_LENGTH) {
      throw new Error('Ciphertext too short to contain tag');
    }
    const tag = ct.subarray(-TAG_LENGTH);
    const ciphertext = ct.subarray(0, -TAG_LENGTH);

    console.log(`  tag length: ${tag.length} bytes`);
    console.log(`  ciphertext length: ${ciphertext.length} bytes`);

    const key = deriveKey(ENCRYPTION_PASSWORD);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);

    const decryptedBuffer = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return decryptedBuffer.toString('utf8');
  }

  // --- Node format (3 parts): ivHex : tagHex : encryptedHex ---
  if (parts.length === 3) {
    const [ivHex, tagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const key = deriveKey(ENCRYPTION_PASSWORD);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decryptedBuffer = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    return decryptedBuffer.toString('utf8');
  }

  throw new Error(`Invalid encrypted format: ${parts.length} parts`);
}