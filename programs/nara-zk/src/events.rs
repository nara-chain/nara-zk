use anchor_lang::prelude::*;

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
