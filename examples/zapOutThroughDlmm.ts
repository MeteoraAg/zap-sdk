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
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getTokenProgramFromMint, wrapSOLInstruction } from "../src/helpers";
import { JUPITER_API_KEY, JUPITER_API_URL } from "./constants";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");

  const wallet = Keypair.fromSecretKey(Uint8Array.from([]));
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const anotherWallet = Keypair.fromSecretKey(Uint8Array.from([]));
  console.log(`Using another wallet: ${anotherWallet.publicKey.toString()}`);

  const zap = new Zap(connection, JUPITER_API_URL, JUPITER_API_KEY);

  const inputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const outputMint = new PublicKey(
    "So11111111111111111111111111111111111111112"
  );
  const lbPairAddress = new PublicKey(
    "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"
  );

  const swapAmount = new BN(1000000);

  try {
    const { blockhash } = await connection.getLatestBlockhash();

    const inputTokenProgram = await getTokenProgramFromMint(
      connection,
      inputMint
    );

    const outputTokenProgram = await getTokenProgramFromMint(
      connection,
      outputMint
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
    } else {
      const wrapInstructions = wrapSOLInstruction(
        wallet.publicKey,
        inputTokenAccount,
        BigInt(swapAmount.toString()),
        TOKEN_PROGRAM_ID
      );

      transaction.add(...wrapInstructions);
    }

    const zapOutTx = await zap.zapOutThroughDlmm({
      user: wallet.publicKey,
      lbPairAddress,
      inputMint,
      outputMint,
      inputTokenProgram,
      outputTokenProgram,
      amountIn: new BN(swapAmount.toString()),
      minimumSwapAmountOut: new BN(0),
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
