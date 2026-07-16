import os
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.backends import default_backend
from .config import config
from .logger import logger

ENCRYPTION_PASSWORD = config.encryption.password

if not ENCRYPTION_PASSWORD:
    logger.warning('VAULT_ENCRYPTION_PASSWORD not set; vault will be stored in plain text.')

def _derive_key(password, salt=b'salt'):
    kdf = Scrypt(
        salt=salt,
        length=32,
        n=2**14,
        r=8,
        p=1,
        backend=default_backend()
    )
    return kdf.derive(password.encode('utf-8'))

def encrypt(text):
    if not ENCRYPTION_PASSWORD:
        return f"plain:{text}"
    key = _derive_key(ENCRYPTION_PASSWORD)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ct = aesgcm.encrypt(nonce, text.encode('utf-8'), None)
    # Python format: enc:nonce_base64:ct_base64 (ct includes tag)
    return f"enc:{base64.b64encode(nonce).decode('utf-8')}:{base64.b64encode(ct).decode('utf-8')}"

def decrypt(encrypted_text):
    if not ENCRYPTION_PASSWORD:
        if encrypted_text.startswith('plain:'):
            return encrypted_text[6:]
        return encrypted_text
    if encrypted_text.startswith('plain:'):
        return encrypted_text[6:]
    if not encrypted_text.startswith('enc:'):
        return encrypted_text

    # Remove the "enc:" prefix
    payload = encrypted_text[4:]
    parts = payload.split(':')

    # Node.js format (3 parts): ivHex : tagHex : encryptedHex
    if len(parts) == 3:
        iv_hex, tag_hex, cipher_hex = parts
        iv = bytes.fromhex(iv_hex)
        tag = bytes.fromhex(tag_hex)
        ciphertext = bytes.fromhex(cipher_hex)
        key = _derive_key(ENCRYPTION_PASSWORD)
        # Use AESGCM from cryptography (nonce + ciphertext + tag)
        # We need to reconstruct the full ciphertext+tag for AESGCM.decrypt
        # AESGCM.decrypt expects (nonce, ciphertext_with_tag, associated_data)
        # So we concatenate ciphertext and tag
        ct_with_tag = ciphertext + tag
        aesgcm = AESGCM(key)
        try:
            plaintext = aesgcm.decrypt(iv, ct_with_tag, None)
            return plaintext.decode('utf-8')
        except Exception as e:
            logger.error(f"Node format decryption failed: {e}")
            raise

    # Python format (2 parts): nonce_base64 : ct_base64 (ct includes tag)
    elif len(parts) == 2:
        nonce_b64, ct_b64 = parts
        nonce = base64.b64decode(nonce_b64)
        ct = base64.b64decode(ct_b64)  # includes tag
        key = _derive_key(ENCRYPTION_PASSWORD)
        aesgcm = AESGCM(key)
        try:
            plaintext = aesgcm.decrypt(nonce, ct, None)
            return plaintext.decode('utf-8')
        except Exception as e:
            logger.error(f"Python format decryption failed: {e}")
            raise

    else:
        raise ValueError(f"Invalid encrypted format: {len(parts)} parts")