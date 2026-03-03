use anchor_lang::prelude::*;

/// Program config. PDA seeds: ["config"]
/// Stores admin, fee recipient, and registration fee amount.
#[account]
pub struct ConfigAccount {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_amount: u64, // lamports; 0 = free registration
    pub bump: u8,
}
impl ConfigAccount {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1;
    pub const DEFAULT_FEE: u64 = 1_000_000_000; // 1 SOL
}
