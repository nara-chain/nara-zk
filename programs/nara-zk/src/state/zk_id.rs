use anchor_lang::prelude::*;

/// ZK ID. PDA seeds: ["zk_id", name_hash]
#[account]
#[derive(InitSpace)]
pub struct ZkIdAccount {
    pub name_hash: [u8; 32],
    pub id_commitment: [u8; 32],
    pub deposit_count: u32,
    pub commitment_start_index: u32,
}
impl ZkIdAccount {
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}
