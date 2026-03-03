pub mod deposit;
pub mod initialize;
pub mod register;
pub mod transfer_zk_id;
pub mod withdraw;

// Re-export context types so lib.rs can bring them into scope with `use instructions::*`
pub use deposit::Deposit;
pub use initialize::Initialize;
pub use register::Register;
pub use transfer_zk_id::TransferZkId;
pub use withdraw::Withdraw;
