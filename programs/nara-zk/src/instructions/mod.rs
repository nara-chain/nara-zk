pub mod deposit;
pub mod initialize;
pub mod initialize_config;
pub mod register;
pub mod transfer_zk_id;
pub mod update_config;
pub mod withdraw;

// Re-export context types so lib.rs can bring them into scope with `use instructions::*`
pub use deposit::Deposit;
pub use initialize::Initialize;
pub use initialize_config::InitializeConfig;
pub use register::Register;
pub use transfer_zk_id::TransferZkId;
pub use update_config::UpdateConfig;
pub use withdraw::Withdraw;
