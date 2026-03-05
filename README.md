# nara-zk

A named ZK anonymous transfer protocol on NARA. Users register a human-readable ZK ID (e.g. `"alice"`); anyone who knows the name can deposit funds to it, while the owner can withdraw anonymously — no on-chain link between the ZK ID and the withdrawal address is ever created.

**Program ID**: `ZKidentity111111111111111111111111111111111`
**Framework**: Anchor 0.32 · **Proof system**: Groth16 (BN254) · **Hash**: Poseidon

---

## Table of Contents

1. [What is a ZK ID?](#what-is-a-zk-id)
2. [Privacy Goals](#privacy-goals)
3. [Architecture Overview](#architecture-overview)
4. [Cryptographic Design](#cryptographic-design)
5. [ZK Circuits](#zk-circuits)
6. [On-Chain Implementation](#on-chain-implementation)
7. [Account Structure](#account-structure)
8. [Instructions](#instructions)
9. [Privacy Analysis](#privacy-analysis)
10. [File Structure](#file-structure)
11. [Development Guide](#development-guide)

---

## What is a ZK ID?

A **ZK ID** is a human-readable name (e.g. `"alice"`) that acts as a private, reusable receiving address — similar in spirit to ENS or SNS names, but with a fundamentally different privacy model.

### The Core Properties

| Property | Behaviour |
| -------- | --------- |
| **Named** | Anyone who knows the name `"alice"` can deposit SOL to it — no wallet address needed |
| **Private** | No on-chain link ever connects the name to the owner's wallet address |
| **Ownable** | Ownership is proven by knowledge of a cryptographic secret (`idSecret`), not by a signing key |
| **Transferable** | Ownership can be transferred to a new secret via a ZK proof — without revealing either secret |

### How It Works

```
  Name: "alice"
      │
      │  SHA-256("nara-zk:alice")
      ▼
  nameHash  ──────────────────────────────► stored on-chain (ZkIdAccount)
                                             anyone can deposit to this hash

  wallet.signMessage("nara-zk:idsecret:v1:alice")
      │
      │  SHA-256(signature)  →  mod BN254_PRIME
      ▼
  idSecret  (stays on your device; never transmitted)
      │
      │  Poseidon(idSecret)
      ▼
  idCommitment  ──────────────────────────► stored on-chain (ZkIdAccount)
                                             proves ownership without revealing idSecret
```

### Why Not Just Use a Wallet Address?

A regular wallet address is a permanent, linkable identity: every deposit to `alice.sol` is publicly connected to Alice's withdrawal address. A ZK ID breaks this link:

- **Deposit** only requires the name — the depositor never learns the owner's wallet.
- **Withdrawal** is submitted by any payer (e.g. a gas relayer) to any recipient address. The Groth16 proof convinces the program that the caller knows `idSecret` without revealing it or the owner's address.
- **Registration** can be submitted by a third-party relayer, so Alice's wallet address never even appears in the registration transaction.

### Lifecycle of a ZK ID

```
  1. Register   Alice derives idSecret locally, computes idCommitment,
                and asks a relayer to call register(nameHash, idCommitment).

  2. Receive    Bob calls deposit("alice", 1 SOL) — Alice's address is unknown to Bob.

  3. Withdraw   Alice generates a Groth16 proof off-chain and sends it to
                a relayer, which calls withdraw(..., recipient=AliceNewWallet).
                No on-chain record links "alice" to AliceNewWallet.

  4. Transfer   Alice can hand over ownership to a new idSecret (e.g. after
                a wallet compromise) by submitting an ownership ZK proof.
                The ZK ID name stays the same; the secret changes.
```

---

## Privacy Goals

| Scenario | Privacy Guarantee |
|----------|-------------------|
| ZK ID registration | Only the name hash is stored on-chain; any wallet (including a relayer) may submit the registration transaction |
| Deposit | Anyone who knows the name can deposit — no knowledge of the owner's address is required |
| Withdrawal | The transaction signer has no on-chain link to the ZK ID; the proof reveals nothing about `idSecret` |
| ZK ID transfer | Ownership change is authorized by a ZK proof alone — the owner's address is never exposed |

---

## Architecture Overview

### Data Flow

```
                  ┌──────────────────────────────────────────────┐
                  │  Off-chain (user device)                     │
                  │                                              │
                  │  wallet.signMessage(                         │
                  │    "nara-zk:idsecret:v1:{name}"              │
                  │  ) ──► sig (64 B) ──► SHA-256 ──► idSecret   │
                  │                                              │
                  │  idCommitment = Poseidon(idSecret)           │
                  │  nameHash     = SHA-256("nara-zk:" + name)   │
                  └───────────────┬──────────────────────────────┘
                                  │  only nameHash + idCommitment
                                  │  transmitted off-chain
                                  ▼
register(nameHash, idCommitment)  ←── any payer may submit

         ┌──────────────────┐   ┌──────────────────────┐
         │  ZkIdAccount     │   │  InboxAccount        │
         │  nameHash        │   │  ring buffer [64]    │
         │  idCommitment    │   │  (leafIndex, denom)  │
         │  depositCount    │   └──────────────────────┘
         │  commitStartIdx  │
         └──────────────────┘

deposit(nameHash, denom)  ←── anyone may call

  leaf = Poseidon(idCommitment, depositIndex)
         │
         ▼
  ┌──────────────────┐   ┌──────────────────────┐
  │  MerkleTree      │   │  PoolAccount         │
  │  64-level tree   │   │  SOL vault (PDA)     │
  │  roots[30]       │   └──────────────────────┘
  └──────────────────┘

withdraw(proof, root, nullifierHash, recipient, denom)  ←── any payer may submit

  Groth16 proof verified ──► NullifierAccount created ──► SOL sent to recipient
```

---

## Cryptographic Design

### Hash Function Selection

The protocol uses two hash functions for distinct roles:

| Role | Function | Rationale |
|------|----------|-----------|
| Name hashing, `idSecret` derivation | SHA-256 | Off-chain only; compatible with standard wallet signing APIs |
| Merkle tree, leaf commitment, nullifier, identity commitment | Poseidon | ZK-circuit-friendly (minimal constraints per call); native `solana-poseidon` syscall available on-chain |

All Poseidon computations operate over the BN254 scalar field:
`p = 21888242871839275222246405745257275088696311157297823662689037894645226208583`.

### `idSecret` Derivation Protocol

`idSecret` is derived deterministically from the wallet and requires no separate storage:

```
step 1  message  = UTF-8("nara-zk:idsecret:v1:{name}")
step 2  sig      = Ed25519_sign(walletSecretKey, message)
                   // 64 bytes; deterministic per RFC 8032:
                   // identical key + message → identical signature every time
step 3  digest   = SHA-256(sig)                           // 32 bytes
step 4  idSecret = (digest_as_bigint mod (BN254_PRIME − 1)) + 1
                   // reduced to [1, BN254_PRIME); zero is excluded
```

**Why the name must be included in the signed message**: If a single wallet owns multiple ZK IDs and the name is omitted, all ZK IDs share the same `idSecret` and therefore the same `idCommitment`. Spending from one ZK ID would burn the nullifier for the same `depositIndex` on every other ZK ID, destroying both usability and privacy.

**Browser / wallet adapter usage**:

```typescript
// Production (Phantom, Backpack, etc.)
const idSecret = await deriveIdSecret(
  (msg) => wallet.signMessage(msg),
  "alice"
);

// Test environment (Keypair)
const idSecret = await deriveIdSecret(
  makeKeypairSigner(keypair.secretKey),
  "alice"
);
```

### Identity Commitment

```
idCommitment = Poseidon(idSecret)   // single-input Poseidon
```

`idCommitment` is the on-chain identity credential. Knowing `idSecret` allows a user to prove ownership of `idCommitment` through the ownership circuit without ever revealing `idSecret`.

### Deposit Leaf

Each deposit inserts one leaf into the Merkle tree:

```
depositIndex_bytes = depositCount encoded as big-endian u32 in the last 4 bytes
                     of a 32-byte zero-padded array
leaf               = Poseidon(idCommitment, depositIndex_bytes)
```

Two distinct indices are used throughout the protocol:

| Index | Scope | Purpose |
|-------|-------|---------|
| `depositIndex` | Per-ZK-ID, starts at 0 | Used in the circuit to compute the leaf and the nullifier |
| `leafIndex` | Global across all ZK IDs | Identifies the leaf's position in the Merkle tree; used to build the inclusion proof path |

`InboxAccount` stores both values so the owner can query them directly from chain:

```rust
pub struct InboxEntry {
    pub leaf_index:   u64,  // global tree position → used to build Merkle proof
    pub denomination: u64,  // lamports
}
// depositIndex is derived from ZkIdAccount.deposit_count:
//   most recent deposit's depositIndex = deposit_count − 1
```

### Nullifier-Based Double-Spend Prevention

```
nullifierHash = Poseidon(idSecret, depositIndex)
```

Each `withdraw` call creates a PDA at seed `["nullifier", denom_le8, nullifierHash]`. If that PDA already exists, the transaction is rejected at the account-creation stage before any other logic runs.

**Properties**:
- Each deposit can be withdrawn exactly once (same `idSecret` + `depositIndex` → same nullifier)
- The nullifier reveals neither the ZK ID nor `idSecret` (Poseidon is one-way)

---

## ZK Circuits

### Withdraw Circuit (`circuits/withdraw.circom`)

```
Depth:           64 levels (matches MERKLE_TREE_LEVELS)
Proof system:    Groth16 (BN254)
Public inputs:   root, nullifierHash, recipient
Private inputs:  idSecret, depositIndex, pathElements[64], pathIndices[64]
```

**Full constraint set**:

```circom
template Withdraw(levels) {
    // ── private inputs ──────────────────────────────────────────────────────
    signal input idSecret;
    signal input depositIndex;
    signal input pathElements[levels];   // sibling hashes, bottom-up
    signal input pathIndices[levels];    // 0 = current node is left child, 1 = right

    // ── public inputs ────────────────────────────────────────────────────────
    signal input root;
    signal input nullifierHash;
    signal input recipient;              // binds proof to a specific withdrawal address

    // Constraint 1: idCommitment = Poseidon(idSecret)
    component commitHasher = Poseidon(1);
    commitHasher.inputs[0] <== idSecret;
    signal idCommitment <== commitHasher.out;

    // Constraint 2: leaf = Poseidon(idCommitment, depositIndex)
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== idCommitment;
    leafHasher.inputs[1] <== depositIndex;
    signal leaf <== leafHasher.out;

    // Constraint 3: MerkleProof(leaf, path) == root
    component merkle = MerkleProof(levels);
    merkle.leaf <== leaf;
    // ... path element assignments
    root === merkle.root;

    // Constraint 4: nullifierHash = Poseidon(idSecret, depositIndex)
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== idSecret;
    nullifierHasher.inputs[1] <== depositIndex;
    nullifierHash === nullifierHasher.out;

    // Constraint 5: bind recipient (prevents relayer front-running / substitution)
    signal recipientSquare <== recipient * recipient;
}
component main { public [root, nullifierHash, recipient] } = Withdraw(64);
```

Constraint 5 forces `recipient` to participate in the actual witness computation. A relayer cannot replace the recipient field after receiving the proof without invalidating it.

**`MerkleProof` sub-template**:

```circom
template MerkleProof(levels) {
    // Traverses from leaf to root, selecting left/right at each level
    // via a multiplexer controlled by pathIndices[i].
    levelHashes[0] = leaf
    for i in 0..levels:
        (left, right) = MultiMux1(levelHashes[i], pathElements[i], pathIndices[i])
        levelHashes[i+1] = Poseidon(left, right)
    root = levelHashes[levels]
}
```

### Ownership Proof Circuit (`circuits/ownership.circom`)

```
Proof system:   Groth16 (BN254)
Public input:   idCommitment (current on-chain value)
Private input:  idSecret
```

```circom
template OwnershipProof() {
    signal input idSecret;
    signal input idCommitment;   // public

    component hasher = Poseidon(1);
    hasher.inputs[0] <== idSecret;
    idCommitment === hasher.out;
}
component main { public [idCommitment] } = OwnershipProof();
```

Used exclusively by `transfer_zk_id`: the current owner proves knowledge of `idSecret` for the existing `idCommitment`, authorizing replacement with a new commitment — without revealing `idSecret` or any wallet address.

### Proof Wire Format (256 bytes)

The on-chain verifier (`groth16-solana` crate) uses Solana's `alt_bn128` syscall and requires the following layout:

```
bytes   0.. 64  proof_a  — G1 point (−A, negated), big-endian uncompressed x ‖ y
bytes  64..192  proof_b  — G2 point (B),  big-endian [x.c1, x.c0, y.c1, y.c0]
bytes 192..256  proof_c  — G1 point (C),  big-endian uncompressed x ‖ y
```

The client-side `packProof()` function converts the snarkjs output to this format and negates the y-coordinate of `proof_a` (standard G1 negation on BN254: `y_neg = p − y`).

### Verifying Keys

Both verifying keys are hardcoded in `programs/nara-zk/src/verifier.rs`, generated from a trusted setup ceremony:

| Circuit | Public inputs | IC array size |
|---------|--------------|---------------|
| Withdraw | 3 (`root`, `nullifierHash`, `recipient`) | 4 |
| Ownership | 1 (`idCommitment`) | 2 |

---

## On-Chain Implementation

### Incremental Merkle Tree

The tree has 64 levels and can accommodate up to 2^64 leaves. Insertions run in O(levels) time using the standard **incremental append-only Merkle tree** algorithm with a `filled_subtrees` array:

```rust
pub struct MerkleTreeAccount {              // zero_copy
    pub levels:             u32,            // = 64
    pub current_root_index: u32,            // index of the current root in roots[]
    pub next_index:         u64,            // next available global leaf position
    pub denomination:       u64,
    pub filled_subtrees:    [[u8; 32]; 64], // last completed left subtree hash per level
    pub roots:              [[u8; 32]; 30], // circular buffer of the 30 most recent roots
    pub zeros:              [[u8; 32]; 64], // precomputed empty-subtree hashes
}
```

**Root history buffer** (`ROOT_HISTORY_SIZE = 30`): Allows withdrawal proofs to reference any of the 30 most recent roots. This prevents transaction failures caused by root contention when multiple withdrawals are submitted in the same block.

**Zero (empty subtree) values**:

```
zeros[0] = [0u8; 32]
zeros[i] = Poseidon(zeros[i−1], zeros[i−1])
```

The on-chain `constants::zero_value(level)` function and the client-side `computeZeros()` use identical logic, ensuring sibling hashes match across the proving and verification boundaries.

### InboxAccount (Ring Buffer)

```rust
pub struct InboxAccount {               // zero_copy
    pub entries: [InboxEntry; 64],      // INBOX_SIZE = 64 (power of two, required by bytemuck)
    pub head:    u8,                    // write pointer (next write position)
    pub count:   u8,                    // number of valid entries (capped at 64)
    pub _pad:    [u8; 6],
}
```

Reading the most recent deposit entry (client-side):

```typescript
const head         = inboxData.head as number;
const lastEntryIdx = (head - 1 + 64) % 64;
const latestEntry  = inboxData.entries[lastEntryIdx];
const leafIndex    = BigInt(latestEntry.leafIndex.toString());
// depositIndex = ZkIdAccount.depositCount - 1
```

### On-Chain Poseidon

Poseidon is computed via the `solana-poseidon` crate using the `solana_poseidon::hashv` syscall with **big-endian** byte ordering and the `Bn254X5` parameter set:

```rust
solana_poseidon::hashv(
    solana_poseidon::Parameters::Bn254X5,
    solana_poseidon::Endianness::BigEndian,
    &[a, b],
)
```

`depositIndex` is encoded as a big-endian `u32` in the final 4 bytes of a 32-byte zero-padded array, making it equivalent to the `depositIndex` signal in the circuit.

---

## Account Structure

### `ConfigAccount` — seed `["config"]`

```rust
pub struct ConfigAccount {              // zero_copy
    pub admin:         Pubkey,  // sole authority for update_config
    pub fee_recipient: Pubkey,  // receives registration fees
    pub fee_amount:    u64,     // lamports per registration; 0 = free
}
// SIZE = 8 (discriminator) + size_of::<Self>()
```

Singleton PDA. Anchor's `init` constraint guarantees it can only be created once.

### `ZkIdAccount` — seed `["zk_id", name_hash]`

```rust
pub struct ZkIdAccount {
    pub name_hash:              [u8; 32], // SHA-256("nara-zk:" + name)
    pub id_commitment:          [u8; 32], // Poseidon(idSecret); updated by transfer_zk_id
    pub deposit_count:          u32,      // total deposits; equals the next depositIndex
    pub commitment_start_index: u32,      // depositIndex at which the current commitment became active
}
// SIZE = 8 (discriminator) + INIT_SPACE
```

`commitment_start_index` partitions deposits by ownership epoch:

- `depositIndex < commitment_start_index` → belongs to the previous owner (old `idSecret` can withdraw)
- `depositIndex >= commitment_start_index` → belongs to the current owner (new `idSecret` required)

### `MerkleTreeAccount` — seed `["tree", denom_le8]`

64-level zero-copy account. One independent tree per denomination.

### `PoolAccount` — seed `["pool", denom_le8]`

Program-owned PDA (no private key). Holds all SOL for a given denomination. Withdrawals use `invoke_signed`, with Anchor supplying the PDA signature.

### `InboxAccount` — seed `["inbox", name_hash]`

Zero-copy 64-entry ring buffer of `(leaf_index, denomination)` pairs.

### `NullifierAccount` — seed `["nullifier", denom_le8, nullifier_hash]`

Empty account (8-byte discriminator only). Its mere existence marks the corresponding deposit as spent.

---

## Instructions

### `initialize_config`

```
accounts : admin (Signer, writable), config (init PDA ["config"]), system_program
params   : fee_recipient: Pubkey, fee_amount: u64
effect   : Creates ConfigAccount; sets config.admin = caller.
           Can only be called once (Anchor init constraint).
```

### `update_config`

```
accounts : admin (Signer), config (mut PDA, constraint: admin == config.admin)
params   : new_admin: Pubkey, new_fee_recipient: Pubkey, new_fee_amount: u64
effect   : Updates all three fields. The constraint enforces that only
           the current admin can call this; the old admin is immediately locked
           out after a transfer.
```

### `initialize`

```
accounts : payer (Signer, writable), merkle_tree (init PDA), pool (init PDA),
           system_program
params   : denomination: u64  ∈ {1e9, 1e10, 1e11, 1e12} lamports
effect   : Creates MerkleTreeAccount (filled_subtrees and roots initialised to
           zeros) and PoolAccount. Rejects unrecognised denominations with
           InvalidDenomination.
```

### `register`

```
accounts : payer (Signer, writable), zk_id (init PDA), inbox (init PDA),
           config (PDA), fee_recipient (writable, key == config.fee_recipient),
           system_program
params   : name_hash: [u8; 32], id_commitment: [u8; 32]
effect   : 1. If config.fee_amount > 0, CPI-transfers fee_amount lamports
              from payer to fee_recipient.
           2. Initialises ZkIdAccount (deposit_count = 0,
              commitment_start_index = 0).
           3. Initialises InboxAccount (head = 0, count = 0).
```

Any wallet may serve as `payer`. The actual owner never submits a transaction — their address never appears on-chain. See [Delegated Registration](#delegated-registration).

### `deposit`

```
accounts : depositor (Signer, writable), zk_id (mut PDA), inbox (mut PDA),
           merkle_tree (mut PDA), pool (mut PDA), system_program
params   : name_hash: [u8; 32], denomination: u64
effect   : 1. depositIndex = zk_id.deposit_count
           2. leaf = Poseidon(zk_id.id_commitment, depositIndex)
           3. CPI-transfers denomination lamports: depositor → pool
           4. leafIndex = merkle_tree.insert(leaf)
           5. zk_id.deposit_count += 1
           6. inbox.push(leafIndex, denomination)
           7. Emits DepositEvent { nameHash, leafIndex, denomination }
```

Anyone may call `deposit`. Knowledge of the name (to compute `name_hash`) is the only requirement — the depositor does not need to know the owner's address.

### `withdraw`

```
accounts : payer (Signer, writable), nullifier (init PDA), pool (mut PDA),
           merkle_tree (PDA), recipient (writable), system_program
params   : proof: Vec<u8> (256 B), root: [u8; 32], nullifier_hash: [u8; 32],
           recipient: Pubkey, denomination: u64
effect   : 1. Verifies root is present in merkle_tree.roots[0..30].
           2. Verifies the Groth16 proof against public inputs
              [root, nullifierHash, recipient].
           3. Creates NullifierAccount (init). If already present → rejected,
              preventing double-spending.
           4. invoke_signed: pool → recipient, transferring denomination lamports.
           5. Emits WithdrawEvent { nullifierHash, denomination }
```

`payer` (gas sponsor) and `recipient` (beneficiary) may be different addresses, fully supporting anonymous relay.

### `transfer_zk_id`

```
accounts : payer (Signer, writable), zk_id (mut PDA)
params   : name_hash: [u8; 32], new_id_commitment: [u8; 32],
           ownership_proof: Vec<u8> (256 B)
effect   : 1. Verifies Groth16 ownership proof against the current
              id_commitment as the sole public input — proving knowledge of
              idSecret such that Poseidon(idSecret) == id_commitment.
           2. zk_id.id_commitment = new_id_commitment
           3. zk_id.commitment_start_index = zk_id.deposit_count
           4. Emits TransferZkIdEvent { nameHash }
```

After transfer, all subsequent deposits use `new_id_commitment` when computing their leaves. The previous `idSecret` cannot generate a valid Groth16 proof for any post-transfer deposit: the circuit's Merkle inclusion constraint fails at the proving stage (not merely at on-chain verification), making the cryptographic separation absolute.

---

## Privacy Analysis

### On-Chain Data Summary

| Operation | Visible on-chain | Not visible |
|-----------|-----------------|-------------|
| `register` | payer address, `name_hash` (one-way hash), `id_commitment` | Owner's real address, plaintext name |
| `deposit` | depositor address, `name_hash`, denomination | Owner's address, plaintext name |
| `withdraw` | payer address, recipient address, `nullifierHash`, denomination | ZK ID identity, `idSecret` |
| `transfer_zk_id` | payer address, `name_hash`, `new_id_commitment` | Owner's address, `idSecret` |

### Delegated Registration

Because `register` accepts any `payer`, the owner's address is never required on-chain. The registration flow with a relayer:

```
1. Owner computes locally (signMessage runs on-device; nothing goes on-chain):
      idSecret     = deriveIdSecret(wallet.signMessage, "alice")
      idCommitment = Poseidon(idSecret)
      nameHash     = SHA-256("nara-zk:alice")

2. Owner transmits (nameHash, idCommitment) to the relayer
   via an off-chain channel (HTTPS, P2P, etc.).

3. Relayer submits:
      register(nameHash, idCommitment) with relayer as payer
   → Only the relayer's address appears on-chain.
```

### Cryptographic Security Assumptions

| Assumption | Consequence if violated |
|------------|------------------------|
| Poseidon is one-way over BN254 | `idSecret` could be recovered from `idCommitment` |
| Groth16 zero-knowledge | Proof would leak `idSecret`, `depositIndex`, or the Merkle path |
| Groth16 soundness | A party without `idSecret` could forge a valid withdrawal proof |
| Ed25519 determinism (RFC 8032) | `idSecret` derivation would be non-reproducible, making re-derivation unreliable |

---

## File Structure

```
programs/nara-zk/src/
├── lib.rs                      # Entry point: module declarations, glob re-exports,
│                               # #[program] dispatch
├── constants.rs                # MERKLE_TREE_LEVELS = 64, ROOT_HISTORY_SIZE = 30,
│                               # DENOMINATIONS, INBOX_SIZE = 64, zero_value()
├── errors.rs                   # NaraZkError enum (10 variants)
├── events.rs                   # DepositEvent / WithdrawEvent / TransferZkIdEvent
├── merkle_tree.rs              # MerkleTreeAccount::insert() — O(levels) incremental insert
├── poseidon.rs                 # hash_pair() — wraps solana_poseidon syscall
├── verifier.rs                 # verify_withdraw_proof() / verify_ownership_proof()
│                               # + hardcoded Groth16 verifying keys (BN254)
├── state/
│   ├── config.rs               # ConfigAccount
│   ├── zk_id.rs                # ZkIdAccount
│   ├── inbox.rs                # InboxAccount (zero_copy ring buffer) + InboxEntry
│   ├── merkle_tree.rs          # MerkleTreeAccount (zero_copy, 64 levels)
│   ├── pool.rs                 # PoolAccount
│   └── nullifier.rs            # NullifierAccount (empty, 8-byte discriminator only)
└── instructions/
    ├── initialize_config.rs
    ├── update_config.rs
    ├── initialize.rs
    ├── register.rs
    ├── deposit.rs
    ├── withdraw.rs
    └── transfer_zk_id.rs

circuits/
├── withdraw.circom             # Withdraw(64): 5 constraints + MerkleProof sub-template
├── ownership.circom            # OwnershipProof(): 1 constraint
└── build/
    ├── withdraw/
    │   ├── withdraw_js/withdraw.wasm
    │   └── withdraw_final.zkey
    └── ownership/
        ├── ownership_js/ownership.wasm
        └── ownership_final.zkey

app/
├── utils.ts                    # nameHash(), findXxxPda(), DENOMINATIONS, toBytes32()
└── proofUtils.ts               # deriveIdSecret(), makeKeypairSigner(),
                                # generateWithdrawProof(), generateOwnershipProof(),
                                # buildMerklePath(), computeZeros(), packProof()

tests/
└── nara-zk.ts                  # 24 integration tests using real Groth16 proofs
```

---

## Development Guide

### Prerequisites

- [Anchor](https://www.anchor-lang.com/) 0.32 + Rust toolchain (see `rust-toolchain.toml`)
- [Solana CLI](https://docs.solanalabs.com/cli/install) 1.18+
- Node.js 18+ / yarn

### Build and Test

```bash
yarn install        # Install JavaScript dependencies

anchor build        # Compile the Rust program; generates target/types/nara_zk.ts

anchor test         # Spin up a local validator and run the 24-test suite
                    # All tests use real Groth16 proofs; expect ~14 seconds total
```

### Client-Side `idSecret` Derivation

```typescript
import { deriveIdSecret, makeKeypairSigner } from "./app/proofUtils";

// Production (Phantom, Backpack, or any Wallet Standard adapter)
const idSecret = await deriveIdSecret(
  (msg) => wallet.signMessage(msg),
  "alice"
);

// Test environment (Keypair)
const idSecret = await deriveIdSecret(
  makeKeypairSigner(keypair.secretKey),
  "alice"
);
```

### Test Coverage (24 tests)

| Category | Count |
|----------|-------|
| Config management (initialize / update / permissions / singleton / admin transfer) | 6 |
| Merkle tree + pool initialization (including invalid denomination rejection) | 3 |
| Alice happy path (register with fee verification / deposit / withdraw) | 4 |
| Double-spend prevention | 2 |
| ZK ID transfer (success / wrong proof rejection / post-transfer ownership isolation) | 3 |
| Withdrawal error cases (InvalidProof / UnknownRoot / recipient mismatch) | 3 |
| Bob multi-deposit flow with full on-chain data retrieval | 3 |
| **Total** | **24** |
