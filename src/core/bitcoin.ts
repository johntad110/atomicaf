import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as bitcoin from 'bitcoinjs-lib';
import { addPubKeys } from './adaptor.js';

// Network configuration (default to testnet)
const NETWORK = bitcoin.networks.testnet;

// BIP341 tagged hash for taproot
const TAPROOT_TWEAK_PREFIX = 'TapTweak';

export class BitcoinTaproot {
    /**
     * Creates a Pay-to-Taproot (P2TR) address from a public key
     * Implements BIP341 specification for Taproot addresses
     */
    static createP2TRAddress(publicKey: Uint8Array, merkleRoot?: Uint8Array): {
        address: string;
        outputScript: Uint8Array;
        tweakedPubkey: Uint8Array;
    } {
        // Convert to x-only public key (32 bytes, drops Y coordinate)
        const xOnlyPubkey = publicKey.slice(1, 33); // Skip 0x02/0x03 prefix

        // Compute taproot tweak
        let tweakedKey: Uint8Array;
        if (merkleRoot) {
            // If merkle root provided, create tagged hash
            const tagHash = sha256(Buffer.concat([
                Buffer.from(TAPROOT_TWEAK_PREFIX),
                Buffer.from(xOnlyPubkey),
                Buffer.from(merkleRoot)
            ])).buffer;
            // Apply tweak to internal key
            const tweakResult = secp256k1.ProjectivePoint.fromHex(Buffer.from(xOnlyPubkey).toString('hex'))
                .add(secp256k1.ProjectivePoint.fromPrivateKey(new Uint8Array(tagHash)));
            tweakedKey = Buffer.from(tweakResult.toRawBytes(true)); // Convert to x-only
        } else {
            tweakedKey = Buffer.from(xOnlyPubkey);
        }

        // Create P2TR payment with tweaked key
        const p2tr = bitcoin.payments.p2tr({
            internalPubkey: Buffer.from(xOnlyPubkey),
            network: NETWORK
        });

        if (!p2tr.address || !p2tr.output) {
            throw new Error("Failed to create Taproot address");
        }

        return {
            address: p2tr.address,
            outputScript: p2tr.output,
            tweakedPubkey: tweakedKey
        };
    }

    /**
     * Creates a locking transaction to a Taproot address
     */
    static createLockingTransaction(
        buyerPubKey: Uint8Array,
        amount: number,
        prevTxId: string,
        prevOutputIndex: number
    ): {
        tx: bitcoin.Transaction;
        outputScript: Uint8Array;
    } {
        const tx = new bitcoin.Transaction();

        // Add input (spending previous UTXO)
        tx.addInput(Buffer.from(hexToBytes(prevTxId)).reverse(), prevOutputIndex);
        // Create Taproot output
        const { outputScript } = this.createP2TRAddress(buyerPubKey);
        tx.addOutput(Buffer.from(outputScript), amount);

        return { tx, outputScript };
    }

    /**
     * Creates a spending transaction from a Taproot output
     */
    static createSpendingTransaction(
        prevTxId: string,
        prevOutputIndex: number,
        prevOutputValue: number,
        prevOutputScript: Uint8Array,
        fee: number,
        signerPrivKey: Uint8Array,
        newOutputPubKey: Uint8Array,
        merkleProof?: { path: Uint8Array[]; position: number[] }
    ): {
        tx: bitcoin.Transaction;
        outputScript: Uint8Array;
    } {
        const tx = new bitcoin.Transaction();
        const outputAmount = prevOutputValue - fee;

        if (outputAmount <= 0) {
            throw new Error(`Fee too high: ${fee}, exceeds amount: ${prevOutputValue}`);
        }

        // Add input
        const reversedTxId = Buffer.from(hexToBytes(prevTxId)).reverse();
        tx.addInput(reversedTxId, prevOutputIndex);

        // Create new Taproot output
        const { outputScript, tweakedPubkey } = this.createP2TRAddress(newOutputPubKey);
        tx.addOutput(Buffer.from(outputScript), outputAmount);

        // Compute sighash for Taproot input
        const prevOutputScriptBuffer = Buffer.from(prevOutputScript);
        const sigHash = tx.hashForWitnessV1(
            0, // input index
            [prevOutputScriptBuffer],
            [prevOutputValue],
            bitcoin.Transaction.SIGHASH_DEFAULT
        );

        // Sign with tweaked private key
        const tweakHash = sha256(Buffer.concat([
            Buffer.from(TAPROOT_TWEAK_PREFIX),
            Buffer.from(tweakedPubkey)
        ]));

        // Convert private key and tweak to bigints
        const privKeyBigInt = BigInt('0x' + Buffer.from(signerPrivKey).toString('hex'));
        const tweakBigInt = BigInt('0x' + Buffer.from(tweakHash).toString('hex'));
        const n = secp256k1.CURVE.n;

        // Calculate tweaked private key
        const tweakedPrivKey = ((privKeyBigInt % n) + (tweakBigInt % n)) % n;

        // Sign the hash
        const signature = secp256k1.sign(sigHash, tweakedPrivKey);
        const signatureBytes = signature.toCompactRawBytes();

        // Set witness data
        const witness = [Buffer.from(signatureBytes)];
        if (merkleProof) {
            // Add script path spending data if provided
            witness.push(...merkleProof.path.map(p => Buffer.from(p)));
        }
        tx.setWitness(0, witness);

        return { tx, outputScript };
    }

    /**
     * Creates a Taproot script locked to a Nostr signature
     */
    static async createNostrSignatureLockScript(
        nostrPubKey: Uint8Array,
        commitment: Uint8Array
    ): Promise<{
        address: string;
        outputScript: Uint8Array;
        tweakedPubkey: Uint8Array;
    }> {
        // Combine keys using proper EC addition
        const combinedKey = await addPubKeys(nostrPubKey, commitment);
        
        // Create merkle root for script path spending
        const scriptRoot = sha256(Buffer.concat([
            Buffer.from('NostrLock'),
            Buffer.from(combinedKey)
        ]));
        
        return this.createP2TRAddress(nostrPubKey, scriptRoot);
    }
}