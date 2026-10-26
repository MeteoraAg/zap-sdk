import { StrategyType } from "@meteora-ag/dlmm";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { Zap, estimateDlmmIndirectSwap, DlmmSingleSided } from "../src";
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

async function main() {
  const connection = new Connection(RPC_URL);
  const user = loadKeypairFromEnv();
  // MET-USDC pool (x = MET, y = USDC)
  const dlmmPool = new PublicKey(
    "5hbf9JP8k5zdrZp9pokPypFQoBse5mGCmW6nqodurGcd",
  );
  const inputTokenMint = NATIVE_MINT;

  const amountUseToAddLiquidity = new BN(0.001 * LAMPORTS_PER_SOL);

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });
  const binDelta = 34;
  const singleSided = DlmmSingleSided.X; // MET
  // @ts-ignore this is intentional
  const isSingleSidedX = singleSided === DlmmSingleSided.X;
  const minDeltaId = isSingleSidedX ? 0 : -binDelta;
  const maxDeltaId = isSingleSidedX ? binDelta : 0;
  const favorXInActiveId = isSingleSidedX;

  // Pass singleSided to estimateIndirectSwap
  const estimate = await estimateDlmmIndirectSwap({
    user: user.publicKey,
    amountIn: amountUseToAddLiquidity,
    inputTokenMint: inputTokenMint,
    lbPair: dlmmPool,
    connection: connection,
    swapSlippageBps: SWAP_SLIPPAGE_BPS,
    minDeltaId,
    maxDeltaId,
    strategy: StrategyType.Spot,
    singleSided,
    config: {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    },
  });

  const result = await zap.getZapInDlmmIndirectParams({
    user: user.publicKey,
    maxActiveBinSlippage: 50,
    favorXInActiveId,
    indirectSwapEstimate: estimate.result,
    maxAccounts: 50,
    maxTransferAmountExtendPercentage: 0,
    singleSided,
    ...estimate.context,
  });

  const position = Keypair.generate();
  const zapInDlmmTx = await zap.buildZapInDlmmTransaction({
    ...result,
    position: position.publicKey,
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
