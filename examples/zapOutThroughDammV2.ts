import {
  Connection,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
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
import { JUPITER_API_KEY, JUPITER_API_URL, RPC_URL } from "./constants";
import { loadKeypairFromEnv, signV0Transaction } from "./helpers";

async function main() {
  const connection = new Connection(RPC_URL);

  const wallet = loadKeypairFromEnv();
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const anotherWallet = loadKeypairFromEnv("ANOTHER_SECRET_KEY_PATH");
  console.log(`Using another wallet: ${anotherWallet.publicKey.toString()}`);

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });

  const inputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const outputMint = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );

  const poolAddress = new PublicKey(
    "CGPxT5d1uf9a8cKVJuZaJAU76t2EfLGbTmRbfvLLZp5j",
  );

  const swapAmount = new BN(1000000);

  try {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const inputTokenProgram = await getTokenProgramFromMint(
      connection,
      inputMint,
    );

    const outputTokenProgram = await getTokenProgramFromMint(
      connection,
      outputMint,
    );

    const inputTokenAccount = getAssociatedTokenAddressSync(
      inputMint,
      wallet.publicKey,
      true,
      inputTokenProgram,
    );

    const transaction = new Transaction();

    // simulate action (can be claim fee or remove liquidity etc.)
    if (!inputMint.equals(NATIVE_MINT)) {
      const sourceTokenAccount = getAssociatedTokenAddressSync(
        inputMint,
        anotherWallet.publicKey,
        true,
        inputTokenProgram,
      );

      const transferIx = createTransferCheckedInstruction(
        sourceTokenAccount,
        inputMint,
        inputTokenAccount,
        anotherWallet.publicKey,
        BigInt(swapAmount.toString()),
        6,
        [],
        inputTokenProgram,
      );

      transaction.add(transferIx);
    } else {
      const wrapInstructions = wrapSOLInstruction(
        wallet.publicKey,
        inputTokenAccount,
        BigInt(swapAmount.toString()),
        TOKEN_PROGRAM_ID,
      );

      transaction.add(...wrapInstructions);
    }

    const zapOutTx = await zap.zapOutThroughDammV2({
      user: wallet.publicKey,
      poolAddress,
      inputMint,
      outputMint,
      inputTokenProgram,
      outputTokenProgram,
      amountIn: new BN(swapAmount.toString()),
      minimumSwapAmountOut: new BN(0),
      maxSwapAmount: new BN(swapAmount.toString()),
      percentageToZapOut: 100,
    });

    const versionedTransaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [...transaction.instructions, ...zapOutTx.instructions],
      }).compileToV0Message(zapOutTx.addressLookupTableAccounts),
    );
    signV0Transaction(versionedTransaction, [wallet, anotherWallet]);

    const simulate = await connection.simulateTransaction(versionedTransaction);
    console.log(simulate.value.logs);

    console.log("Sending zap transaction...");
    const signature = await connection.sendTransaction(versionedTransaction);
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    console.log(`Zap transaction sent: ${signature}`);
  } catch (error) {
    console.error(error);
  }
}

main().catch(console.error);
