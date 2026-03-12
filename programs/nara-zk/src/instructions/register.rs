use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::state::{ConfigAccount, InboxAccount, ZkIdAccount};

pub(crate) fn handle(
    ctx: Context<Register>,
    name_hash: [u8; 32],
    id_commitment: [u8; 32],
) -> Result<()> {
    let fee = ctx.accounts.config.load()?.fee_amount;
    if fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.fee_vault.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    let zk_id = &mut ctx.accounts.zk_id;
    zk_id.name_hash = name_hash;
    zk_id.id_commitment = id_commitment;
    zk_id.deposit_count = 0;
    zk_id.commitment_start_index = 0;

    let mut inbox = ctx.accounts.inbox.load_init()?;
    inbox.head = 0;
    inbox.count = 0;

    msg!("Registered ZK ID, fee paid: {} lamports", fee);
    Ok(())
}

#[derive(Accounts)]
#[instruction(name_hash: [u8; 32])]
pub struct Register<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// ZkIdAccount is small, init in-transaction is fine.
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

    #[account(
        seeds = [b"config"],
        bump,
    )]
    pub config: AccountLoader<'info, ConfigAccount>,

    /// CHECK: fee vault PDA receives registration fees.
    #[account(
        mut,
        seeds = [b"fee_vault"],
        bump,
    )]
    pub fee_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
