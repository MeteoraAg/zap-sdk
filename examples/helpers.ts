import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";

// https://jito-foundation.gitbook.io/mev/mev-payment-and-distribution/on-chain-addresses
const JITO_TIP_ACCOUNT = new PublicKey(
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
);

// Loads a Keypair from the Solana CLI keypair JSON file whose path is stored in the given env var
export function loadKeypairFromEnv(
  envVar: string = "SECRET_KEY_PATH",
): Keypair {
  const keypairPath = process.env[envVar];
  if (!keypairPath) {
    throw new Error(
      `${envVar} is not set. Set it to the path of a Solana keypair JSON file.`,
    );
  }
  const secretKey = JSON.parse(readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

export function createJitoTipIx({
  payer,
  lamports,
}: {
  payer: PublicKey;
  lamports: string;
}) {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: JITO_TIP_ACCOUNT,
    lamports: BigInt(lamports),
  });
}

// Transaction size limit in bytes.
const MAX_TRANSACTION_SIZE = 1232;

function compileV0Transaction(
  payer: PublicKey,
  blockhash: string,
  instructions: TransactionInstruction[],
  addressLookupTableAccounts: AddressLookupTableAccount[],
): VersionedTransaction | null {
  try {
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(addressLookupTableAccounts),
    );
    return transaction.serialize().length <= MAX_TRANSACTION_SIZE
      ? transaction
      : null;
  } catch {
    return null;
  }
}

// Packs `instructions` in order into as few v0 transactions as fit. The Zap SDK returns its
// instructions in execution order, and any split that keeps the order is valid.
// When `computeUnitLimit` is given, every transaction starts with that compute unit limit.
export function buildV0Transactions({
  payer,
  blockhash,
  instructions,
  addressLookupTableAccounts,
  computeUnitLimit,
}: {
  payer: PublicKey;
  blockhash: string;
  instructions: TransactionInstruction[];
  addressLookupTableAccounts: AddressLookupTableAccount[];
  computeUnitLimit?: number;
}): VersionedTransaction[] {
  const prefix = computeUnitLimit
    ? [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })]
    : [];
  const compile = (batch: TransactionInstruction[]) =>
    compileV0Transaction(
      payer,
      blockhash,
      [...prefix, ...batch],
      addressLookupTableAccounts,
    );

  const batches: TransactionInstruction[][] = [];
  for (const instruction of instructions) {
    const current = batches[batches.length - 1];
    if (current && compile([...current, instruction])) {
      current.push(instruction);
    } else {
      batches.push([instruction]);
    }
  }

  return batches.map((batch) => {
    const transaction = compile(batch);
    if (!transaction) {
      throw new Error("An instruction does not fit in a v0 transaction");
    }
    return transaction;
  });
}

// Signs with every keypair in `signers` that the transaction requires, skipping the rest.
export function signV0Transaction(
  transaction: VersionedTransaction,
  signers: Keypair[],
): void {
  const { header, staticAccountKeys } = transaction.message;
  const requiredSigners = staticAccountKeys.slice(
    0,
    header.numRequiredSignatures,
  );
  transaction.sign(
    signers.filter((signer) =>
      requiredSigners.some((key) => key.equals(signer.publicKey)),
    ),
  );
}

interface JitoBundleResult {
  jsonrpc: string;
  result: string;
  id: number;
}

export async function sendJitoBundle(
  transactions: VersionedTransaction[],
  jitoPrivateKey: string,
) {
  const jitoBundleResult = await fetch(
    "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-jito-auth": jitoPrivateKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [
          transactions.map((signedTx) =>
            Buffer.from(signedTx.serialize()).toString("base64"),
          ),
          { encoding: "base64" },
        ],
      }),
    },
  ).then((res) => res.json() as Promise<JitoBundleResult>);

  return jitoBundleResult;
}
