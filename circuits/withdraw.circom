pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// ─── Incremental Merkle-tree proof checker ───────────────────────────────────
// Mirrors the on-chain MerkleTreeAccount logic exactly:
//   filled_subtrees tracks the last left sibling at each level.
//   For a given leaf at `index`, each bit of `index` selects left/right.
template MerkleProof(levels) {
    signal input  leaf;
    signal input  pathElements[levels];   // sibling hashes, bottom-up
    signal input  pathIndices[levels];    // 0 = current node is left, 1 = right

    signal output root;

    component hashers[levels];
    component mux[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // Select (left, right) based on the path bit
        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== levelHashes[i];   // current is left
        mux[i].c[0][1] <== pathElements[i];  // sibling is right
        mux[i].c[1][0] <== pathElements[i];  // sibling is left
        mux[i].c[1][1] <== levelHashes[i];   // current is right
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        levelHashes[i + 1] <== hashers[i].out;
    }

    root <== levelHashes[levels];
}

// ─── Withdraw circuit ────────────────────────────────────────────────────────
// Proves:
//   1. idCommitment  = Poseidon(idSecret)
//   2. leaf          = Poseidon(idCommitment, depositIndex)
//   3. MerkleProof(leaf, pathElements, pathIndices) == root
//   4. nullifierHash = Poseidon(idSecret, depositIndex)
//   5. recipient is committed (prevents fee-relay front-running)
template Withdraw(levels) {
    // ── private inputs ──────────────────────────────────────────────────────
    signal input idSecret;
    signal input depositIndex;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // ── public inputs ───────────────────────────────────────────────────────
    signal input root;
    signal input nullifierHash;
    signal input recipient;

    // 1. idCommitment = Poseidon(idSecret)
    component commitHasher = Poseidon(1);
    commitHasher.inputs[0] <== idSecret;
    signal idCommitment <== commitHasher.out;

    // 2. leaf = Poseidon(idCommitment, depositIndex)
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== idCommitment;
    leafHasher.inputs[1] <== depositIndex;
    signal leaf <== leafHasher.out;

    // 3. Verify Merkle proof
    component merkle = MerkleProof(levels);
    merkle.leaf <== leaf;
    for (var i = 0; i < levels; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i]  <== pathIndices[i];
    }
    root === merkle.root;

    // 4. nullifierHash = Poseidon(idSecret, depositIndex)
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== idSecret;
    nullifierHasher.inputs[1] <== depositIndex;
    nullifierHash === nullifierHasher.out;

    // 5. Bind recipient — forces prover to commit to a specific withdrawal address.
    //    Prevents a relayer from replacing the recipient after receiving the proof.
    signal recipientSquare <== recipient * recipient;
}

// Depth must match MERKLE_TREE_LEVELS in the Rust program.
component main { public [root, nullifierHash, recipient] } = Withdraw(64);
