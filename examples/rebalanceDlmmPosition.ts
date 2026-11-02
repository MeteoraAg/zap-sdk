import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import BN from "bn.js";
import { estimateDlmmRebalanceSwap, Zap } from "../src";
import Decimal from "decimal.js";
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
  // The rebalance reads the position right after it is created, so reads must not wait for finalization.
  const connection = new Connection(RPC_URL, "confirmed");
  const user = loadKeypairFromEnv();
  // MET-SOL (x = MET, y = SOL)
  const dlmmPool = new PublicKey(
    "AsSyvUnbfaZJPRrNh3kUuvZTeHKoMVWEoHz86f4Q5D9x",
  );
  const binDelta = 34;

  // Create a SOL-only position in the active bin and the bins below it. The DLMM SDK wraps the SOL.
  // Unlike the DAMM v2 zap in, this cannot share a bundle with the rebalance, because the rebalance
  // reads the position's token amounts from the chain when it is built.
  const dlmm = await DLMM.create(connection, dlmmPool);
  const activeBin = await dlmm.getActiveBin();
  const amountToAddLiquidity = new BN(0.1 * LAMPORTS_PER_SOL); // 0.1 SOL
  const position = Keypair.generate();
  const createPositionTx =
    await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      user: user.publicKey,
      totalXAmount: new BN(0),
      totalYAmount: amountToAddLiquidity,
      strategy: {
        minBinId: activeBin.binId - binDelta,
        maxBinId: activeBin.binId,
        strategyType: StrategyType.Spot,
      },
    });
  const createPositionSignature = await sendAndConfirmTransaction(
    connection,
    createPositionTx,
    [user, position],
    { commitment: "confirmed" },
  );
  console.log(`Position created: ${createPositionSignature}`);

  const positionAddress = position.publicKey;

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });

  const estimate = await estimateDlmmRebalanceSwap({
    user: user.publicKey,
    lbPair: dlmmPool,
    position: positionAddress,
    connection,
    swapSlippageBps: SWAP_SLIPPAGE_BPS,
    minDeltaId: -binDelta,
    maxDeltaId: binDelta,
    strategy: StrategyType.Spot,
    jupiterQuoteOptions: { maxAccounts: 50 },
    config: {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    },
  });

  const result = await zap.rebalanceDlmmPosition({
    user: user.publicKey,
    liquiditySlippageBps: 50,
    favorXInActiveId: false,
    directSwapEstimate: estimate.result,
    ...estimate.context,
  });

  // return;

  const res: { landed50: number } = (await fetch(
    "https://worker.jup.ag/jito-floor",
  ).then((res) => res.json())) as { landed50: number };

  const jitoFloor = res.landed50;

  console.log(`Jito floor: ${jitoFloor}`);

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
    instructions: [...result.instructions, jitoTipsIx],
    addressLookupTableAccounts: result.addressLookupTableAccounts,
    computeUnitLimit: 1_400_000,
  });
  for (const tx of finalTx) {
    signV0Transaction(tx, [user]);
  }

  // return;

  console.log("Sending zap transaction...");
  const jitoBundleResult = await sendJitoBundle(finalTx, JITO_PRIVATE_KEY);
  console.log(jitoBundleResult);
  console.log(`Zap bundle sent: ${jitoBundleResult?.result}`);
  console.log(`Position: ${positionAddress.toBase58()}`);
}

main();
