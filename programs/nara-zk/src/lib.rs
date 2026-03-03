use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod merkle_tree;
pub mod poseidon;
pub mod state;
pub mod verifier;

// Re-export context structs and their generated __client_accounts_* modules
// so Anchor's #[program] macro can resolve them from the crate root.
pub use instructions::deposit::*;
pub use instructions::initialize::*;
pub use instructions::register::*;
pub use instructions::transfer_zk_id::*;
pub use instructions::withdraw::*;

declare_id!("Dp4Jb4fmfK1HHVzjMAnWumE5iLuzDsfc4VdRVL7XmY82");

#[program]
pub mod nara_zk {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, denomination: u64) -> Result<()> {
        instructions::initialize::handle(ctx, denomination)
    }

    pub fn register(
        ctx: Context<Register>,
        name_hash: [u8; 32],
        id_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::register::handle(ctx, name_hash, id_commitment)
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        name_hash: [u8; 32],
        denomination: u64,
    ) -> Result<()> {
        instructions::deposit::handle(ctx, name_hash, denomination)
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        proof: Vec<u8>,
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        recipient: Pubkey,
        denomination: u64,
    ) -> Result<()> {
        instructions::withdraw::handle(ctx, proof, root, nullifier_hash, recipient, denomination)
    }

    pub fn transfer_zk_id(
        ctx: Context<TransferZkId>,
        name_hash: [u8; 32],
        new_id_commitment: [u8; 32],
        ownership_proof: Vec<u8>,
    ) -> Result<()> {
        instructions::transfer_zk_id::handle(ctx, name_hash, new_id_commitment, ownership_proof)
    }
}
