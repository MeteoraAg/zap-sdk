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
import {
  getJupiterQuote,
  getJupiterSwapInstruction,
  getOrCreateATAInstruction,
  getTokenProgramFromMint,
} from "../src/helpers";
import DLMM from "@meteora-ag/dlmm";
import { DLMM_PROGRAM_ID } from "../src";

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

  const lbPairAddress = new PublicKey(
    "9NRifL3nKQU84hMTbhE7spakkGy5vq4AvNHNQYr8LkW7"
  );

  const zap = new Zap(connection);
  const dlmm = await DLMM.create(connection, lbPairAddress, {
    cluster: "mainnet-beta",
    programId: new PublicKey(DLMM_PROGRAM_ID),
  });

  try {
    const preInstructions: TransactionInstruction[] = [];
    const postInstructions: TransactionInstruction[] = [];

    const currentSlot = await connection.getSlot();
    const currentTime = await connection.getBlockTime(currentSlot);

    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(
      wallet.publicKey
    );

    if (userPositions.length === 0) {
      throw new Error("No positions found for this user");
    }

    let totalAmountXRemoved = new BN(0);
    let totalAmountYRemoved = new BN(0);

    for (const { positionData } of userPositions) {
      for (const binData of positionData.positionBinData) {
        totalAmountXRemoved = totalAmountXRemoved.add(
          new BN(binData.positionXAmount)
        );
        totalAmountYRemoved = totalAmountYRemoved.add(
          new BN(binData.positionYAmount)
        );
      }
    }

    const amountXRemoved = totalAmountXRemoved.mul(new BN(1)).div(new BN(100));

    console.log({
      amountXRemoved: amountXRemoved.toString(),
      amountYRemoved: totalAmountYRemoved
        .mul(new BN(1))
        .div(new BN(100))
        .toString(),
      totalAmountX: totalAmountXRemoved.toString(),
      totalAmountY: totalAmountYRemoved.toString(),
    });

    const removeLiquidityTxs = await Promise.all(
      userPositions.map(({ publicKey, positionData }) => {
        const binIdsToRemove = positionData.positionBinData.map(
          (bin) => bin.binId
        );
        return dlmm.removeLiquidity({
          position: publicKey,
          user: wallet.publicKey,
          fromBinId: binIdsToRemove[0],
          toBinId: binIdsToRemove[binIdsToRemove.length - 1],
          bps: new BN(1 * 100), // Remove 1% of liquidity
          shouldClaimAndClose: true,
        });
      })
    );

    const transaction = new Transaction();

    removeLiquidityTxs.forEach((tx) => {
      transaction.add(...tx);
    });

    const [inputTokenProgram, outputTokenProgram] = await Promise.all([
      getTokenProgramFromMint(connection, inputMint),
      getTokenProgramFromMint(connection, outputMint),
    ]);

    const [
      { ataPubkey: inputTokenAccount, ix: inputTokenAccountIx },
      { ataPubkey: outputTokenAccount, ix: outputTokenAccountIx },
    ] = await Promise.all([
      getOrCreateATAInstruction(
        connection,
        inputMint,
        wallet.publicKey,
        wallet.publicKey,
        true,
        inputTokenProgram
      ),
      getOrCreateATAInstruction(
        connection,
        outputMint,
        wallet.publicKey,
        wallet.publicKey,
        true,
        outputTokenProgram
      ),
    ]);

    if (inputTokenAccountIx) {
      preInstructions.push(inputTokenAccountIx);
    }

    if (outputTokenAccountIx) {
      preInstructions.push(outputTokenAccountIx);
    }

    console.log("Fetching quotes from DLMM and Jupiter...");
    const [dlmmQuote, jupiterQuote] = await Promise.allSettled([
      dlmm
        .getBinArrayForSwap(true, 5)
        .then((binArrays) =>
          dlmm.swapQuote(amountXRemoved, true, new BN(50), binArrays)
        ),
      getJupiterQuote(
        inputMint,
        outputMint,
        amountXRemoved,
        50,
        50,
        true,
        true,
        "https://lite-api.jup.ag"
      ),
    ]);

    const quotes = {
      dlmm: dlmmQuote.status === "fulfilled" ? dlmmQuote.value : null,
      jupiter: jupiterQuote.status === "fulfilled" ? jupiterQuote.value : null,
    };

    if (quotes.dlmm) {
      console.log("DLMM quote:", quotes.dlmm.outAmount.toString());
    } else {
      console.log(
        "DLMM quote failed:",
        dlmmQuote.status === "rejected" ? dlmmQuote.reason : "Unknown error"
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

    if (quotes.dlmm?.outAmount) {
      bestQuoteValue = quotes.dlmm.outAmount;
      bestProtocol = "dlmm";
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

    if (bestProtocol === "dlmm") {
      zapOutTx = await zap.zapOutThroughDlmm({
        user: wallet.publicKey,
        lbPairAddress,
        inputTokenAccount,
        outputTokenAccount,
        amountIn: amountXRemoved,
        minimumSwapAmountOut: new BN(0),
        maxSwapAmount: amountXRemoved,
        percentageToZapOut: 100,
        preInstructions,
        postInstructions,
      });
    } else if (bestProtocol === "jupiter" && quotes.jupiter) {
      const swapInstructionResponse = await getJupiterSwapInstruction(
        wallet.publicKey,
        quotes.jupiter
      );

      zapOutTx = await zap.zapOutThroughJupiter({
        inputTokenAccount,
        jupiterSwapResponse: swapInstructionResponse,
        maxSwapAmount: new BN(quotes.jupiter.inAmount),
        percentageToZapOut: 100,
        preInstructions,
        postInstructions,
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
