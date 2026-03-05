use anchor_lang::prelude::*;

use crate::constants::DENOMINATIONS;
use crate::errors::NaraZkError;
use crate::events::WithdrawEvent;
use crate::state::{MerkleTreeAccount, NullifierAccount, PoolAccount};
use crate::verifier::verify_withdraw_proof;

pub(crate) fn handle(
    ctx: Context<Withdraw>,
    proof: Vec<u8>,
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    recipient: Pubkey,
    denomination: u64,
) -> Result<()> {
    require!(proof.len() == 256, NaraZkError::InvalidProof);
    require!(DENOMINATIONS.contains(&denomination), NaraZkError::InvalidDenomination);

    {
        let tree = ctx.accounts.merkle_tree.load()?;
        require!(tree.denomination == denomination, NaraZkError::InvalidDenomination);
        require!(tree.is_known_root(&root), NaraZkError::UnknownRoot);
    }

    let proof_arr: [u8; 256] = proof.try_into().map_err(|_| error!(NaraZkError::InvalidProof))?;
    verify_withdraw_proof(&proof_arr, &[root, nullifier_hash, recipient.to_bytes()])?;

    **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? -= denomination;
    **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += denomination;

    emit!(WithdrawEvent { nullifier_hash, denomination });
    msg!("Withdrawal successful");
    Ok(())
}

#[derive(Accounts)]
#[instruction(
    proof: Vec<u8>,
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    recipient: Pubkey,
    denomination: u64,
)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"tree", denomination.to_le_bytes().as_ref()],
        bump,
    )]
    pub merkle_tree: AccountLoader<'info, MerkleTreeAccount>,

    #[account(
        init, payer = payer, space = NullifierAccount::SIZE,
        seeds = [b"nullifier", denomination.to_le_bytes().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier: Account<'info, NullifierAccount>,

    #[account(
        mut,
        seeds = [b"pool", denomination.to_le_bytes().as_ref()],
        bump,
    )]
    pub pool: Account<'info, PoolAccount>,

    /// CHECK: Validated inside ZK proof via recipient public input
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
