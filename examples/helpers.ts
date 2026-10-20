import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
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

interface JitoBundleResult {
  jsonrpc: string;
  result: string;
  id: number;
}

export async function sendJitoBundle(
  transactions: Transaction[],
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
            signedTx.serialize().toString("base64"),
          ),
          { encoding: "base64" },
        ],
      }),
    },
  ).then((res) => res.json() as Promise<JitoBundleResult>);

  return jitoBundleResult;
}
