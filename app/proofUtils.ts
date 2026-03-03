/**
 * ZK proof generation utilities.
 *
 * Converts snarkjs Groth16 proofs to the 256-byte packed format expected by
 * the groth16-solana on-chain verifier:
 *
 *   bytes   0.. 64  proof_a: G1 -A point (negated), big-endian uncompressed
 *   bytes  64..192  proof_b: G2  B point, big-endian [x.c1, x.c0, y.c1, y.c0]
 *   bytes 192..256  proof_c: G1  C point, big-endian uncompressed
 */
import path from "path";
import { buildPoseidon as _buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { PublicKey } from "@solana/web3.js";

// BN254 scalar field prime
const BN254_PRIME =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// Merkle tree depth (must match MERKLE_TREE_LEVELS in Rust)
const LEVELS = 64;

// Circuit artifact paths
const CIRCUITS_DIR = path.join(__dirname, "..", "circuits", "build");
const WITHDRAW_WASM = path.join(
  CIRCUITS_DIR,
  "withdraw",
  "withdraw_js",
  "withdraw.wasm"
);
const WITHDRAW_ZKEY = path.join(
  CIRCUITS_DIR,
  "withdraw",
  "withdraw_final.zkey"
);
const OWNERSHIP_WASM = path.join(
  CIRCUITS_DIR,
  "ownership",
  "ownership_js",
  "ownership.wasm"
);
const OWNERSHIP_ZKEY = path.join(
  CIRCUITS_DIR,
  "ownership",
  "ownership_final.zkey"
);

// ─── Internal helpers ─────────────────────────────────────────────────────────

function bigIntToBytes32BE(n: bigint): Buffer {
  if (n < 0n || n >= BN254_PRIME) {
    throw new Error(`bigint out of field range: ${n}`);
  }
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}

/** Convert 32-byte big-endian buffer to bigint. */
function bytes32ToBigInt(buf: Buffer | Uint8Array): bigint {
  return BigInt("0x" + Buffer.from(buf).toString("hex"));
}

/** Pack a snarkjs Groth16 proof into the 256-byte layout for groth16-solana. */
export function packProof(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): Buffer {
  const ax = BigInt(proof.pi_a[0]);
  const ay = BigInt(proof.pi_a[1]);
  const ay_neg = BN254_PRIME - ay; // negate y (standard G1 negation on BN254)

  const proofA = Buffer.concat([bigIntToBytes32BE(ax), bigIntToBytes32BE(ay_neg)]);

  // pi_b[0] = [x.c0, x.c1], pi_b[1] = [y.c0, y.c1]
  // Solana alt_bn128 pairing expects: [x.c1, x.c0, y.c1, y.c0]
  const proofB = Buffer.concat([
    bigIntToBytes32BE(BigInt(proof.pi_b[0][1])), // x.c1
    bigIntToBytes32BE(BigInt(proof.pi_b[0][0])), // x.c0
    bigIntToBytes32BE(BigInt(proof.pi_b[1][1])), // y.c1
    bigIntToBytes32BE(BigInt(proof.pi_b[1][0])), // y.c0
  ]);

  const proofC = Buffer.concat([
    bigIntToBytes32BE(BigInt(proof.pi_c[0])),
    bigIntToBytes32BE(BigInt(proof.pi_c[1])),
  ]);

  return Buffer.concat([proofA, proofB, proofC]); // 256 bytes
}

// ─── Poseidon singleton ────────────────────────────────────────────────────────

let _poseidon: any = null;

async function getPoseidon(): Promise<any> {
  if (!_poseidon) _poseidon = await _buildPoseidon();
  return _poseidon;
}

/** Poseidon hash of any number of field-element BigInts → BigInt result. */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const result = poseidon(inputs);
  return poseidon.F.toObject(result);
}

/**
 * Compute the precomputed empty-subtree hashes:
 *   zeros[0] = 0
 *   zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
 * These match the on-chain MerkleTreeAccount.zeros array.
 */
export async function computeZeros(): Promise<bigint[]> {
  const zeros: bigint[] = new Array(LEVELS);
  zeros[0] = 0n;
  for (let i = 1; i < LEVELS; i++) {
    zeros[i] = await poseidonHash([zeros[i - 1], zeros[i - 1]]);
  }
  return zeros;
}

// ─── Merkle path helpers ──────────────────────────────────────────────────────

/**
 * Build the Merkle proof (pathElements, pathIndices) for a given leaf.
 *
 * `leafIndex` — the 0-based index of the leaf in the tree.
 * `filledSubtrees` — the MerkleTreeAccount.filled_subtrees from chain,
 *                    each as a 32-byte big-endian buffer.
 * `zeros` — precomputed empty-subtree hashes (from computeZeros()).
 *
 * Returns the sibling hashes and bit indicators for the ZK circuit.
 */
export async function buildMerklePath(
  leafIndex: bigint,
  filledSubtrees: Buffer[],
  zeros: bigint[]
): Promise<{ pathElements: bigint[]; pathIndices: number[] }> {
  const pathElements: bigint[] = new Array(LEVELS);
  const pathIndices: number[] = new Array(LEVELS);

  let idx = leafIndex;
  for (let i = 0; i < LEVELS; i++) {
    const isRight = idx % 2n === 1n;
    if (isRight) {
      // Current leaf is the right child → left sibling is filled_subtrees[i]
      pathElements[i] = bytes32ToBigInt(filledSubtrees[i]);
    } else {
      // Current leaf is the left child → right sibling is zeros[i]
      pathElements[i] = zeros[i];
    }
    pathIndices[i] = isRight ? 1 : 0;
    idx = idx / 2n;
  }
  return { pathElements, pathIndices };
}

// ─── Proof generation ──────────────────────────────────────────────────────────

/**
 * Generate a random id_secret (BN254 field element).
 * Result is a BigInt in [1, BN254_PRIME).
 */
export function randomIdSecret(): bigint {
  // Use crypto-safe random bytes then reduce mod p.
  // 40 bytes = 320 bits → well above 254 bits, ensures uniform distribution.
  const { randomBytes } = require("crypto");
  const buf = randomBytes(40) as Buffer;
  const n = BigInt("0x" + buf.toString("hex"));
  return (n % (BN254_PRIME - 1n)) + 1n; // avoid 0
}

/**
 * Derive id_commitment = Poseidon(idSecret).
 * Returns a BigInt (BN254 field element).
 */
export async function computeIdCommitment(idSecret: bigint): Promise<bigint> {
  return poseidonHash([idSecret]);
}

/**
 * Convert an id_commitment BigInt to the 32-byte big-endian format
 * used for on-chain storage and Anchor parameters.
 */
export function commitmentToBytes(commitment: bigint): Buffer {
  return bigIntToBytes32BE(commitment);
}

/**
 * Generate a Solana pubkey that is a valid BN254 field element
 * (i.e. whose 32-byte representation as a big-endian integer is < BN254_PRIME).
 * Required because the withdraw circuit takes `recipient` as a field element.
 */
export function validRecipient(): { keypair: any; fieldElement: bigint } {
  const { Keypair } = require("@solana/web3.js");
  for (let i = 0; i < 1000; i++) {
    const keypair = Keypair.generate();
    const n = bytes32ToBigInt(Buffer.from(keypair.publicKey.toBytes()));
    if (n < BN254_PRIME) {
      return { keypair, fieldElement: n };
    }
  }
  throw new Error("Could not find valid recipient after 1000 tries");
}

/**
 * Generate a Groth16 withdraw proof.
 *
 * @param idSecret         - private id_secret (BigInt)
 * @param depositIndex     - personal deposit count for this ZK ID (used in leaf hash + nullifier)
 * @param leafIndex        - global Merkle tree position where the leaf was inserted
 * @param filledSubtrees   - on-chain filled_subtrees after the last deposit
 * @param zeros            - precomputed empty-subtree hashes
 * @param root             - on-chain Merkle root (32 bytes)
 * @param recipient        - recipient public key
 * @returns 256-byte packed proof + nullifierHash (32 bytes)
 */
export async function generateWithdrawProof(
  idSecret: bigint,
  depositIndex: bigint,
  leafIndex: bigint,
  filledSubtrees: Buffer[],
  zeros: bigint[],
  root: Buffer,
  recipient: PublicKey
): Promise<{ proof: Buffer; nullifierHash: Buffer }> {
  const { pathElements, pathIndices } = await buildMerklePath(
    leafIndex,
    filledSubtrees,
    zeros
  );

  const nullifierHash = await poseidonHash([idSecret, depositIndex]);
  const recipientField = bytes32ToBigInt(Buffer.from(recipient.toBytes()));
  if (recipientField >= BN254_PRIME) {
    throw new Error("Recipient pubkey >= BN254 field prime; use validRecipient()");
  }
  const rootField = bytes32ToBigInt(root);

  const input = {
    idSecret: idSecret.toString(),
    depositIndex: depositIndex.toString(),
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices: pathIndices.map((i) => i.toString()),
    root: rootField.toString(),
    nullifierHash: nullifierHash.toString(),
    recipient: recipientField.toString(),
  };

  const { proof } = await groth16.fullProve(input, WITHDRAW_WASM, WITHDRAW_ZKEY);
  return {
    proof: packProof(proof),
    nullifierHash: bigIntToBytes32BE(nullifierHash),
  };
}

/**
 * Generate a Groth16 ownership proof.
 *
 * @param idSecret      - private id_secret (BigInt)
 * @param idCommitment  - on-chain id_commitment (32 bytes, = Poseidon(idSecret))
 * @returns 256-byte packed proof
 */
export async function generateOwnershipProof(
  idSecret: bigint,
  idCommitment: Buffer
): Promise<Buffer> {
  const commitmentField = bytes32ToBigInt(idCommitment);

  const input = {
    idSecret: idSecret.toString(),
    idCommitment: commitmentField.toString(),
  };

  const { proof } = await groth16.fullProve(input, OWNERSHIP_WASM, OWNERSHIP_ZKEY);
  return packProof(proof);
}
