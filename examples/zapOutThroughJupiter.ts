import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Zap } from "../src/zap";
import {
  getJupiterQuote,
  getJupiterSwapInstruction,
  getTokenProgramFromMint,
} from "../src/helpers";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");

  const wallet = Keypair.fromSecretKey(Uint8Array.from(""));
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const zap = new Zap(connection);

  const inputMint = new PublicKey(
    "So11111111111111111111111111111111111111112"
  );
  const outputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );

  const swapAmount = new BN(10000000);

  try {
    console.log("Getting quote from Jupiter API...");
    const quoteResponse = await getJupiterQuote(
      inputMint,
      outputMint,
      swapAmount,
      40,
      50,
      true,
      true,
      true,
      "https://lite-api.jup.ag"
    );

    console.log("Getting swap instruction from Jupiter API...");
    const swapInstructionResponse = await getJupiterSwapInstruction(
      wallet.publicKey,
      quoteResponse
    );

    // console.log(swapInstructionResponse);
    const { blockhash } = await connection.getLatestBlockhash();

    // Get token programs for input and output mints
    console.log("Getting token programs...");
    const outputTokenProgram = await getTokenProgramFromMint(
      connection,
      outputMint
    );

    const inputTokenProgram = await getTokenProgramFromMint(
      connection,
      inputMint
    );

    console.log("4. Building zap transaction...");
    const zapOutTx = await zap.zapOutThroughJupiter({
      user: wallet.publicKey,
      inputMint,
      outputMint,
      inputTokenProgram: inputTokenProgram,
      outputTokenProgram: outputTokenProgram,
      jupiterSwapResponse: swapInstructionResponse,
      maxSwapAmount: new BN(swapAmount.toString()),
      percentageToZapOut: 100,
    });

    const transaction = new Transaction();

    transaction.add(zapOutTx);

    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    const simulate = await connection.simulateTransaction(transaction);
    console.log(simulate.value.logs);

    console.log("Sending zap transaction...");
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [wallet],
      { commitment: "confirmed" }
    );

    console.log(`Wrap + Zap transaction sent: ${signature}`);
  } catch (error) {
    console.error(error);
  }
}

main().catch(console.error);
