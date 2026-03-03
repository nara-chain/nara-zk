use crate::poseidon;

pub const MERKLE_TREE_LEVELS: usize = 64;
pub const ROOT_HISTORY_SIZE: usize = 30;

pub const DENOMINATIONS: [u64; 4] = [
    1_000_000_000,          // 1 SOL
    10_000_000_000,         // 10 SOL
    100_000_000_000,        // 100 SOL
    1_000_000_000_000,      // 1000 SOL
];

pub const INBOX_SIZE: usize = 64; // bytemuck supports array sizes up to powers of 2

/// zero_value[0] = [0u8; 32], zero_value[i] = Poseidon(z[i-1], z[i-1])
pub fn zero_value(level: usize) -> [u8; 32] {
    let mut current = [0u8; 32];
    for _ in 0..level {
        current = poseidon::hash_pair(&current, &current)
            .expect("poseidon hash failed in zero_value");
    }
    current
}
