/**
 * Standalone initialization script for nara-zk.
 *
 * Initializes program config + all denomination pools (1, 10, 100, 1000, 10000, 100000 SOL).
 *
 * Usage:
 *   TEST_RPC_URL=http://127.0.0.1:8899 TEST_PRIVATE_KEY=<base58> tsx migrations/init.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require("bs58") as { decode: (input: string) => Buffer };
import { NaraZk } from "../target/types/nara_zk";
import {
  findConfigPda,
  findPoolPda,
  DENOMINATIONS,
} from "../app/utils";

// ── Config from environment ──────────────────────────────────────────────────
const CLUSTER = process.env.TEST_RPC_URL ?? "http://127.0.0.1:8899";
const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: TEST_PRIVATE_KEY is not set");
  process.exit(1);
}

// ── Load wallet ──────────────────────────────────────────────────────────────
const adminKeypair = web3.Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const wallet = new anchor.Wallet(adminKeypair);

// ── Provider + program ───────────────────────────────────────────────────────
const connection = new web3.Connection(CLUSTER, "confirmed");
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});
anchor.setProvider(provider);

const idlPath = path.join(__dirname, "../target/idl/nara_zk.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
const program = new Program<NaraZk>(idl, provider);

// ── Denomination labels ───────────────────────────────────────────────────────
const POOLS: { label: string; denom: BN }[] = [
  { label: "1 SOL",      denom: DENOMINATIONS.SOL_1      },
  { label: "10 SOL",     denom: DENOMINATIONS.SOL_10     },
  { label: "100 SOL",    denom: DENOMINATIONS.SOL_100    },
  { label: "1000 SOL",   denom: DENOMINATIONS.SOL_1000   },
  { label: "10000 SOL",  denom: DENOMINATIONS.SOL_10000  },
  { label: "100000 SOL", denom: DENOMINATIONS.SOL_100000 },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Cluster :", CLUSTER);
  console.log("Admin   :", adminKeypair.publicKey.toBase58());
  console.log("Program :", program.programId.toBase58());
  console.log();

  // ── 1. Initialize config (singleton) ────────────────────────────────────────
  const [configPda] = findConfigPda(program.programId);
  const existingConfig = await connection.getAccountInfo(configPda);

  if (existingConfig !== null) {
    const cfg = await program.account.configAccount.fetch(configPda);
    console.log("Config already initialized:");
    console.log("  admin        :", cfg.admin.toBase58());
    console.log("  feeRecipient :", cfg.feeRecipient.toBase58());
    console.log("  feeAmount    :", cfg.feeAmount.toString(), "lamports");
  } else {
    console.log("Initializing config...");
    // Use admin as fee recipient by default; override FEE_RECIPIENT_KEY env if needed.
    const feeRecipientKey = process.env.FEE_RECIPIENT_KEY
      ? new web3.PublicKey(process.env.FEE_RECIPIENT_KEY)
      : adminKeypair.publicKey;
    const feeAmount = new BN(LAMPORTS_PER_SOL); // 1 SOL registration fee

    const tx = await program.methods
      .initializeConfig(feeRecipientKey, feeAmount)
      .accounts({ admin: adminKeypair.publicKey })
      .rpc();
    console.log("  tx:", tx);

    const cfg = await program.account.configAccount.fetch(configPda);
    console.log("Config initialized:");
    console.log("  admin        :", cfg.admin.toBase58());
    console.log("  feeRecipient :", cfg.feeRecipient.toBase58());
    console.log("  feeAmount    :", cfg.feeAmount.toString(), "lamports");
  }

  console.log();

  // ── 2. Initialize denomination pools ─────────────────────────────────────────
  for (const { label, denom } of POOLS) {
    const [poolPda] = findPoolPda(denom, program.programId);
    const existing = await connection.getAccountInfo(poolPda);

    if (existing !== null) {
      console.log(`Pool [${label}]: already initialized (${poolPda.toBase58()})`);
      continue;
    }

    process.stdout.write(`Pool [${label}]: initializing... `);
    const tx = await program.methods
      .initialize(denom)
      .accounts({ payer: adminKeypair.publicKey })
      .rpc();
    console.log("done");
    console.log(`  pool : ${poolPda.toBase58()}`);
    console.log(`  tx   : ${tx}`);
  }

  console.log("\nAll pools initialized.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
