import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
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

  it("deposit: transfers 1 SOL from depositor to pool", async () => {
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
        0n, // first deposit → leaf index 0
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
    // Make a second deposit so the pool has funds
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
    const newIdSecret = randomIdSecret();
    const newCommitment = await computeIdCommitment(newIdSecret);
    const newCommitmentBuf = commitmentToBytes(newCommitment);

    // Prove knowledge of the CURRENT id_secret to authorise the transfer
    const ownershipProofBuf = await generateOwnershipProof(
      aliceIdSecret,
      aliceIdCommitmentBuf
    );

    await program.methods
      .transferZkId(
        toBytes32(aliceHash),
        toBytes32(newCommitmentBuf),
        ownershipProofBuf
      )
      .accounts({ payer: payer.publicKey })
      .rpc();

    const [zkIdPda] = findZkIdPda(aliceHash, program.programId);
    const zkIdData = await program.account.zkIdAccount.fetch(zkIdPda);
    expect(
      Buffer.from(zkIdData.idCommitment as number[]).equals(newCommitmentBuf)
    ).to.be.true;
    expect(zkIdData.commitmentStartIndex).to.equal(zkIdData.depositCount);
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
