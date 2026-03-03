use anchor_lang::prelude::*;

use crate::state::ConfigAccount;

pub(crate) fn handle(
    ctx: Context<InitializeConfig>,
    fee_recipient: Pubkey,
    fee_amount: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.fee_recipient = fee_recipient;
    config.fee_amount = fee_amount;
    config.bump = ctx.bumps.config;

    msg!("Config initialized, fee: {} lamports", fee_amount);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init, payer = admin, space = ConfigAccount::SIZE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ConfigAccount>,

    pub system_program: Program<'info, System>,
}
