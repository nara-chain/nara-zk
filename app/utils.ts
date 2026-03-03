import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { createHash } from "crypto";

export const PROGRAM_ID = new PublicKey(
  "Dp4Jb4fmfK1HHVzjMAnWumE5iLuzDsfc4VdRVL7XmY82"
);

/** Fixed denomination pools (lamports). */
export const DENOMINATIONS = {
  SOL_1: new BN("1000000000"),
  SOL_10: new BN("10000000000"),
  SOL_100: new BN("100000000000"),
  SOL_1000: new BN("1000000000000"),
};

/**
 * Compute the name_hash used as PDA seed.
 * nameHash("alice") = SHA256("nara-zk:alice")
 */
export function nameHash(name: string): Buffer {
  return createHash("sha256").update("nara-zk:" + name).digest();
}

/** denomination (BN) → little-endian 8-byte Buffer for PDA seeds. */
export function denomBuf(denomination: BN): Buffer {
  return Buffer.from(denomination.toArray("le", 8));
}

// ─── PDA finders ─────────────────────────────────────────────────────────────

export function findTreePda(
  denomination: BN,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tree"), denomBuf(denomination)],
    programId
  );
}

export function findPoolPda(
  denomination: BN,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), denomBuf(denomination)],
    programId
  );
}

export function findZkIdPda(
  hash: Buffer,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("zk_id"), hash],
    programId
  );
}

export function findInboxPda(
  hash: Buffer,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("inbox"), hash],
    programId
  );
}

export function findConfigPda(programId = PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
}

export function findNullifierPda(
  denomination: BN,
  nullifierHash: Buffer,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), denomBuf(denomination), nullifierHash],
    programId
  );
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** 256 zero bytes — accepted by the stubbed verifier in dev builds. */
export const STUB_PROOF: Buffer = Buffer.alloc(256, 0);

/**
 * Derive a deterministic test nullifier hash.
 * Each unique tag produces a unique nullifier so tests don't collide.
 */
export function testNullifier(tag: string): Buffer {
  return createHash("sha256").update("nullifier:" + tag).digest();
}

/**
 * Convert a 32-byte Buffer / Uint8Array to a number[] suitable for
 * Anchor's [u8; 32] parameters.
 */
export function toBytes32(buf: Buffer | Uint8Array): number[] {
  return Array.from(buf.slice(0, 32));
}
