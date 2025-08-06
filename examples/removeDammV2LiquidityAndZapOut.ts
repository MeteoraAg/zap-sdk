import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Zap } from "../src/zap";
import { getJupiterQuote, getJupiterSwapInstruction } from "../src/helpers";
import {
  CpAmm,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
  getTokenProgram,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");

  const wallet = Keypair.fromSecretKey(Uint8Array.from([]));
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const inputMint = new PublicKey(
    "BFgdzMkTPdKKJeTipv2njtDEwhKxkgFueJQfJGt1jups"
  );
  const outputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );

  const poolAddress = new PublicKey(
    "7ccKzmrXBpFHwyZGPqPuKL6bEyWAETSnHwnWe3jEneVc"
  );

  const zap = new Zap(connection);
  const cpAmm = new CpAmm(connection);

  try {
    const [poolState, position, currentSlot] = await Promise.all([
      cpAmm.fetchPoolState(poolAddress),
      cpAmm.getUserPositionByPool(poolAddress, wallet.publicKey),
      connection.getSlot(),
    ]);

    const currentTime = await connection.getBlockTime(currentSlot);

    const liquidityDelta =
      position[0].positionState.unlockedLiquidity.divn(1000000); // remove liquidity with too small amount

    const amountARemoved = getAmountAFromLiquidityDelta(
      liquidityDelta,
      poolState.sqrtPrice,
      poolState.sqrtMaxPrice,
      Rounding.Down
    );

    const amountBRemoved = getAmountBFromLiquidityDelta(
      liquidityDelta,
      poolState.sqrtPrice,
      poolState.sqrtMinPrice,
      Rounding.Down
    );

    console.log({
      amountARemoved: amountARemoved.toString(),
      amountBRemoved: amountBRemoved.toString(),
    });

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
      currentPoint: new BN(currentTime ?? 0),
    });

    transaction.add(removeLiquidityTx);

    let inputTokenProgram = TOKEN_PROGRAM_ID;
    let outputTokenProgram = TOKEN_PROGRAM_ID;

    if (poolState.tokenAMint.equals(inputMint)) {
      inputTokenProgram = getTokenProgram(poolState.tokenAFlag);
      outputTokenProgram = getTokenProgram(poolState.tokenBFlag);
    } else {
      inputTokenProgram = getTokenProgram(poolState.tokenBFlag);
      outputTokenProgram = getTokenProgram(poolState.tokenAFlag);
    }

    console.log("Fetching quotes from DAMM v2 and Jupiter...");
    const [dammV2Quote, jupiterQuote] = await Promise.allSettled([
      cpAmm.getQuote({
        inAmount: amountARemoved,
        inputTokenMint: inputMint,
        slippage: 0.5,
        poolState: poolState,
        currentTime: currentTime ?? 0,
        currentSlot,
      }),
      getJupiterQuote(
        inputMint,
        outputMint,
        amountARemoved,
        50,
        50,
        true,
        true,
        "https://lite-api.jup.ag"
      ),
    ]);

    const quotes = {
      dammV2: dammV2Quote.status === "fulfilled" ? dammV2Quote.value : null,
      jupiter: jupiterQuote.status === "fulfilled" ? jupiterQuote.value : null,
    };

    if (quotes.dammV2) {
      console.log("DAMM v2 quote:", quotes.dammV2.swapOutAmount.toString());
    } else {
      console.log(
        "DAMM v2 quote failed:",
        dammV2Quote.status === "rejected" ? dammV2Quote.reason : "Unknown error"
      );
    }

    if (quotes.jupiter) {
      console.log("Jupiter quote:", quotes.jupiter.outAmount.toString());
    } else {
      console.log(
        "Jupiter quote failed:",
        jupiterQuote.status === "rejected"
          ? jupiterQuote.reason
          : "Unknown error"
      );
    }

    let bestQuoteValue: BN | null = null;
    let bestProtocol: string | null = null;

    if (quotes.dammV2?.swapOutAmount) {
      bestQuoteValue = quotes.dammV2.swapOutAmount;
      bestProtocol = "dammV2";
    }

    if (quotes.jupiter?.outAmount) {
      const jupiterAmount = new BN(quotes.jupiter.outAmount);
      if (!bestQuoteValue || jupiterAmount.gt(bestQuoteValue)) {
        bestQuoteValue = jupiterAmount;
        bestProtocol = "jupiter";
      }
    }

    if (!bestProtocol || !bestQuoteValue) {
      throw new Error("No valid quotes obtained from any protocol");
    }

    console.log(
      `Best protocol: ${bestProtocol} with quote:`,
      bestQuoteValue.toString()
    );

    let zapOutTx;

    if (bestProtocol === "dammV2") {
      zapOutTx = await zap.zapOutThroughDammV2({
        user: wallet.publicKey,
        poolAddress,
        inputMint,
        outputMint,
        inputTokenProgram,
        outputTokenProgram,
        amountIn: amountARemoved,
        minimumSwapAmountOut: new BN(0),
        maxSwapAmount: amountARemoved,
        percentageToZapOut: 100,
      });
    } else if (bestProtocol === "jupiter" && quotes.jupiter) {
      const swapInstructionResponse = await getJupiterSwapInstruction(
        wallet.publicKey,
        quotes.jupiter
      );

      zapOutTx = await zap.zapOutThroughJupiter({
        user: wallet.publicKey,
        inputMint,
        outputMint,
        inputTokenProgram,
        outputTokenProgram,
        jupiterSwapResponse: swapInstructionResponse,
        maxSwapAmount: new BN(quotes.jupiter.inAmount),
        percentageToZapOut: 100,
      });
    } else {
      throw new Error(`Invalid protocol selected: ${bestProtocol}`);
    }

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
