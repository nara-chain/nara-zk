use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::NaraZkError;
use crate::state::ConfigAccount;

pub(crate) fn handle(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
    let vault_bump = ctx.bumps.fee_vault;
    let signer_seeds: &[&[u8]] = &[b"fee_vault", &[vault_bump]];

    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.fee_vault.to_account_info(),
                to: ctx.accounts.admin.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
    )?;

    msg!("Withdrew {} lamports from fee vault to admin", amount);
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump,
        constraint = config.load()?.admin == admin.key() @ NaraZkError::Unauthorized,
    )]
    pub config: AccountLoader<'info, ConfigAccount>,

    /// CHECK: fee vault PDA holds collected fees.
    #[account(
        mut,
        seeds = [b"fee_vault"],
        bump,
    )]
    pub fee_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
