use anchor_lang::prelude::*;
use crate::constants::{MERKLE_TREE_LEVELS, ROOT_HISTORY_SIZE};
use crate::errors::NaraZkError;
use crate::poseidon;
use crate::state::MerkleTreeAccount;

impl MerkleTreeAccount {
    pub fn init(&mut self, denomination: u64) {
        self.levels = MERKLE_TREE_LEVELS as u32;
        self.denomination = denomination;
        self.next_index = 0;
        self.current_root_index = 0;

        // Compute zero values INCREMENTALLY — only LEVELS hash calls total.
        //   zeros[0] = [0u8; 32]          (empty leaf)
        //   zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
        //
        // The old approach called zero_value(i) per level (i hashes each),
        // costing sum(0..LEVELS) = LEVELS*(LEVELS+1)/2 = 2080 hashes for depth 64.
        // This approach costs exactly LEVELS = 64 hashes regardless of depth.
        let mut z = [0u8; 32];
        for i in 0..MERKLE_TREE_LEVELS {
            self.zeros[i] = z;
            self.filled_subtrees[i] = z;
            z = poseidon::hash_pair(&z, &z).expect("poseidon failed in init");
        }
        // z is now the root hash of a fully empty tree.
        self.roots[0] = z;
    }

    pub fn insert(&mut self, leaf: [u8; 32]) -> Result<u64> {
        let next_index = self.next_index;
        // Use u128 to safely compute 1 << 64 without u64 overflow.
        require!(
            (next_index as u128) < (1u128 << MERKLE_TREE_LEVELS),
            NaraZkError::MerkleTreeFull
        );

        let mut current_hash = leaf;
        let mut current_index = next_index;

        for i in 0..MERKLE_TREE_LEVELS {
            let (left, right) = if current_index % 2 == 0 {
                // Left child: store it, pair with precomputed zero (no recomputation).
                self.filled_subtrees[i] = current_hash;
                (current_hash, self.zeros[i])
            } else {
                // Right child: pair with the stored left sibling.
                (self.filled_subtrees[i], current_hash)
            };
            current_hash = poseidon::hash_pair(&left, &right)?;
            current_index /= 2;
        }

        let new_root_idx = (self.current_root_index as usize + 1) % ROOT_HISTORY_SIZE;
        self.current_root_index = new_root_idx as u32;
        self.roots[new_root_idx] = current_hash;
        self.next_index = next_index + 1;
        Ok(next_index)
    }

    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        *root != [0u8; 32] && self.roots.iter().any(|r| r == root)
    }
}
