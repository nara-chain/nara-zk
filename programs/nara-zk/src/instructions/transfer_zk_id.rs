use anchor_lang::prelude::*;

use crate::errors::NaraZkError;
use crate::events::TransferZkIdEvent;
use crate::state::ZkIdAccount;
use crate::verifier::verify_ownership_proof;

pub(crate) fn handle(
    ctx: Context<TransferZkId>,
    name_hash: [u8; 32],
    new_id_commitment: [u8; 32],
    ownership_proof: Vec<u8>,
) -> Result<()> {
    require!(ownership_proof.len() == 256, NaraZkError::InvalidProof);
    let proof_arr: [u8; 256] = ownership_proof.try_into().map_err(|_| error!(NaraZkError::InvalidProof))?;
    verify_ownership_proof(&proof_arr, &ctx.accounts.zk_id.id_commitment)?;

    ctx.accounts.zk_id.id_commitment = new_id_commitment;
    ctx.accounts.zk_id.commitment_start_index = ctx.accounts.zk_id.deposit_count;

    emit!(TransferZkIdEvent { name_hash });
    msg!("ZK ID transferred");
    Ok(())
}

#[derive(Accounts)]
#[instruction(name_hash: [u8; 32])]
pub struct TransferZkId<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [b"zk_id", name_hash.as_ref()], bump)]
    pub zk_id: Account<'info, ZkIdAccount>,
}
