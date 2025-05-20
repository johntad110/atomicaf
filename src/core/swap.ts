import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha2';
import * as bitcoin from 'bitcoinjs-lib';
import { Event } from 'nostr-tools';
import { AdaptorSignature, addPubKeys, completeAdaptorSignature, createAdaptorSignature, generateFinalSignature, verifyAdaptorSignature } from './adaptor.js';
import { BitcoinTaproot } from './bitcoin.js';
import { NostrHandler } from './nostr.js';

// Network configuration (default to testnet)
const NETWORK = bitcoin.networks.testnet;

export interface SwapParticipant {
  nostrPrivateKey?: string;
  bitcoinPrivateKey?: Uint8Array;
}

export class SwapSeller {
  private nostrPrivateKey: string;
  private bitcoinPrivateKey: Uint8Array;
  private bitcoinPublicKey: Uint8Array;
  public  nostrPublicKey: string;
  private event?: Event;
  private nonce?: Uint8Array;
  private commitment?: Uint8Array;

  constructor({ nostrPrivateKey }: SwapParticipant) {
    if (!nostrPrivateKey) throw new Error("Nostr private key required for seller");
    this.nostrPrivateKey = nostrPrivateKey;
    this.bitcoinPrivateKey = hexToBytes(nostrPrivateKey); // Using same key for demo
    this.bitcoinPublicKey = schnorr.getPublicKey(this.bitcoinPrivateKey);
    this.nostrPublicKey = NostrHandler.getPublicKey(this.bitcoinPrivateKey);
  }

  async createEvent(content: string): Promise<Event> {
    // Create and sign the Nostr event
    this.event = NostrHandler.createSignedEvent(this.bitcoinPrivateKey, content);
    
    if (!this.event.sig) throw new Error("Event signature missing");
    
    // Extract nonce from signature (simplified)
    const sigBytes = hexToBytes(this.event.sig);
    this.nonce = sigBytes.slice(0, 32); // First 32 bytes is R in Schnorr
    
    // Compute challenge e = H(R || P || m)
    const e = await this.computeChallenge();
    
    // Compute commitment T = R + e*P
    this.commitment = await this.computeCommitment(e);
    
    return this.event;
  }

  private async computeChallenge(): Promise<Uint8Array> {
    if (!this.event || !this.nonce) throw new Error("Event not initialized");
    
    // Simplified challenge computation
    const message = new TextEncoder().encode(this.event.id);
    const pubKeyX = this.bitcoinPublicKey.slice(1, 33); // x-only
    
    const hashInput = new Uint8Array([...this.nonce, ...pubKeyX, ...message]);
    return sha256(hashInput);
  }

  private async computeCommitment(e: Uint8Array): Promise<Uint8Array> {
    if (!this.nonce) throw new Error("Nonce not available");
    
    // Compute e*P
    const eP = schnorr.getPublicKey(e); // Simplified
    
    // T = R + e*P
    return addPubKeys(this.nonce, eP);
  }

  getCommitment(): Uint8Array {
    if (!this.commitment) throw new Error("Commitment not generated");
    return this.commitment;
  }
}

export class SwapBuyer {
  private bitcoinPrivateKey: Uint8Array;
  public bitcoinPublicKey: Uint8Array;
  private adaptorSig?: AdaptorSignature;
  private lockingTx?: bitcoin.Transaction;
  private sigHash?: Uint8Array;

  constructor() {
    // Generate new Bitcoin key pair
    this.bitcoinPrivateKey = schnorr.utils.randomPrivateKey();
    this.bitcoinPublicKey = schnorr.getPublicKey(this.bitcoinPrivateKey);
  }

  async createLockingTransaction(
    amount: number,
    prevTxId: string,
    prevOutputIndex: number,
    commitment?: Uint8Array
  ): Promise<bitcoin.Transaction> {
    if (commitment) {
      // Create transaction locked to Nostr signature
      return this.createNostrLockedTransaction(amount, prevTxId, prevOutputIndex, commitment);
    } else {
      // Regular Taproot lock
      const { tx } = BitcoinTaproot.createLockingTransaction(
        this.bitcoinPublicKey,
        amount,
        prevTxId,
        prevOutputIndex
      );
      this.lockingTx = tx;
      this.sigHash = this.computeSigHash(tx);
      return tx;
    }
  }

  private async createNostrLockedTransaction(
    amount: number,
    prevTxId: string,
    prevOutputIndex: number,
    commitment: Uint8Array
  ): Promise<bitcoin.Transaction> {
    // Create transaction with Nostr signature lock script
    const { outputScript, tweakedPubkey } = await BitcoinTaproot.createNostrSignatureLockScript(
      this.bitcoinPublicKey,
      commitment
    );

    const tx = new bitcoin.Transaction()
    
    // Add input and output
    tx.addInput(Buffer.from(hexToBytes(prevTxId)).reverse(), prevOutputIndex);
    tx.addOutput(Buffer.from(outputScript), amount);
    
    this.lockingTx = tx;
    this.sigHash = this.computeSigHash(tx, outputScript);
    return tx;
  }

  private computeSigHash(tx: bitcoin.Transaction, script?: Uint8Array): Uint8Array {
    // Simplified sighash calculation
    if (script) {
      return tx.hashForWitnessV1(0, [Buffer.from(script)], [tx.outs[0].value], bitcoin.Transaction.SIGHASH_DEFAULT);
    }
    return sha256(new TextEncoder().encode(tx.toHex()));
  }

  async createAdaptorSignature(commitment: Uint8Array): Promise<AdaptorSignature> {
    if (!this.sigHash) throw new Error("Transaction not initialized");
    
    this.adaptorSig = await createAdaptorSignature(
      this.bitcoinPrivateKey,
      commitment,
      this.sigHash
    );
    
    return this.adaptorSig;
  }

  async completeSwap(nostrSig: string): Promise<Uint8Array> {
    if (!this.adaptorSig) throw new Error("Adaptor signature not created");
    
    // Extract secret from Nostr signature
    const secretBytes = NostrHandler.extractSecretFromSignature(nostrSig);
    const secret = BigInt('0x' + bytesToHex(secretBytes));
    
    // Complete the adaptor signature and convert to Uint8Array
    const completedSig = completeAdaptorSignature(this.adaptorSig, secret);
    return generateFinalSignature(this.adaptorSig.noncePoint, completedSig);
  }
}

export class AtomicSwap {
  static async execute(): Promise<void> {
    console.log("Starting TANOS atomic swap...");
    
    // Initialize parties
    const seller = new SwapSeller({
      nostrPrivateKey: bytesToHex(schnorr.utils.randomPrivateKey())
    });
    
    const buyer = new SwapBuyer();
    
    // Seller creates the Nostr event
    const event = await seller.createEvent("Atomic swap offer: 0.1 BTC for this message");
    console.log("Seller created event:", event);
    
    // Verify the event signature
    if (!NostrHandler.verifyEvent(event)) {
      throw new Error("Invalid Nostr event signature");
    }
    
    // Buyer creates locking transaction
    const tx = await buyer.createLockingTransaction(
      100000, // 0.001 BTC in sats
      "previousTxIdHere", // Would be real UTXO in production
      0, // Output index
      seller.getCommitment()
    );
    console.log("Buyer created locking tx:", tx.toHex());
    
    // Buyer creates adaptor signature
    const adaptorSig = await buyer.createAdaptorSignature(seller.getCommitment());
    console.log("Buyer created adaptor signature:", adaptorSig);
    
    // Verify the adaptor signature
    if (!await verifyAdaptorSignature(adaptorSig, seller.getCommitment())) {
      throw new Error("Invalid adaptor signature");
    }
    
    // Seller completes the swap by revealing the Nostr signature
    const completedSig = await buyer.completeSwap(event.sig);
    console.log("Completed signature:", bytesToHex(completedSig));
    
    console.log("Swap protocol completed successfully");
  }
}