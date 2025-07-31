import {
  Connection,
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import { deriveTokenLedgerAddress } from "../src/helpers/pda";
import { Zap } from "../src/zap";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { JupiterQuoteResponse, JupiterSwapInstructionResponse } from "../src";

const keypair = [];

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");

  const wallet = Keypair.fromSecretKey(new Uint8Array(keypair));
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const zap = new Zap(connection);

  const inputMint = new PublicKey(
    "So11111111111111111111111111111111111111112"
  );
  const outputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );

  const inputMintTokenLedgerAccount = deriveTokenLedgerAddress(inputMint);

  const swapAmount = new BN(1000000);

  try {
    await setupTokenLedger(
      connection,
      zap,
      wallet,
      inputMint,
      inputMintTokenLedgerAccount,
      swapAmount
    );

    console.log("\n1. Getting quote from Jupiter API...");
    const quoteResponse = await getJupiterQuote(
      inputMint,
      outputMint,
      swapAmount
    );

    console.log("2. Getting swap instruction from Jupiter API...");
    const swapInstructionResponse = await getJupiterSwapInstruction(
      wallet.publicKey,
      quoteResponse
    );

    const zapOutTx = await zap.zapOutThroughJupiter({
      user: wallet.publicKey,
      inputMint,
      outputMint,
      inputTokenAccount: inputMintTokenLedgerAccount,
      jupiterSwapResponse: swapInstructionResponse,
    });

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    zapOutTx.recentBlockhash = blockhash;
    zapOutTx.feePayer = wallet.publicKey;

    const signature = await sendAndConfirmTransaction(
      connection,
      zapOutTx,
      [wallet],
      { commitment: "confirmed" }
    );

    console.log(`Zap out transaction sent: ${signature}`);
  } catch (error) {
    console.error(error);
  }
}

/**
 * Setup and fund token ledger if needed
 */
async function setupTokenLedger(
  connection: Connection,
  zap: Zap,
  wallet: Keypair,
  inputMint: PublicKey,
  inputTokenAccount: PublicKey,
  requiredAmount: BN
): Promise<void> {
  console.log("Checking token ledger account...");
  const tokenLedgerInfo = await connection.getAccountInfo(inputTokenAccount);

  if (!tokenLedgerInfo) {
    console.log("Token ledger not found, initializing...");
    const initTx = await zap.initializeTokenLedger(
      wallet.publicKey,
      inputMint,
      TOKEN_PROGRAM_ID
    );

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    initTx.recentBlockhash = blockhash;
    initTx.feePayer = wallet.publicKey;

    const initSignature = await sendAndConfirmTransaction(
      connection,
      initTx,
      [wallet],
      { commitment: "confirmed" }
    );

    console.log(`Token ledger initialized: ${initSignature}`);
  } else {
    console.log("Token ledger already exists");
  }

  const tokenLedgerBalance = await connection.getBalance(inputTokenAccount);
  console.log(`Token ledger balance: ${tokenLedgerBalance} lamports`);

  if (
    tokenLedgerBalance === 0 ||
    new BN(tokenLedgerBalance).lt(requiredAmount)
  ) {
    console.log(
      `Funding token ledger with ${requiredAmount.toString()} lamports...`
    );

    const fundTx = new Transaction();
    fundTx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: inputTokenAccount,
        lamports: requiredAmount.toNumber(),
      })
    );

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    fundTx.recentBlockhash = blockhash;
    fundTx.feePayer = wallet.publicKey;

    const fundSignature = await sendAndConfirmTransaction(
      connection,
      fundTx,
      [wallet],
      { commitment: "confirmed" }
    );

    console.log(`Token ledger funded: ${fundSignature}`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const updatedBalance = await connection.getBalance(inputTokenAccount);
    console.log(`Updated balance: ${updatedBalance} lamports`);
  }
}

async function getJupiterQuote(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN
): Promise<JupiterQuoteResponse> {
  const params = new URLSearchParams({
    inputMint: inputMint.toString(),
    outputMint: outputMint.toString(),
    amount: amount.toString(),
    slippageBps: "50",
  });

  const url = `https://lite-api.jup.ag/swap/v1/quote?${params.toString()}`;

  console.log(url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jupiter quote failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as JupiterQuoteResponse;

  return result;
}

async function getJupiterSwapInstruction(
  userPublicKey: PublicKey,
  quoteResponse: any
): Promise<JupiterSwapInstructionResponse> {
  const url = "https://lite-api.jup.ag/swap/v1/swap-instructions";

  const requestBody = {
    userPublicKey: userPublicKey.toString(),
    quoteResponse,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Jupiter swap instruction failed (${response.status}): ${errorText}`
    );
  }

  const result = (await response.json()) as JupiterSwapInstructionResponse;

  return result;
}

main().catch(console.error);
