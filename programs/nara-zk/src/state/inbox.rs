use anchor_lang::prelude::*;

use crate::constants::INBOX_SIZE;

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
    pub const SIZE: usize = 8 + 8; // = 16 bytes
}
