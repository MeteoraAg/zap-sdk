import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { estimateDlmmRebalanceSwap, Zap } from "../src";
import Decimal from "decimal.js";
import BN from "bn.js";
import { createJitoTipIx, getKeypairFromSeed, sendJitoBundle } from "./helpers";

const JITO_PRIVATE_KEY = process.env.JITO_PRIVATE_KEY!;

const SWAP_SLIPPAGE_BPS = 1.5 * 100;

const keypairPath = "";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  // const user = getKeypairFromSeed(process.env.SEED_PHRASE!);
  const user = Keypair.fromSecretKey(Uint8Array.from([]));
  // ZEC-USDC
  const dlmmPool = new PublicKey(
    "9ToMYnmEeYKc1AWYAFo8yjPKM1bt3vPhgw1U6qh9RxBd"
  );
  const usdcMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const binDelta = 34;

  const dlmm = await DLMM.create(connection, dlmmPool);

  // const activeBin = await dlmm.getActiveBin();
  // const minBinId = activeBin.binId - binDelta;
  // const maxBinId = activeBin.binId + binDelta;
  // const isTokenX = usdcMint.equals(dlmm.lbPair.tokenXMint);
  // const amountToAddLiquidity = new BN(5).mul(new BN(10 ** 6)); // 5 USDC
  // const newPosition = Keypair.generate();
  // const createPositionTx =
  //   await dlmm.initializePositionAndAddLiquidityByStrategy({
  //     positionPubKey: newPosition.publicKey,
  //     user: user.publicKey,
  //     totalXAmount: isTokenX ? amountToAddLiquidity : new BN(0),
  //     totalYAmount: isTokenX ? new BN(0) : amountToAddLiquidity,
  //     strategy: {
  //       maxBinId,
  //       minBinId,
  //       strategyType: StrategyType.Spot,
  //     },
  //   });

  // createPositionTx.feePayer = user.publicKey;
  // createPositionTx.recentBlockhash = (
  //   await connection.getLatestBlockhash()
  // ).blockhash;

  // const sig = await connection.sendTransaction(createPositionTx, [
  //   user,
  //   newPosition,
  // ]);
  // console.log(sig);
  // console.log(`Position created: ${newPosition.publicKey.toString()}`);
  // return;

  const positionAddress = new PublicKey("YOUR POSITION ADDRESS");

  const zap = new Zap(connection);

  const estimate = await estimateDlmmRebalanceSwap({
    lbPair: dlmmPool,
    position: positionAddress,
    connection,
    swapSlippageBps: SWAP_SLIPPAGE_BPS,
    minDeltaId: -binDelta,
    maxDeltaId: binDelta,
    strategy: StrategyType.Spot,
  });

  const result = await zap.rebalanceDlmmPosition({
    user: user.publicKey,
    liquiditySlippageBps: 50,
    favorXInActiveId: false,
    directSwapEstimate: estimate.result,
    ...estimate.context,
  });

  // return;

  const finalTx = [];
  const res: { landed50: number } = (await fetch(
    "https://worker.jup.ag/jito-floor"
  ).then((res) => res.json())) as { landed50: number };

  const jitoFloor = res.landed50;

  console.log(`Jito floor: ${jitoFloor}`);

  const jitoTip = new Decimal(jitoFloor)
    .mul(10 ** 9)
    .toDP(0)
    .toNumber();

  const jitoTipsTx = createJitoTipIx({
    payer: user.publicKey,
    lamports: jitoTip.toString(),
  });

  if (result.setupTransaction) {
    finalTx.push(result.setupTransaction);
  }

  if (result.initBinArrayTransaction) {
    finalTx.push(result.initBinArrayTransaction);
  }

  if (result.rebalancePositionTransaction) {
    finalTx.push(result.rebalancePositionTransaction);
  }

  if (result.swapTransaction) {
    finalTx.push(result.swapTransaction);
  }
  finalTx.push(
    new Transaction().add(
      ...[
        result.ledgerTransaction,
        result.zapInTransaction,
        result.cleanUpTransaction,
        jitoTipsTx,
      ]
    )
  );

  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  for (const tx of finalTx) {
    tx.recentBlockhash = blockhash;
    tx.feePayer = user.publicKey;
    tx.sign(user);

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
