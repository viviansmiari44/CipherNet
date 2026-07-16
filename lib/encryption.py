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
    nonce = os.urandom(12)  # Use 12-byte nonce for consistency with Node? Actually Node uses 16, but we can align.
    ct = aesgcm.encrypt(nonce, text.encode('utf-8'), None)
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

    payload = encrypted_text[4:]
    parts = payload.split(':')

    # Node.js format: ivHex:tagHex:cipherHex
    if len(parts) == 3:
        iv_hex, tag_hex, cipher_hex = parts
        iv = bytes.fromhex(iv_hex)
        tag = bytes.fromhex(tag_hex)
        ciphertext = bytes.fromhex(cipher_hex)
        key = _derive_key(ENCRYPTION_PASSWORD)
        aesgcm = AESGCM(key)
        # AESGCM.decrypt expects nonce + (ciphertext + tag)
        ct_with_tag = ciphertext + tag
        try:
            plaintext = aesgcm.decrypt(iv, ct_with_tag, None)
            return plaintext.decode('utf-8')
        except Exception as e:
            logger.error(f"Node format decryption failed: {repr(e)}")
            raise

    # Python format: nonce_b64:ct_b64 (ct includes tag)
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
            logger.error(f"Python format decryption failed: {repr(e)}")
            raise

    else:
        raise ValueError(f"Invalid encrypted format: {len(parts)} parts")