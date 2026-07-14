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
    # Combine nonce + ciphertext
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
    parts = encrypted_text[4:].split(':')
    if len(parts) != 2:
        raise ValueError('Invalid encrypted format')
    nonce_b64, ct_b64 = parts
    nonce = base64.b64decode(nonce_b64)
    ct = base64.b64decode(ct_b64)
    key = _derive_key(ENCRYPTION_PASSWORD)
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(nonce, ct, None)
    return plaintext.decode('utf-8')