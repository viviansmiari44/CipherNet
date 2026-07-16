import os
import base64
import hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from .config import config
from .logger import logger

ENCRYPTION_PASSWORD = config.encryption.password

if not ENCRYPTION_PASSWORD:
    logger.warning('VAULT_ENCRYPTION_PASSWORD not set; vault will be stored in plain text.')

def _derive_key_scrypt(password, salt=b'salt'):
    """Derives a key using Scrypt KDF."""
    try:
        kdf = Scrypt(
            salt=salt,
            length=32,
            n=2**14,
            r=8,
            p=1,
            backend=default_backend()
        )
        return kdf.derive(password.encode('utf-8'))
    except Exception:
        return None

def encrypt(text):
    if not ENCRYPTION_PASSWORD:
        return f"plain:{text}"
    key = _derive_key_scrypt(ENCRYPTION_PASSWORD)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
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
    
    parts = encrypted_text[4:].split(':')
    
    # --- 1. Native Python 2-Part Base64 Format ---
    if len(parts) == 2:
        nonce_b64, ct_b64 = parts
        nonce = base64.b64decode(nonce_b64)
        ct = base64.b64decode(ct_b64)
        key = _derive_key_scrypt(ENCRYPTION_PASSWORD)
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(nonce, ct, None)
        return plaintext.decode('utf-8')
    
    # --- 2. Multi-Part Hex Format Matrix (Frontend Compatibility) ---
    elif len(parts) == 3:
        try:
            p1 = bytes.fromhex(parts[0])
            p2 = bytes.fromhex(parts[1])
            p3 = bytes.fromhex(parts[2])
        except ValueError:
            raise ValueError('Invalid encrypted format: 3 parts detected but values are not valid hex.')

        # Generate candidates for the encryption key based on common Node.js / Web3 practices
        pwd_bytes = ENCRYPTION_PASSWORD.encode('utf-8')
        key_candidates = [
            # Candidate A: Plain SHA-256 hash of the password (Extremely common in standard JS)
            hashlib.sha256(pwd_bytes).digest(),
            # Candidate B: Default Scrypt key derivation
            _derive_key_scrypt(ENCRYPTION_PASSWORD, salt=b'salt'),
            # Candidate C: Dynamic Scrypt key derivation (If Part 1 is a dynamic salt)
            _derive_key_scrypt(ENCRYPTION_PASSWORD, salt=p1),
            # Candidate D: Raw password string padded/truncated to 32 bytes
            pwd_bytes.ljust(32, b'\0')[:32]
        ]
        
        # Remove any None values from failed derivations
        key_candidates = [k for k in key_candidates if k is not None]

        # Cycle through every key derivation candidate against every cipher arrangement
        for key in key_candidates:
            
            # Strategy A: AES-GCM (p1 = IV, p2 = Tag, p3 = Ciphertext)
            try:
                aesgcm = AESGCM(key)
                plaintext = aesgcm.decrypt(p1, p3 + p2, None)
                return plaintext.decode('utf-8')
            except Exception:
                pass

            # Strategy B: AES-GCM (p1 = IV, p2 = Ciphertext, p3 = Tag)
            try:
                aesgcm = AESGCM(key)
                plaintext = aesgcm.decrypt(p1, p2 + p3, None)
                return plaintext.decode('utf-8')
            except Exception:
                pass

            # Strategy C: AES-GCM (p1 = Salt, p2 = IV, p3 = Ciphertext + Tag)
            try:
                aesgcm = AESGCM(key)
                plaintext = aesgcm.decrypt(p2, p3, None)
                return plaintext.decode('utf-8')
            except Exception:
                pass

            # Strategy D: AES-CBC (p1 = Salt, p2 = IV, p3 = Ciphertext)
            try:
                cipher = Cipher(algorithms.AES(key), modes.CBC(p2), backend=default_backend())
                decipher = cipher.decryptor()
                padded_plaintext = decipher.update(p3) + decipher.final()
                unpadder = padding.PKCS7(128).unpadder()
                plaintext = unpadder.update(padded_plaintext) + unpadder.final()
                return plaintext.decode('utf-8')
            except Exception:
                pass
                
            # Strategy E: AES-CBC (p1 = IV, p3 = Ciphertext, ignoring p2)
            try:
                cipher = Cipher(algorithms.AES(key), modes.CBC(p1), backend=default_backend())
                decipher = cipher.decryptor()
                padded_plaintext = decipher.update(p3) + decipher.final()
                unpadder = padding.PKCS7(128).unpadder()
                plaintext = unpadder.update(padded_plaintext) + unpadder.final()
                return plaintext.decode('utf-8')
            except Exception:
                pass

        raise ValueError('Decryption failed: Checked all key derivations and layout combinations. Verify your password matches your frontend .env string perfectly.')

    else:
        raise ValueError(f'Invalid encrypted format: Expected 2 or 3 parts, got {len(parts)}')