import { StrategyType } from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { estimateDlmmDirectSwap, Zap, DlmmSingleSided } from "../src";
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
import { NATIVE_MINT } from "@solana/spl-token";

const JITO_PRIVATE_KEY = process.env.JITO_PRIVATE_KEY!;

const SWAP_SLIPPAGE_BPS = 1.5 * 100;

async function main() {
  const connection = new Connection(RPC_URL);
  const user = loadKeypairFromEnv();
  const dlmmPool = new PublicKey(
    "AsSyvUnbfaZJPRrNh3kUuvZTeHKoMVWEoHz86f4Q5D9x", // MET-SOL
  );
  const inputTokenMint = NATIVE_MINT;
  const amountUseToAddLiquidity = new BN(0.1 * 10 ** 9); // 0.1 SOL

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });
  const binDelta = 68;
  const singleSided = DlmmSingleSided.Y; // SOL
  // @ts-ignore this is intentional
  const isSingleSidedX = singleSided === DlmmSingleSided.X;
  const minDeltaId = isSingleSidedX ? 0 : -binDelta;
  const maxDeltaId = isSingleSidedX ? binDelta : 0;
  const favorXInActiveId = isSingleSidedX;

  const estimate = await estimateDlmmDirectSwap({
    user: user.publicKey,
    amountIn: amountUseToAddLiquidity,
    inputTokenMint: inputTokenMint,
    lbPair: dlmmPool,
    connection,
    swapSlippageBps: SWAP_SLIPPAGE_BPS,
    minDeltaId,
    maxDeltaId,
    strategy: StrategyType.Spot,
    jupiterQuoteOptions: { maxAccounts: 50 },
    singleSided,
    config: {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    },
  });

  const result = await zap.getZapInDlmmDirectParams({
    user: user.publicKey,
    maxActiveBinSlippage: 50,
    favorXInActiveId,
    maxTransferAmountExtendPercentage: 0,
    directSwapEstimate: estimate.result,
    ...estimate.context,
  });

  const position = Keypair.generate();
  const zapInDlmmTx = await zap.buildZapInDlmmTransaction({
    ...result,
    position: position.publicKey,
  });

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
    instructions: [...zapInDlmmTx.instructions, jitoTipsIx],
    addressLookupTableAccounts: zapInDlmmTx.addressLookupTableAccounts,
    computeUnitLimit: 1_400_000,
  });
  for (const tx of finalTx) {
    signV0Transaction(tx, [user, position]);

    // const simulate = await connection.simulateTransaction(tx);
    // console.log(simulate.value.logs);
    // console.log(simulate.value.err);
  }

  // return;

  console.log("Sending single-sided zap transaction (X only)...");
  const jitoBundleResult = await sendJitoBundle(finalTx, JITO_PRIVATE_KEY);
  console.log(jitoBundleResult);
  console.log(`Zap bundle sent: ${jitoBundleResult?.result}`);
}

main();
