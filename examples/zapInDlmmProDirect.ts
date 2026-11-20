import {
  DlmmProClient,
  StrategyType,
  buildLiquidityShape,
} from "@meteora-ag/dlmm-pro-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { estimateDlmmProDirectSwap, Zap } from "../src";
import Decimal from "decimal.js";
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

async function main() {
  const connection = new Connection(RPC_URL);
  const user = loadKeypairFromEnv();
  // a DLMM Pro pool with SOL as one of its tokens
  const dlmmProPool = new PublicKey(process.env.DLMM_PRO_POOL!);
  const inputTokenMint = NATIVE_MINT;
  const amountUseToAddLiquidity = new BN(0.1 * 10 ** 9); // 0.1 SOL

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });

  // The position ranges are absolute tick ids. Here, a Spot shape 20 tick spacings on each side
  // of the pool tick. Ranges on one side of the pool tick only make a single-sided position.
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

  const estimate = await estimateDlmmProDirectSwap({
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

  // Example only: the estimate above quoted Jupiter with maxAccounts=50.
  // Validate quoted outAmount vs market before sending. Not safe for every pool/size.
  const result = await zap.getZapInDlmmProDirectParams({
    user: user.publicKey,
    directSwapEstimate: estimate.result,
    maxTickSlippage: 5 * tickSpacing,
    // the zap in fails when it adds less than 99% of the estimated liquidity
    minMultiplier: estimate.result.multiplier.muln(99).divn(100),
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
}

main();
