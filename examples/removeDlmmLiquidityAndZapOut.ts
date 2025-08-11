import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import { Zap } from "../src/zap";
import { getJupiterQuote, getJupiterSwapInstruction } from "../src/helpers";
import DLMM, { getTokenProgramId } from "@meteora-ag/dlmm";
import { DLMM_PROGRAM_ID } from "../src";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import Decimal from "decimal.js";

export function createJitoTipIx({
  payer,
  lamports,
}: {
  payer: PublicKey;
  lamports: string;
}) {
  const tipAccount = new PublicKey(
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"
  );
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: tipAccount,
    lamports: BigInt(lamports),
  });
}

async function main() {
  const connection = new Connection(process.env.RPC_ENDPOINT as string);

  const wallet = Keypair.fromSecretKey(
    bs58.decode(process.env.WALLET_KEYPAIR as string)
  );
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const inputMint = new PublicKey(
    "So11111111111111111111111111111111111111112"
  );
  const outputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );

  const lbPairAddress = new PublicKey(
    "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"
  );

  const zap = new Zap(connection);
  const dlmm = await DLMM.create(connection, lbPairAddress, {
    cluster: "mainnet-beta",
    programId: new PublicKey(DLMM_PROGRAM_ID),
  });

  try {
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

    const amountXRemoved = totalAmountXRemoved
      .mul(new BN(100))
      .div(new BN(100));

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
          bps: new BN(100 * 100),
          shouldClaimAndClose: true,
        });
      })
    );

    const transaction: Transaction[] = [];

    removeLiquidityTxs.forEach((tx) => {
      transaction.push(...tx);
    });

    let inputTokenProgram = TOKEN_PROGRAM_ID;
    let outputTokenProgram = TOKEN_PROGRAM_ID;

    if (dlmm.lbPair.tokenXMint.equals(inputMint)) {
      const tokenPrograms = getTokenProgramId(dlmm.lbPair);
      inputTokenProgram = tokenPrograms.tokenXProgram;
      outputTokenProgram = tokenPrograms.tokenYProgram;
    } else {
      const tokenPrograms = getTokenProgramId(dlmm.lbPair);
      inputTokenProgram = tokenPrograms.tokenYProgram;
      outputTokenProgram = tokenPrograms.tokenXProgram;
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
        20,
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
    console.log("dmm", bestQuoteValue?.toString());

    if (quotes.jupiter?.outAmount) {
      const jupiterAmount = new BN(quotes.jupiter.outAmount);
      if (!bestQuoteValue || jupiterAmount.gt(bestQuoteValue)) {
        bestQuoteValue = jupiterAmount;
        bestProtocol = "jupiter";
      }
    }
    console.log("jup", bestQuoteValue?.toString());

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
        inputMint,
        outputMint,
        inputTokenProgram,
        outputTokenProgram,
        amountIn: amountXRemoved,
        minimumSwapAmountOut: new BN(0),
        maxSwapAmount: amountXRemoved,
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

    transaction.push(zapOutTx);

    const res: { landed50: number } = (await fetch(
      "https://worker.jup.ag/jito-floor"
    ).then((res) => res.json())) as { landed50: number };

    const jitoFloor = res.landed50;

    console.log(`Jito floor: ${jitoFloor}`);

    const jitoTip = new Decimal(jitoFloor)
      .mul(10 ** 9)
      .toDP(0)
      .toNumber();

    transaction[0].add(
      createJitoTipIx({ payer: wallet.publicKey, lamports: jitoTip.toString() })
    );

    const { blockhash } = await connection.getLatestBlockhash();

    for (const tx of transaction) {
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);
    }

    // const simulate = await connection.simulateTransaction(transaction);
    // console.log(simulate.value.logs);

    console.log("Sending zap transaction...");
    const jitoBundleResult: {
      result: string;
    } = (await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-jito-auth": process.env.PRIVATE_JITO_API_KEY,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [
          transaction.map((signedTx) =>
            signedTx.serialize().toString("base64")
          ),
          { encoding: "base64" },
        ],
      }),
    })
      .then((res) => res.json())
      .catch((err) => {
        console.error(err);
        return {
          result: err.message,
        };
      })) as {
      result: string;
    };

    console.log(jitoBundleResult);
    console.log(`Zap bundle sent: ${jitoBundleResult?.result}`);
  } catch (error) {
    console.error(error);
  }
}

main().catch(console.error);
