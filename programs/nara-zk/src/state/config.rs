use anchor_lang::prelude::*;

/// Program config. PDA seeds: ["config"]
/// Stores admin, fee vault address, and registration fee amount.
#[account(zero_copy)]
#[repr(C)]
pub struct ConfigAccount {
    pub admin: Pubkey,
    pub fee_vault: Pubkey, // PDA seeds: ["fee_vault"]
    pub fee_amount: u64,   // lamports; 0 = free registration
}
impl ConfigAccount {
    pub const SIZE: usize = 8 + std::mem::size_of::<Self>();
    pub const DEFAULT_FEE: u64 = 1_000_000_000; // 1 SOL
}
