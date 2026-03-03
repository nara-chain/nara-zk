pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

// ─── Ownership proof circuit ──────────────────────────────────────────────────
// Proves knowledge of idSecret such that Poseidon(idSecret) == idCommitment.
// Used by transfer_zk_id to authorise changing the on-chain id_commitment
// without revealing the secret or the owner's wallet address.
template OwnershipProof() {
    // ── private ──────────────────────────────────────────────────────────────
    signal input idSecret;

    // ── public ───────────────────────────────────────────────────────────────
    signal input idCommitment;   // current on-chain value

    component hasher = Poseidon(1);
    hasher.inputs[0] <== idSecret;
    idCommitment === hasher.out;
}

component main { public [idCommitment] } = OwnershipProof();
