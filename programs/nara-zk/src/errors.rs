use anchor_lang::prelude::*;

#[error_code]
pub enum NaraZkError {
    #[msg("Merkle tree is full")]
    MerkleTreeFull,

    #[msg("Invalid denomination")]
    InvalidDenomination,

    #[msg("Unknown Merkle root")]
    UnknownRoot,

    #[msg("Nullifier has already been used")]
    NullifierAlreadyUsed,

    #[msg("Invalid ZK proof")]
    InvalidProof,

    #[msg("ZK ID already registered")]
    ZkIdAlreadyRegistered,

    #[msg("ZK ID not found")]
    ZkIdNotFound,

    #[msg("Ownership proof verification failed")]
    OwnershipProofFailed,

    #[msg("Poseidon hash computation failed")]
    PoseidonHashFailed,

    #[msg("Caller is not the program admin")]
    Unauthorized,

    #[msg("Fee recipient account does not match config")]
    InvalidFeeRecipient,
}
