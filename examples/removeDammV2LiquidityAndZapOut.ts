import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Zap } from "../src/zap";
import { getTokenProgramFromMint } from "../src/helpers";
import {
  CpAmm,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
  getTokenProgram,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");

  const wallet = Keypair.fromSecretKey(Uint8Array.from(""));
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const zap = new Zap(connection);
  const cpAmm = new CpAmm(connection);

  const inputMint = new PublicKey(
    "6fXwi8pw9CnxcqcuGFGFBBDcD4vG8E5VkeqFRYXTet6g"
  );
  const outputMint = NATIVE_MINT;

  const poolAddress = new PublicKey(
    "3TeMd6TDxypJzKzApLLmsMuboW49ZbbfH2jSwHsW5YEr"
  );

  try {
    const preInstructions: TransactionInstruction[] = [];
    const postInstructions: TransactionInstruction[] = [];

    const poolState = await cpAmm.fetchPoolState(poolAddress);

    const position = await cpAmm.getUserPositionByPool(
      poolAddress,
      wallet.publicKey
    );

    const liquidityDelta =
      position[0].positionState.unlockedLiquidity.divn(1000000); // remove liquidity with too small amount

    const amountARemoved = getAmountAFromLiquidityDelta(
      liquidityDelta,
      poolState.sqrtPrice,
      poolState.sqrtMaxPrice,
      Rounding.Up
    );

    const amountBRemoved = getAmountBFromLiquidityDelta(
      liquidityDelta,
      poolState.sqrtPrice,
      poolState.sqrtMinPrice,
      Rounding.Up
    );

    console.log({
      amountARemoved: amountARemoved.toString(),
      amountBRemoved: amountBRemoved.toString(),
    });

    const currentPoint = await connection.getSlot();

    const transaction = new Transaction();

    const removeLiquidityTx = await cpAmm.removeLiquidity({
      owner: wallet.publicKey,
      pool: poolAddress,
      position: position[0].position,
      positionNftAccount: position[0].positionNftAccount,
      liquidityDelta,
      tokenAAmountThreshold: new BN(0),
      tokenBAmountThreshold: new BN(0),
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: getTokenProgram(poolState.tokenBFlag),
      vestings: [],
      currentPoint: new BN(currentPoint),
    });

    transaction.add(removeLiquidityTx);

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

    const outputTokenAccount = getAssociatedTokenAddressSync(
      outputMint,
      wallet.publicKey,
      true,
      outputTokenProgram
    );

    const zapOutTx = await zap.zapOutThroughDammV2({
      user: wallet.publicKey,
      poolAddress,
      inputTokenAccount,
      outputTokenAccount,
      amountIn: amountARemoved,
      minimumSwapAmountOut: new BN(0),
      maxSwapAmount: amountARemoved,
      percentageToZapOut: 100,
      preInstructions,
      postInstructions,
    });

    transaction.add(zapOutTx);

    const { blockhash } = await connection.getLatestBlockhash();

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

    console.log(`Zap transaction sent: ${signature}`);
  } catch (error) {
    console.error(error);
  }
}

main().catch(console.error);
