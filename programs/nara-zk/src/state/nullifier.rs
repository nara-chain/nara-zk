use anchor_lang::prelude::*;

/// Nullifier marker. PDA seeds: ["nullifier", denomination_le_bytes, nullifier_hash]
/// Empty account — existence alone proves the nullifier was used.
#[account]
#[derive(InitSpace)]
pub struct NullifierAccount {}
impl NullifierAccount {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}
