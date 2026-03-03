use anchor_lang::prelude::*;

/// Pool: program-owned SOL vault. PDA seeds: ["pool", denomination_le_bytes]
#[account]
pub struct PoolAccount {
    pub denomination: u64,
    pub bump: u8,
}
impl PoolAccount {
    pub const SIZE: usize = 8 + 8 + 1;
}
