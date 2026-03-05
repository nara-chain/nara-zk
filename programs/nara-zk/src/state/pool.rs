use anchor_lang::prelude::*;

/// Pool: program-owned SOL vault. PDA seeds: ["pool", denomination_le_bytes]
#[account]
#[derive(InitSpace)]
pub struct PoolAccount {
    pub denomination: u64,
}
impl PoolAccount {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}
