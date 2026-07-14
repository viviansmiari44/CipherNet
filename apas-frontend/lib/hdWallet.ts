import { ethers } from 'ethers';
import { createHash } from 'node:crypto';

const MNEMONIC = process.env.HD_WALLET_MNEMONIC;

if (!MNEMONIC) {
  console.warn('HD_WALLET_MNEMONIC not set – deposit addresses will not be generated.');
}

function deriveIndex(userId: string): number {
  const hash = createHash('sha256').update(userId).digest('hex');
  const fullInt = parseInt(hash.slice(0, 8), 16);
  // Force the index to be under 2^31 (0x80000000) for unhardened paths
  return fullInt & 0x7fffffff; 
}

export function getDepositAddress(userId: string): string {
  if (!MNEMONIC) {
    throw new Error('HD_WALLET_MNEMONIC not set');
  }
  
  const index = deriveIndex(userId);
  const derivationPath = `m/44'/60'/0'/0/${index}`;
  
  // FIX: Pass the derivation path directly into the creation method
  const mnemonicObj = ethers.Mnemonic.fromPhrase(MNEMONIC);
  const wallet = ethers.HDNodeWallet.fromMnemonic(mnemonicObj, derivationPath);
  
  return wallet.address;
}

export function getDepositPrivateKey(userId: string): string {
  if (!MNEMONIC) {
    throw new Error('HD_WALLET_MNEMONIC not set');
  }
  
  const index = deriveIndex(userId);
  const derivationPath = `m/44'/60'/0'/0/${index}`;
  
  // FIX: Pass the derivation path directly into the creation method
  const mnemonicObj = ethers.Mnemonic.fromPhrase(MNEMONIC);
  const wallet = ethers.HDNodeWallet.fromMnemonic(mnemonicObj, derivationPath);
  
  return wallet.privateKey;
}