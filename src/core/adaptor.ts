import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha2';

// Error class for signature creation failures
export class SignatureCreationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SignatureCreationError';
    }
}

// TypeScript equivalent of the Signature struct
export interface AdaptorSignature {
    noncePoint: Uint8Array;  // R' = R + T
    s: bigint;               // s_a = k + e*x
    pubKey: Uint8Array;      // Public key P
    message: Uint8Array;      // Message m
}

// Helper function to add two public keys (EC point addition)
export async function addPubKeys(p1: Uint8Array, p2: Uint8Array): Promise<Uint8Array> {
    // Ensure points are in compressed format (33 bytes)
    const p1Hex = bytesToHex(p1);
    const p2Hex = bytesToHex(p2);
    const p1Compressed = p1.length === 32 ? '02' + p1Hex : p1Hex;
    const p2Compressed = p2.length === 32 ? '02' + p2Hex : p2Hex;
    
    // Convert bytes to curve points
    const point1 = secp256k1.ProjectivePoint.fromHex(p1Compressed);
    const point2 = secp256k1.ProjectivePoint.fromHex(p2Compressed);
    
    // Add points using curve's native addition
    const sum = point1.add(point2);
    
    // Convert back to compressed format bytes
    return hexToBytes(sum.toHex(true));
}

// Creates a new adaptor signature
export async function createAdaptorSignature(
    privateKey: Uint8Array,
    adaptorPoint: Uint8Array,
    message: Uint8Array
): Promise<AdaptorSignature> {
    // Generate random nonce k
    const k = schnorr.utils.randomPrivateKey();
    const R = schnorr.getPublicKey(k); // R = k*G

    // Calculate R' = R + T (adaptor nonce)
    const adaptorNonce = await addPubKeys(R, adaptorPoint);

    // Check if R'.Y is odd (BIP340 requires even Y for challenge)
    // Note: This is simplified - actual Y parity check needs full point decompression
    const negateK = false; // Placeholder - needs proper Y-coordinate check

    // Compute challenge e = H(R' || P || m)
    const P = schnorr.getPublicKey(privateKey);
    const e = await schnorrChallenge(adaptorNonce, P, message);

    // Convert values to bigints for calculations
    const kBigInt = BigInt('0x' + bytesToHex(k));
    const eBigInt = BigInt('0x' + bytesToHex(e));
    const xBigInt = BigInt('0x' + bytesToHex(privateKey));

    // s = k + e*d mod n
    let s = (kBigInt + eBigInt * xBigInt) % secp256k1.CURVE.n;

    // If R'.Y is odd, negate k per BIP340
    if (negateK) {
        s = (secp256k1.CURVE.n - s) % secp256k1.CURVE.n;
    }

    // Verify the adaptor signature (simplified)
    // In production, implement full verification as in Go code
    const signature: AdaptorSignature = {
        noncePoint: adaptorNonce,
        s,
        pubKey: P,
        message
    };

    if (!(await verifyAdaptorSignature(signature, adaptorPoint))) {
        throw new SignatureCreationError("Adaptor signature verification failed");
    }

    return signature;
}

// Verifies an adaptor signature
export async function verifyAdaptorSignature(
    sig: AdaptorSignature,
    adaptorPoint: Uint8Array
): Promise<boolean> {
    // Simplified verification - implement full BIP340 logic as in Go code
    try {
        // Recover R = R' - T
        const negT = await negatePoint(adaptorPoint);
        const R = await addPubKeys(sig.noncePoint, negT);

        // Compute challenge e
        const e = await schnorrChallenge(sig.noncePoint, sig.pubKey, sig.message);

        // Verify s*G = R + e*P
        // This is simplified - actual implementation needs full EC math
        return true; // Placeholder
    } catch (e) {
        return false;
    }
}

// Completes an adaptor signature with the secret
export function completeAdaptorSignature(
    sig: AdaptorSignature,
    secret: bigint
): bigint {
    // s' = s + t
    return (sig.s + secret) % secp256k1.CURVE.n;
}

// Extracts the secret from a completed signature
export function extractSecret(
    originalSig: AdaptorSignature,
    completedSig: bigint
): bigint {
    // t = s' - s
    return (completedSig - originalSig.s) % secp256k1.CURVE.n;
}

// Helper function to negate a point (T -> -T)
async function negatePoint(point: Uint8Array): Promise<Uint8Array> {
    // Simplified - actual implementation needs proper EC math
    throw new Error("Point negation not fully implemented");
}

// Computes the BIP340 Schnorr challenge e = hash(R || P || m)
async function schnorrChallenge(
    R: Uint8Array,
    P: Uint8Array,
    message: Uint8Array
): Promise<Uint8Array> {
    // Tagged hash as per BIP340
    const tag = 'BIP0340/challenge';
    const tagHash = sha256(Uint8Array.from(tag.split('').map(c => c.charCodeAt(0))));
    const tagHashAgain = sha256(tagHash);

    // Construct hash input: R || P || message
    const input = new Uint8Array([...R, ...P, ...message]);
    const hash = sha256(input);

    // Combine with tag hash
    const finalInput = new Uint8Array([...tagHashAgain, ...hash]);
    return sha256(finalInput);
}

// Generates a final Schnorr signature from completed adaptor signature
export function generateFinalSignature(
    noncePoint: Uint8Array,
    completedSig: bigint
): Uint8Array {
    // Apply BIP340 parity rules
    const sAdjusted = completedSig;
    // Note: Actual implementation needs Y-coordinate parity check

    // Serialize as R || s
    const signature = new Uint8Array(64);
    signature.set(noncePoint.slice(0, 32), 0); // R (x-coordinate only)
    signature.set(bigIntTo32Bytes(sAdjusted), 32); // s

    return signature;
}

// Helper to convert bigint to 32-byte array
function bigIntTo32Bytes(num: bigint): Uint8Array {
    const hex = num.toString(16).padStart(64, '0');
    return hexToBytes(hex);
}