use anchor_lang::prelude::*;

use crate::constants::{MERKLE_TREE_LEVELS, ROOT_HISTORY_SIZE};

/// Merkle tree. PDA seeds: ["tree", denomination_le_bytes]
/// Zero-copy — too large for stack.
/// Layout (offsets within struct data, after 8-byte discriminator):
///   0: levels(4), 4: current_root_index(4)
///   8: next_index(8, u64, 8-byte aligned ✓), 16: denomination(8)
///   24: bump(1), 25: _pad(7) → 32
///   32: filled_subtrees(64×32=2048) → 2080: roots(30×32=960) → 3040: zeros(64×32=2048)
///   Struct size: 5088 bytes (multiple of 8 ✓) → SIZE = 5096
///
/// `zeros[i]` = empty-subtree hash at level i, computed once in init() and
/// reused by insert() to avoid re-hashing on every deposit.
#[account(zero_copy)]
#[repr(C)]
pub struct MerkleTreeAccount {
    pub levels: u32,
    pub current_root_index: u32,
    pub next_index: u64,                             // u64: up to 2^64 leaves
    pub denomination: u64,
    pub bump: u8,
    pub _pad: [u8; 7],                               // 25 → 32 for array alignment
    pub filled_subtrees: [[u8; 32]; MERKLE_TREE_LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub zeros: [[u8; 32]; MERKLE_TREE_LEVELS],       // precomputed empty-subtree hashes
}
impl MerkleTreeAccount {
    pub const SIZE: usize = 8            // discriminator
        + 4 + 4                          // levels, current_root_index
        + 8 + 8                          // next_index (u64), denomination
        + 1 + 7                          // bump, pad
        + 32 * MERKLE_TREE_LEVELS        // filled_subtrees (64 × 32 = 2048)
        + 32 * ROOT_HISTORY_SIZE         // roots        (30 × 32 =  960)
        + 32 * MERKLE_TREE_LEVELS;       // zeros        (64 × 32 = 2048) → total 5096
}
