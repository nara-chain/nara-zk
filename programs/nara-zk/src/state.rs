use anchor_lang::prelude::*;
use crate::constants::{MERKLE_TREE_LEVELS, ROOT_HISTORY_SIZE, INBOX_SIZE};

/// ZK ID. PDA seeds: ["zk_id", name_hash]
#[account]
pub struct ZkIdAccount {
    pub name_hash: [u8; 32],
    pub id_commitment: [u8; 32],
    pub deposit_count: u32,
    pub commitment_start_index: u32,
    pub bump: u8,
}
impl ZkIdAccount {
    pub const SIZE: usize = 8 + 32 + 32 + 4 + 4 + 1;
}

/// Inbox ring buffer. PDA seeds: ["inbox", name_hash]
/// Zero-copy. INBOX_SIZE = 64 (power of 2 for bytemuck compatibility).
/// Layout: entries(64×16=1024) + head(1) + count(1) + bump(1) + _pad(5) = 1032 bytes
#[account(zero_copy)]
#[repr(C)]
pub struct InboxAccount {
    pub entries: [InboxEntry; INBOX_SIZE],
    pub head: u8,
    pub count: u8,
    pub bump: u8,
    pub _pad: [u8; 5],
}
impl InboxAccount {
    pub const SIZE: usize = 8 + InboxEntry::SIZE * INBOX_SIZE + 1 + 1 + 1 + 5;

    pub fn push(&mut self, leaf_index: u64, denomination: u64) {
        let idx = self.head as usize;
        self.entries[idx] = InboxEntry { leaf_index, denomination };
        self.head = ((self.head as usize + 1) % INBOX_SIZE) as u8;
        if (self.count as usize) < INBOX_SIZE {
            self.count += 1;
        }
    }
}

#[zero_copy]
#[repr(C)]
pub struct InboxEntry {
    pub leaf_index: u64,  // u64 matches MerkleTreeAccount.next_index; 16B total, no padding needed
    pub denomination: u64,
}
impl Default for InboxEntry {
    fn default() -> Self {
        Self { leaf_index: 0, denomination: 0 }
    }
}
impl InboxEntry {
    pub const SIZE: usize = 8 + 8; // = 16 bytes (unchanged)
}

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

/// Pool: program-owned SOL vault. PDA seeds: ["pool", denomination_le_bytes]
#[account]
pub struct PoolAccount {
    pub denomination: u64,
    pub bump: u8,
}
impl PoolAccount {
    pub const SIZE: usize = 8 + 8 + 1;
}

/// Nullifier marker. PDA seeds: ["nullifier", denomination_le_bytes, nullifier_hash]
#[account]
pub struct NullifierAccount {
    pub bump: u8,
}
impl NullifierAccount {
    pub const SIZE: usize = 8 + 1;
}
