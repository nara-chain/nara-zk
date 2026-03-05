use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::DENOMINATIONS;
use crate::errors::NaraZkError;
use crate::events::DepositEvent;
use crate::poseidon;
use crate::state::{InboxAccount, MerkleTreeAccount, PoolAccount, ZkIdAccount};

pub(crate) fn handle(
    ctx: Context<Deposit>,
    name_hash: [u8; 32],
    denomination: u64,
) -> Result<()> {
    require!(DENOMINATIONS.contains(&denomination), NaraZkError::InvalidDenomination);

    let deposit_index;
    let id_commitment;
    {
        let zk_id = &ctx.accounts.zk_id;
        require!(ctx.accounts.merkle_tree.load()?.denomination == denomination, NaraZkError::InvalidDenomination);
        deposit_index = zk_id.deposit_count;
        id_commitment = zk_id.id_commitment;
    }

    // leaf = Poseidon(id_commitment, deposit_index_as_32bytes)
    // Big-endian in the last 4 bytes so the 32-byte array represents
    // the field element `deposit_index`, matching the circuit's depositIndex signal.
    let mut index_bytes = [0u8; 32];
    index_bytes[28..].copy_from_slice(&deposit_index.to_be_bytes());
    let leaf = poseidon::hash_pair(&id_commitment, &index_bytes)?;

    // Transfer SOL: depositor → pool
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.pool.to_account_info(),
            },
        ),
        denomination,
    )?;

    let leaf_index = ctx.accounts.merkle_tree.load_mut()?.insert(leaf)?;

    ctx.accounts.zk_id.deposit_count = deposit_index + 1;
    ctx.accounts.inbox.load_mut()?.push(leaf_index, denomination);

    emit!(DepositEvent { name_hash, leaf_index, denomination });
    msg!("Deposit: leaf_index={}", leaf_index);
    Ok(())
}

#[derive(Accounts)]
#[instruction(name_hash: [u8; 32], denomination: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(mut, seeds = [b"zk_id", name_hash.as_ref()], bump)]
    pub zk_id: Account<'info, ZkIdAccount>,

    #[account(mut, seeds = [b"inbox", name_hash.as_ref()], bump)]
    pub inbox: AccountLoader<'info, InboxAccount>,

    #[account(
        mut,
        seeds = [b"tree", denomination.to_le_bytes().as_ref()],
        bump,
    )]
    pub merkle_tree: AccountLoader<'info, MerkleTreeAccount>,

    #[account(
        mut,
        seeds = [b"pool", denomination.to_le_bytes().as_ref()],
        bump,
    )]
    pub pool: Account<'info, PoolAccount>,

    pub system_program: Program<'info, System>,
}
