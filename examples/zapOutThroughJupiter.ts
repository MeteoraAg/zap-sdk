import {
  Connection,
  Keypair,
  PublicKey,
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
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");

  const wallet = Keypair.fromSecretKey(Uint8Array.from([]));
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const anotherWallet = Keypair.fromSecretKey(Uint8Array.from([]));
  console.log(`Using another wallet: ${anotherWallet.publicKey.toString()}`);

  const zap = new Zap(connection);

  const inputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const outputMint = new PublicKey(
    "So11111111111111111111111111111111111111112"
  );

  const swapAmount = new BN(1000000);

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
      "https://lite-api.jup.ag"
    );

    console.log("Getting swap instruction from Jupiter API...");
    const swapInstructionResponse = await getJupiterSwapInstruction(
      wallet.publicKey,
      quoteResponse
    );
    // console.log(swapInstructionResponse);
    const { blockhash } = await connection.getLatestBlockhash();

    const inputTokenProgram = await getTokenProgramFromMint(
      connection,
      inputMint
    );

    const inputTokenAccount = getAssociatedTokenAddressSync(
      inputMint,
      wallet.publicKey,
      true,
      inputTokenProgram
    );

    const transaction = new Transaction();

    // simulate action (can be claim fee or remove liquidity etc.)
    if (!inputMint.equals(NATIVE_MINT)) {
      const sourceTokenAccount = getAssociatedTokenAddressSync(
        inputMint,
        anotherWallet.publicKey,
        true,
        inputTokenProgram
      );

      const transferIx = createTransferCheckedInstruction(
        sourceTokenAccount,
        inputMint,
        inputTokenAccount,
        anotherWallet.publicKey,
        BigInt(swapAmount.toString()),
        6,
        [],
        inputTokenProgram
      );

      transaction.add(transferIx);
    }

    const zapOutTx = await zap.zapOutThroughJupiter({
      user: wallet.publicKey,
      inputMint,
      outputMint,
      jupiterSwapResponse: swapInstructionResponse,
      maxSwapAmount: new BN(swapAmount.toString()),
      percentageToZapOut: 100,
    });

    transaction.add(zapOutTx);

    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    const simulate = await connection.simulateTransaction(transaction);
    console.log(simulate.value.logs);

    console.log("Sending zap transaction...");
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [wallet, anotherWallet],
      { commitment: "confirmed" }
    );

    console.log(`Zap transaction sent: ${signature}`);
  } catch (error) {
    console.error(error);
  }
}

main().catch(console.error);
