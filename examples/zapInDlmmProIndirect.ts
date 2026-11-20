import {
  DlmmProClient,
  StrategyType,
  buildLiquidityShape,
} from "@meteora-ag/dlmm-pro-sdk";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { Zap, estimateDlmmProIndirectSwap } from "../src";
import Decimal from "decimal.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import {
  buildV0Transactions,
  createJitoTipIx,
  loadKeypairFromEnv,
  sendJitoBundle,
  signV0Transaction,
} from "./helpers";
import { JUPITER_API_KEY, JUPITER_API_URL, RPC_URL } from "./constants";

const JITO_PRIVATE_KEY = process.env.JITO_PRIVATE_KEY!;

const SWAP_SLIPPAGE_BPS = 1.5 * 100;

(async () => {
  const connection = new Connection(RPC_URL);
  const user = loadKeypairFromEnv();
  // a DLMM Pro pool with neither of its tokens being SOL
  const dlmmProPool = new PublicKey(process.env.DLMM_PRO_POOL!);
  const inputTokenMint = NATIVE_MINT;

  const amountUseToAddLiquidity = new BN(0.001 * LAMPORTS_PER_SOL);

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });

  // The position ranges are absolute tick ids. Here, a Spot shape 20 tick spacings on each side
  // of the pool tick.
  const { tickCurrentId, tickSpacing } = await new DlmmProClient(
    connection,
  ).state.fetchPool(dlmmProPool);
  const alignedTickId = Math.floor(tickCurrentId / tickSpacing) * tickSpacing;
  const tickDelta = 20 * tickSpacing;
  const { ranges } = buildLiquidityShape({
    strategy: StrategyType.Spot,
    minTickId: alignedTickId - tickDelta,
    maxTickId: alignedTickId + tickDelta,
    tickSpacing,
    currentTickId: tickCurrentId,
  });

  const estimate = await estimateDlmmProIndirectSwap({
    user: user.publicKey,
    amountIn: amountUseToAddLiquidity,
    inputTokenMint: inputTokenMint,
    pool: dlmmProPool,
    connection,
    swapSlippageBps: SWAP_SLIPPAGE_BPS,
    ranges,
    jupiterQuoteOptions: { maxAccounts: 50 },
    config: {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    },
  });

  const result = await zap.getZapInDlmmProIndirectParams({
    user: user.publicKey,
    indirectSwapEstimate: estimate.result,
    maxTickSlippage: 5 * tickSpacing,
    // the zap in fails when it adds less than 99% of the estimated liquidity
    minMultiplier: estimate.result.multiplier.muln(99).divn(100),
    // The two swaps rarely return the exact ratio the shape takes. What is left of one token goes
    // into a single-sided range from next to the price to the edge of the shape on its side.
    leftover: {
      rangeX: {
        innerTickId: 0,
        outerTickId: alignedTickId + tickDelta + tickSpacing,
      },
      rangeY: { innerTickId: 0, outerTickId: alignedTickId - tickDelta },
      isInnerTickRelative: true,
    },
    maxTransferAmountExtendPercentage: 0,
    ...estimate.context,
  });

  // the NFT mint of the new position, it signs the zap-in transaction
  const nftMint = Keypair.generate();
  const zapInDlmmProTx = await zap.buildZapInDlmmProTransaction({
    ...result,
    nftMint: nftMint.publicKey,
  });

  // return;

  const res: { landed50: number } = (await fetch(
    "https://worker.jup.ag/jito-floor",
  ).then((res) => res.json())) as { landed50: number };

  const jitoFloor = res.landed50;

  const jitoTip = new Decimal(jitoFloor)
    .mul(10 ** 9)
    .toDP(0)
    .toNumber();

  const jitoTipsIx = createJitoTipIx({
    payer: user.publicKey,
    lamports: jitoTip.toString(),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const finalTx = buildV0Transactions({
    payer: user.publicKey,
    blockhash,
    instructions: [...zapInDlmmProTx.instructions, jitoTipsIx],
    addressLookupTableAccounts: zapInDlmmProTx.addressLookupTableAccounts,
    computeUnitLimit: 1_400_000,
  });
  for (const tx of finalTx) {
    signV0Transaction(tx, [user, nftMint]);

    // const simulate = await connection.simulateTransaction(tx);
    // console.log(simulate.value.logs);
    // console.log(simulate.value.err);
  }

  // return;

  console.log("Sending zap transaction...");
  const jitoBundleResult = await sendJitoBundle(finalTx, JITO_PRIVATE_KEY);
  console.log(jitoBundleResult);
  console.log(`Zap bundle sent: ${jitoBundleResult?.result}`);
})();
