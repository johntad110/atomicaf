import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { Event, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';

export class NostrHandler {
  /**
   * Generates a new Nostr private key
   */
  static generatePrivateKey(): Uint8Array {
    return schnorr.utils.randomPrivateKey();
  }

  /**
   * Derives public key from private key
   */
  static getPublicKey(privateKey: Uint8Array): string {
    return getPublicKey(privateKey);
  }

  /**
   * Creates and signs a Nostr event
   */
  static createSignedEvent(privateKey: Uint8Array, content: string): Event {
    const eventTemplate = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
      pubkey: this.getPublicKey(privateKey)
    };

    return finalizeEvent(eventTemplate, privateKey);
  }

  /**
   * Extracts secret from Nostr signature
   */
  static extractSecretFromSignature(sig: string): Uint8Array {
    const sigBytes = hexToBytes(sig);
    if (sigBytes.length < 64) {
      throw new Error("Invalid signature length");
    }
    
    // Extract s value (second 32 bytes)
    return sigBytes.slice(32, 64);
  }

  // Helper to generate event hash (simplified)
  static verifyEvent(event: Event): boolean {
    return verifyEvent(event);
  }
}