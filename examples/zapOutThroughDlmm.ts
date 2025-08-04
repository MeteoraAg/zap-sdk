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
} from "@solana/spl-token";
import { getTokenProgramFromMint } from "../src/helpers";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");

  const wallet = Keypair.fromSecretKey(Uint8Array.from(""));
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const anotherWallet = Keypair.fromSecretKey(Uint8Array.from(""));
  console.log(`Using wallet: ${anotherWallet.publicKey.toString()}`);

  const zap = new Zap(connection);

  const inputMint = NATIVE_MINT;

  const lbPairAddress = new PublicKey(
    "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"
  );

  const swapAmount = new BN(10000000);

  // Get pool info to determine output mint
  const { getLbPairState } = await import("../src/helpers");
  const poolState = await getLbPairState(connection, lbPairAddress);

  const outputMint = poolState.tokenXMint.equals(inputMint)
    ? poolState.tokenYMint
    : poolState.tokenXMint;

  try {
    console.log("Getting swap instruction from Dlmm...");

    const { blockhash } = await connection.getLatestBlockhash();

    // Get token programs for input mint
    console.log("Getting token programs...");

    const inputTokenProgram = await getTokenProgramFromMint(
      connection,
      inputMint
    );

    console.log("Building zap transaction...");
    const zapOutTx = await zap.zapOutThroughDlmm({
      user: wallet.publicKey,
      lbPairAddress,
      inputMint,
      inputTokenProgram: inputTokenProgram,
      amountIn: new BN(swapAmount.toString()),
      minimumSwapAmountOut: new BN(0),
      maxSwapAmount: new BN(swapAmount.toString()),
      percentageToZapOut: 100,
    });

    const transaction = new Transaction();

    const inputTokenAccount = getAssociatedTokenAddressSync(
      inputMint,
      wallet.publicKey,
      true,
      inputTokenProgram
    );

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

    transaction.add(zapOutTx);

    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    const simulate = await connection.simulateTransaction(transaction);
    console.log(simulate.value.logs);

    console.log("Sending zap transaction...");
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [wallet /*anotherWallet*/],
      { commitment: "confirmed" }
    );

    console.log(`Zap transaction sent: ${signature}`);
  } catch (error) {
    console.error(error);
  }
}

main().catch(console.error);
