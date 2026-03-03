use anchor_lang::prelude::*;

/// Nullifier marker. PDA seeds: ["nullifier", denomination_le_bytes, nullifier_hash]
#[account]
pub struct NullifierAccount {
    pub bump: u8,
}
impl NullifierAccount {
    pub const SIZE: usize = 8 + 1;
}
