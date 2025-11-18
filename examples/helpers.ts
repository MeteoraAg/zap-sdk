import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { mnemonicToSeedSync } from "bip39";
import { derivePath } from "ed25519-hd-key";

const STANDARD_DERIVATION_PATH = "m/44'/501'/0'/0'";
// https://jito-foundation.gitbook.io/mev/mev-payment-and-distribution/on-chain-addresses
const JITO_TIP_ACCOUNT = new PublicKey(
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"
);

// Derives a Keypair from a seed phrase using Solana's standard derivation path
export function getKeypairFromSeed(
  seedPhrase: string,
  derivationPath: string = STANDARD_DERIVATION_PATH
): Keypair {
  const seed = mnemonicToSeedSync(seedPhrase, "");
  const derivedSeed = derivePath(derivationPath, seed.toString("hex")).key;
  return Keypair.fromSeed(derivedSeed);
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
  JITO_PRIVATE_KEY: string
) {
  const jitoBundleResult = await fetch(
    "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-jito-auth": JITO_PRIVATE_KEY,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [
          transactions.map((signedTx) =>
            signedTx.serialize().toString("base64")
          ),
          { encoding: "base64" },
        ],
      }),
    }
  ).then((res) => res.json() as Promise<JitoBundleResult>);

  return jitoBundleResult;
}
