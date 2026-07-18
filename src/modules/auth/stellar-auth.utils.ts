import * as crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

export function createStellarChallenge(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function verifyStellarSignature(wallet: string, signature: string, challenge: string): boolean {
  const keypair = Keypair.fromPublicKey(wallet);
  // Freighter and the README both provide base64-encoded signatures, so decode as base64.
  return keypair.verify(Buffer.from(challenge), Buffer.from(signature, 'base64'));
}
