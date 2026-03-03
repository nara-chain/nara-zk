import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";
import { NaraZk } from "../target/types/nara_zk";
import {
  nameHash,
  findTreePda,
  findPoolPda,
  findZkIdPda,
  DENOMINATIONS,
  toBytes32,
} from "../app/utils";
import {
  computeZeros,
  computeIdCommitment,
  commitmentToBytes,
  randomIdSecret,
  validRecipient,
  generateWithdrawProof,
  generateOwnershipProof,
} from "../app/proofUtils";

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("nara-zk", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.NaraZk as Program<NaraZk>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const denom = DENOMINATIONS.SOL_1;

  // ── Shared state across tests ──────────────────────────────────────────────
  const ALICE = "alice";
  const aliceHash = nameHash(ALICE);

  let aliceIdSecret: bigint;
  let aliceIdCommitmentBuf: Buffer;
  let zeros: bigint[];

  // Saved from the first withdrawal (reused for double-spend)
  let firstWithdrawProofBuf: Buffer;
  let firstWithdrawRootBuf: Buffer;
  let firstNullifierBuf: Buffer;
  let firstRecipient: Keypair;

  // Saved from transfer_zk_id test
  let aliceNewIdSecret: bigint;
  let aliceNewCommitmentBuf: Buffer;

  // Bob — multi-deposit scenario
  const BOB = "bob";
  const bobHash = nameHash(BOB);
  let bobIdSecret: bigint;
  let bobIdCommitmentBuf: Buffer;

  // Saved from bob's second withdrawal (reused for double-spend)
  let bobSecondNullifierBuf: Buffer;
  let bobSecondWithdrawRootBuf: Buffer;
  let bobSecondWithdrawProofBuf: Buffer;
  let bobSecondRecipient: Keypair;

  // ── initialize ───────────────────────────────────────────────────────────────

  it("initialize: creates Merkle tree + pool for 1 SOL denomination", async () => {
    zeros = await computeZeros();

    await program.methods
      .initialize(denom)
      .accounts({ payer: payer.publicKey })
      .rpc();

    const [poolPda] = findPoolPda(denom, program.programId);
    const poolData = await program.account.poolAccount.fetch(poolPda);
    expect(poolData.denomination.toString()).to.equal(denom.toString());
  });

  // ── register ─────────────────────────────────────────────────────────────────

  it("register: creates ZK ID for alice with real id_commitment", async () => {
    aliceIdSecret = randomIdSecret();
    const commitment = await computeIdCommitment(aliceIdSecret);
    aliceIdCommitmentBuf = commitmentToBytes(commitment);

    await program.methods
      .register(toBytes32(aliceHash), toBytes32(aliceIdCommitmentBuf))
      .accounts({ payer: payer.publicKey })
      .rpc();

    const [zkIdPda] = findZkIdPda(aliceHash, program.programId);
    const zkIdData = await program.account.zkIdAccount.fetch(zkIdPda);
    expect(zkIdData.depositCount).to.equal(0);
    expect(Buffer.from(zkIdData.nameHash as number[]).equals(aliceHash)).to.be.true;
    expect(
      Buffer.from(zkIdData.idCommitment as number[]).equals(aliceIdCommitmentBuf)
    ).to.be.true;
  });

  // ── deposit ──────────────────────────────────────────────────────────────────

  it("deposit: transfers 1 SOL from depositor to pool (alice leafIndex=0)", async () => {
    const [poolPda] = findPoolPda(denom, program.programId);
    const poolBalBefore = await provider.connection.getBalance(poolPda);

    await program.methods
      .deposit(toBytes32(aliceHash), denom)
      .accounts({ depositor: payer.publicKey })
      .rpc();

    const poolBalAfter = await provider.connection.getBalance(poolPda);
    expect(poolBalAfter - poolBalBefore).to.equal(LAMPORTS_PER_SOL);

    const [zkIdPda] = findZkIdPda(aliceHash, program.programId);
    const zkIdData = await program.account.zkIdAccount.fetch(zkIdPda);
    expect(zkIdData.depositCount).to.equal(1);
  });

  // ── withdraw (real ZK proof) ─────────────────────────────────────────────────

  it("withdraw: anonymously withdraws 1 SOL using a real Groth16 proof", async () => {
    const [treePda] = findTreePda(denom, program.programId);
    const treeData = await program.account.merkleTreeAccount.fetch(treePda);
    const rootIdx: number = treeData.currentRootIndex as number;
    const rootBuf = Buffer.from(treeData.roots[rootIdx] as number[]);

    // For leaf at index 0, all siblings are zeros[i] (computed offline)
    const filledSubtrees = (treeData.filledSubtrees as number[][]).map((s) =>
      Buffer.from(s)
    );

    const { keypair: recipientKp } = validRecipient();

    const { proof: proofBuf, nullifierHash: nullifierBuf } =
      await generateWithdrawProof(
        aliceIdSecret,
        0n, // depositIndex: alice's 1st deposit (used in leaf hash + nullifier)
        0n, // leafIndex: global tree position
        filledSubtrees,
        zeros,
        rootBuf,
        recipientKp.publicKey
      );

    // Save for double-spend test
    firstWithdrawProofBuf = proofBuf;
    firstWithdrawRootBuf = rootBuf;
    firstNullifierBuf = nullifierBuf;
    firstRecipient = recipientKp;

    const recipientBalBefore = await provider.connection.getBalance(
      recipientKp.publicKey
    );

    await program.methods
      .withdraw(
        proofBuf,
        toBytes32(rootBuf),
        toBytes32(nullifierBuf),
        recipientKp.publicKey,
        denom
      )
      .accounts({
        payer: payer.publicKey,
        recipient: recipientKp.publicKey,
      })
      .rpc();

    const recipientBalAfter = await provider.connection.getBalance(
      recipientKp.publicKey
    );
    expect(recipientBalAfter - recipientBalBefore).to.equal(LAMPORTS_PER_SOL);
  });

  // ── double-spend prevention ──────────────────────────────────────────────────

  it("withdraw: rejects double-spend (nullifier already used)", async () => {
    // Make a second deposit so the pool has funds (alice leafIndex=1, depositIndex=1)
    await program.methods
      .deposit(toBytes32(aliceHash), denom)
      .accounts({ depositor: payer.publicKey })
      .rpc();

    // Reuse the SAME proof, root, nullifier from the first withdrawal.
    // The first root is still in the ring buffer (ROOT_HISTORY_SIZE = 30).
    // The transaction will fail at account creation because the nullifier PDA
    // already exists — long before proof verification.
    try {
      await program.methods
        .withdraw(
          firstWithdrawProofBuf,
          toBytes32(firstWithdrawRootBuf),
          toBytes32(firstNullifierBuf),
          firstRecipient.publicKey,
          denom
        )
        .accounts({
          payer: payer.publicKey,
          recipient: firstRecipient.publicKey,
        })
        .rpc();
      expect.fail("Expected double-spend to be rejected");
    } catch (err: any) {
      expect(err.message).to.match(/already in use|0x0/i);
    }
  });

  // ── transfer_zk_id ───────────────────────────────────────────────────────────

  it("transfer_zk_id: updates id_commitment using a real ownership proof", async () => {
    aliceNewIdSecret = randomIdSecret();
    const newCommitment = await computeIdCommitment(aliceNewIdSecret);
    aliceNewCommitmentBuf = commitmentToBytes(newCommitment);

    // Prove knowledge of the CURRENT id_secret to authorise the transfer
    const ownershipProofBuf = await generateOwnershipProof(
      aliceIdSecret,
      aliceIdCommitmentBuf
    );

    await program.methods
      .transferZkId(
        toBytes32(aliceHash),
        toBytes32(aliceNewCommitmentBuf),
        ownershipProofBuf
      )
      .accounts({ payer: payer.publicKey })
      .rpc();

    const [zkIdPda] = findZkIdPda(aliceHash, program.programId);
    const zkIdData = await program.account.zkIdAccount.fetch(zkIdPda);
    expect(
      Buffer.from(zkIdData.idCommitment as number[]).equals(aliceNewCommitmentBuf)
    ).to.be.true;
    expect(zkIdData.commitmentStartIndex).to.equal(zkIdData.depositCount);
  });

  // ── error cases ──────────────────────────────────────────────────────────────

  it("withdraw: rejects all-zero proof (InvalidProof)", async () => {
    const [treePda] = findTreePda(denom, program.programId);
    const treeData = await program.account.merkleTreeAccount.fetch(treePda);
    const rootIdx: number = treeData.currentRootIndex as number;
    const rootBuf = Buffer.from(treeData.roots[rootIdx] as number[]);

    // Fresh nullifier so the PDA doesn't already exist
    const fakeNullifier = createHash("sha256").update("test:fake-nullifier-1").digest();
    const { keypair: recipKp } = validRecipient();

    try {
      await program.methods
        .withdraw(
          Buffer.alloc(256, 0), // all-zero proof — fails Groth16 verification
          toBytes32(rootBuf),
          toBytes32(fakeNullifier),
          recipKp.publicKey,
          denom
        )
        .accounts({
          payer: payer.publicKey,
          recipient: recipKp.publicKey,
        })
        .rpc();
      expect.fail("Expected InvalidProof");
    } catch (err: any) {
      expect(err.message).to.match(/InvalidProof|Invalid ZK proof/i);
    }
  });

  it("withdraw: rejects unknown Merkle root (UnknownRoot)", async () => {
    // A root value that was never stored in the ring buffer
    const fakeRoot = Buffer.alloc(32, 0xab);
    const fakeNullifier = createHash("sha256").update("test:fake-nullifier-2").digest();
    const { keypair: recipKp } = validRecipient();

    try {
      await program.methods
        .withdraw(
          Buffer.alloc(256, 0), // proof doesn't matter — root check fires first
          toBytes32(fakeRoot),
          toBytes32(fakeNullifier),
          recipKp.publicKey,
          denom
        )
        .accounts({
          payer: payer.publicKey,
          recipient: recipKp.publicKey,
        })
        .rpc();
      expect.fail("Expected UnknownRoot");
    } catch (err: any) {
      expect(err.message).to.match(/UnknownRoot|Unknown Merkle root/i);
    }
  });

  it("withdraw: rejects proof with mismatched recipient (InvalidProof)", async () => {
    // Alice's 2nd deposit: depositIndex=1, leafIndex=1 (inserted in double-spend test).
    // Generate a VALID proof for intendedRecipient, then submit with wrongRecipient.
    // The on-chain verifier uses `recipient` as a public input, so the proof fails.
    const [treePda] = findTreePda(denom, program.programId);
    const treeData = await program.account.merkleTreeAccount.fetch(treePda);
    const rootIdx: number = treeData.currentRootIndex as number;
    const rootBuf = Buffer.from(treeData.roots[rootIdx] as number[]);
    const filledSubtrees = (treeData.filledSubtrees as number[][]).map((s) =>
      Buffer.from(s)
    );

    const { keypair: intendedRecipient } = validRecipient();
    const { keypair: wrongRecipient } = validRecipient();

    const { proof: proofBuf, nullifierHash: nullifierBuf } =
      await generateWithdrawProof(
        aliceIdSecret, // original secret (leaf was created with old id_commitment)
        1n,            // depositIndex: alice's 2nd deposit
        1n,            // leafIndex: global tree index
        filledSubtrees,
        zeros,
        rootBuf,
        intendedRecipient.publicKey // proof commits to this recipient
      );

    // Submit with a different recipient — public input mismatch → InvalidProof
    try {
      await program.methods
        .withdraw(
          proofBuf,
          toBytes32(rootBuf),
          toBytes32(nullifierBuf),
          wrongRecipient.publicKey, // wrong recipient
          denom
        )
        .accounts({
          payer: payer.publicKey,
          recipient: wrongRecipient.publicKey,
        })
        .rpc();
      expect.fail("Expected InvalidProof");
    } catch (err: any) {
      expect(err.message).to.match(/InvalidProof|Invalid ZK proof/i);
    }
  });

  it("transfer_zk_id: rejects wrong ownership proof (InvalidProof)", async () => {
    // Generate a VALID ownership proof for a completely different identity.
    // On-chain id_commitment = aliceNewCommitmentBuf; the proof proves
    // Poseidon(wrongIdSecret) == wrongCommitment ≠ aliceNewCommitmentBuf → fails.
    const wrongIdSecret = randomIdSecret();
    const wrongCommitment = await computeIdCommitment(wrongIdSecret);
    const wrongCommitmentBuf = commitmentToBytes(wrongCommitment);

    const wrongOwnershipProof = await generateOwnershipProof(
      wrongIdSecret,
      wrongCommitmentBuf // valid proof but for a different identity
    );

    try {
      await program.methods
        .transferZkId(
          toBytes32(aliceHash),
          toBytes32(aliceNewCommitmentBuf),
          wrongOwnershipProof // wrong proof → verifier checks against aliceNewCommitmentBuf
        )
        .accounts({ payer: payer.publicKey })
        .rpc();
      expect.fail("Expected InvalidProof");
    } catch (err: any) {
      expect(err.message).to.match(/InvalidProof|Invalid ZK proof/i);
    }
  });

  it("initialize: rejects invalid denomination (InvalidDenomination)", async () => {
    const badDenom = new anchor.BN(999); // 999 lamports — not in DENOMINATIONS
    try {
      await program.methods
        .initialize(badDenom)
        .accounts({ payer: payer.publicKey })
        .rpc();
      expect.fail("Expected InvalidDenomination");
    } catch (err: any) {
      expect(err.message).to.match(/InvalidDenomination|Invalid denomination/i);
    }
  });

  // ── multi-deposit: bob ────────────────────────────────────────────────────────
  // Tree state at this point: alice has 2 deposits (leafIndex 0 and 1).
  // Bob's deposits will occupy leafIndex 2 and 3.

  it("register: creates ZK ID for bob", async () => {
    bobIdSecret = randomIdSecret();
    const commitment = await computeIdCommitment(bobIdSecret);
    bobIdCommitmentBuf = commitmentToBytes(commitment);

    await program.methods
      .register(toBytes32(bobHash), toBytes32(bobIdCommitmentBuf))
      .accounts({ payer: payer.publicKey })
      .rpc();

    const [zkIdPda] = findZkIdPda(bobHash, program.programId);
    const zkIdData = await program.account.zkIdAccount.fetch(zkIdPda);
    expect(zkIdData.depositCount).to.equal(0);
    expect(
      Buffer.from(zkIdData.idCommitment as number[]).equals(bobIdCommitmentBuf)
    ).to.be.true;
  });

  it("deposit: bob first deposit (leafIndex=2, depositIndex=0)", async () => {
    await program.methods
      .deposit(toBytes32(bobHash), denom)
      .accounts({ depositor: payer.publicKey })
      .rpc();

    const [zkIdPda] = findZkIdPda(bobHash, program.programId);
    const zkIdData = await program.account.zkIdAccount.fetch(zkIdPda);
    expect(zkIdData.depositCount).to.equal(1);
  });

  it("deposit: bob second deposit (leafIndex=3, depositIndex=1)", async () => {
    await program.methods
      .deposit(toBytes32(bobHash), denom)
      .accounts({ depositor: payer.publicKey })
      .rpc();

    const [zkIdPda] = findZkIdPda(bobHash, program.programId);
    const zkIdData = await program.account.zkIdAccount.fetch(zkIdPda);
    expect(zkIdData.depositCount).to.equal(2);
  });

  it("withdraw: bob withdraws second deposit (depositIndex=1, leafIndex=3)", async () => {
    // Tree has 4 leaves: alice×2 (indices 0,1) + bob×2 (indices 2,3).
    // Bob's 2nd deposit: depositIndex=1 (personal counter), leafIndex=3 (global).
    const [treePda] = findTreePda(denom, program.programId);
    const treeData = await program.account.merkleTreeAccount.fetch(treePda);
    const rootIdx: number = treeData.currentRootIndex as number;
    const rootBuf = Buffer.from(treeData.roots[rootIdx] as number[]);
    const filledSubtrees = (treeData.filledSubtrees as number[][]).map((s) =>
      Buffer.from(s)
    );

    const { keypair: recipientKp } = validRecipient();

    const { proof: proofBuf, nullifierHash: nullifierBuf } =
      await generateWithdrawProof(
        bobIdSecret,
        1n, // depositIndex: bob's 2nd deposit
        3n, // leafIndex: global tree position (alice×2 + bob deposit 1 = index 3 is bob's 2nd)
        filledSubtrees,
        zeros,
        rootBuf,
        recipientKp.publicKey
      );

    // Save for double-spend test
    bobSecondNullifierBuf = nullifierBuf;
    bobSecondWithdrawRootBuf = rootBuf;
    bobSecondWithdrawProofBuf = proofBuf;
    bobSecondRecipient = recipientKp;

    const [poolPda] = findPoolPda(denom, program.programId);
    const poolBalBefore = await provider.connection.getBalance(poolPda);

    await program.methods
      .withdraw(
        proofBuf,
        toBytes32(rootBuf),
        toBytes32(nullifierBuf),
        recipientKp.publicKey,
        denom
      )
      .accounts({
        payer: payer.publicKey,
        recipient: recipientKp.publicKey,
      })
      .rpc();

    const poolBalAfter = await provider.connection.getBalance(poolPda);
    expect(poolBalBefore - poolBalAfter).to.equal(LAMPORTS_PER_SOL);
  });

  it("withdraw: rejects double-spend of bob's second deposit", async () => {
    // The nullifier PDA for bob's 2nd deposit was created in the previous test.
    // Re-submitting with the same nullifier fails at account creation (PDA already exists).
    try {
      await program.methods
        .withdraw(
          bobSecondWithdrawProofBuf,
          toBytes32(bobSecondWithdrawRootBuf),
          toBytes32(bobSecondNullifierBuf),
          bobSecondRecipient.publicKey,
          denom
        )
        .accounts({
          payer: payer.publicKey,
          recipient: bobSecondRecipient.publicKey,
        })
        .rpc();
      expect.fail("Expected double-spend to be rejected");
    } catch (err: any) {
      expect(err.message).to.match(/already in use|0x0/i);
    }
  });

  // ── multi-denomination ───────────────────────────────────────────────────────

  it("initialize: creates a second pool for 10 SOL denomination", async () => {
    const denom10 = DENOMINATIONS.SOL_10;

    await program.methods
      .initialize(denom10)
      .accounts({ payer: payer.publicKey })
      .rpc();

    const [pool10] = findPoolPda(denom10, program.programId);
    const poolData = await program.account.poolAccount.fetch(pool10);
    expect(poolData.denomination.toString()).to.equal(denom10.toString());
  });
});
