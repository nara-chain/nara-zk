use anchor_lang::prelude::*;

use crate::constants::DENOMINATIONS;
use crate::errors::NaraZkError;
use crate::state::{MerkleTreeAccount, PoolAccount};

pub(crate) fn handle(ctx: Context<Initialize>, denomination: u64) -> Result<()> {
    require!(DENOMINATIONS.contains(&denomination), NaraZkError::InvalidDenomination);

    ctx.accounts.pool.denomination = denomination;

    let mut tree = ctx.accounts.merkle_tree.load_init()?;
    tree.init(denomination);

    msg!("Initialized pool: {} lamports", denomination);
    Ok(())
}

#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init, payer = payer, space = MerkleTreeAccount::SIZE,
        seeds = [b"tree", denomination.to_le_bytes().as_ref()],
        bump,
    )]
    pub merkle_tree: AccountLoader<'info, MerkleTreeAccount>,

    /// Pool is small, safe to init in-transaction.
    #[account(
        init, payer = payer, space = PoolAccount::SIZE,
        seeds = [b"pool", denomination.to_le_bytes().as_ref()],
        bump,
    )]
    pub pool: Account<'info, PoolAccount>,

    pub system_program: Program<'info, System>,
}
