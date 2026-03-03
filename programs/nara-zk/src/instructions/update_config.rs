use anchor_lang::prelude::*;

use crate::errors::NaraZkError;
use crate::state::ConfigAccount;

pub(crate) fn handle(
    ctx: Context<UpdateConfig>,
    new_admin: Pubkey,
    new_fee_recipient: Pubkey,
    new_fee_amount: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = new_admin;
    config.fee_recipient = new_fee_recipient;
    config.fee_amount = new_fee_amount;

    msg!("Config updated, fee: {} lamports", new_fee_amount);
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ NaraZkError::Unauthorized,
    )]
    pub config: Account<'info, ConfigAccount>,
}
