use anchor_lang::prelude::*;

use crate::state::{InboxAccount, ZkIdAccount};

pub(crate) fn handle(
    ctx: Context<Register>,
    name_hash: [u8; 32],
    id_commitment: [u8; 32],
) -> Result<()> {
    let zk_id = &mut ctx.accounts.zk_id;
    zk_id.name_hash = name_hash;
    zk_id.id_commitment = id_commitment;
    zk_id.deposit_count = 0;
    zk_id.commitment_start_index = 0;
    zk_id.bump = ctx.bumps.zk_id;

    let mut inbox = ctx.accounts.inbox.load_init()?;
    inbox.head = 0;
    inbox.count = 0;
    inbox.bump = ctx.bumps.inbox;

    msg!("Registered ZK ID");
    Ok(())
}

#[derive(Accounts)]
#[instruction(name_hash: [u8; 32])]
pub struct Register<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// ZkIdAccount is small (81 bytes), init in-transaction is fine.
    #[account(
        init, payer = payer, space = ZkIdAccount::SIZE,
        seeds = [b"zk_id", name_hash.as_ref()],
        bump,
    )]
    pub zk_id: Account<'info, ZkIdAccount>,

    #[account(
        init, payer = payer, space = InboxAccount::SIZE,
        seeds = [b"inbox", name_hash.as_ref()],
        bump,
    )]
    pub inbox: AccountLoader<'info, InboxAccount>,

    pub system_program: Program<'info, System>,
}
