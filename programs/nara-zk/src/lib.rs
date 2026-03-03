use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

pub mod constants;
pub mod errors;
pub mod merkle_tree;
pub mod poseidon;
pub mod state;
pub mod verifier;

use constants::DENOMINATIONS;
use errors::NaraZkError;
use state::*;
use verifier::{verify_ownership_proof, verify_withdraw_proof};

declare_id!("Dp4Jb4fmfK1HHVzjMAnWumE5iLuzDsfc4VdRVL7XmY82");

#[program]
pub mod nara_zk {
    use super::*;

    /// Initialize a pool for a fixed denomination.
    pub fn initialize(ctx: Context<Initialize>, denomination: u64) -> Result<()> {
        require!(DENOMINATIONS.contains(&denomination), NaraZkError::InvalidDenomination);

        ctx.accounts.pool.denomination = denomination;
        ctx.accounts.pool.bump = ctx.bumps.pool;

        let mut tree = ctx.accounts.merkle_tree.load_init()?;
        tree.init(denomination, ctx.bumps.merkle_tree);

        msg!("Initialized pool: {} lamports", denomination);
        Ok(())
    }

    /// Register a new ZK ID.
    pub fn register(
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

    /// Deposit fixed denomination SOL to a ZK ID.
    pub fn deposit(
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

    /// Withdraw SOL anonymously using a ZK proof.
    pub fn withdraw(
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

        ctx.accounts.nullifier.bump = ctx.bumps.nullifier;

        **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? -= denomination;
        **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += denomination;

        emit!(WithdrawEvent { nullifier_hash, denomination });
        msg!("Withdrawal successful");
        Ok(())
    }

    /// Transfer ZK ID ownership using a ZK ownership proof.
    pub fn transfer_zk_id(
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
}

// ─── Account contexts ─────────────────────────────────────────────────────────

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

    /// Pool is small (PoolAccount::SIZE = 17 bytes), safe to init in-transaction.
    #[account(
        init, payer = payer, space = PoolAccount::SIZE,
        seeds = [b"pool", denomination.to_le_bytes().as_ref()],
        bump,
    )]
    pub pool: Account<'info, PoolAccount>,

    pub system_program: Program<'info, System>,
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

#[derive(Accounts)]
#[instruction(name_hash: [u8; 32], denomination: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(mut, seeds = [b"zk_id", name_hash.as_ref()], bump = zk_id.bump)]
    pub zk_id: Account<'info, ZkIdAccount>,

    #[account(mut, seeds = [b"inbox", name_hash.as_ref()], bump = inbox.load()?.bump)]
    pub inbox: AccountLoader<'info, InboxAccount>,

    #[account(
        mut,
        seeds = [b"tree", denomination.to_le_bytes().as_ref()],
        bump = merkle_tree.load()?.bump,
    )]
    pub merkle_tree: AccountLoader<'info, MerkleTreeAccount>,

    #[account(
        mut,
        seeds = [b"pool", denomination.to_le_bytes().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, PoolAccount>,

    pub system_program: Program<'info, System>,
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
        bump = merkle_tree.load()?.bump,
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
        bump = pool.bump,
    )]
    pub pool: Account<'info, PoolAccount>,

    /// CHECK: Validated inside ZK proof via recipient public input
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(name_hash: [u8; 32])]
pub struct TransferZkId<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [b"zk_id", name_hash.as_ref()], bump = zk_id.bump)]
    pub zk_id: Account<'info, ZkIdAccount>,
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct DepositEvent {
    pub name_hash: [u8; 32],
    pub leaf_index: u64,
    pub denomination: u64,
}

#[event]
pub struct WithdrawEvent {
    pub nullifier_hash: [u8; 32],
    pub denomination: u64,
}

#[event]
pub struct TransferZkIdEvent {
    pub name_hash: [u8; 32],
}
