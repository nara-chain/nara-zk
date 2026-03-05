use anchor_lang::prelude::*;

use crate::constants::{MERKLE_TREE_LEVELS, ROOT_HISTORY_SIZE};

/// Merkle tree. PDA seeds: ["tree", denomination_le_bytes]
/// Zero-copy — too large for stack.
/// Layout (offsets within struct data, after 8-byte discriminator):
///   0: levels(4), 4: current_root_index(4)
///   8: next_index(8, u64, 8-byte aligned ✓), 16: denomination(8)
///   24: filled_subtrees → roots → zeros
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
    pub filled_subtrees: [[u8; 32]; MERKLE_TREE_LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub zeros: [[u8; 32]; MERKLE_TREE_LEVELS],       // precomputed empty-subtree hashes
}
impl MerkleTreeAccount {
    pub const SIZE: usize = 8 + std::mem::size_of::<Self>();
}
