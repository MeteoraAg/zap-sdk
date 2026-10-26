import { StrategyType } from "@meteora-ag/dlmm";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { estimateDlmmDirectSwap, Zap } from "../src";
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
  // SOL-USDC
  const dlmmPool = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
  const inputTokenMint = NATIVE_MINT;
  const amountUseToAddLiquidity = new BN(0.1 * 10 ** 9); // 0.1 SOL

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });
  const binDelta = 34;
  const estimate = await estimateDlmmDirectSwap({
    user: user.publicKey,
    amountIn: amountUseToAddLiquidity,
    inputTokenMint: inputTokenMint,
    lbPair: dlmmPool,
    connection,
    swapSlippageBps: SWAP_SLIPPAGE_BPS,
    minDeltaId: -binDelta,
    maxDeltaId: binDelta,
    strategy: StrategyType.Spot,
    config: {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    },
  });

  // Example only: maxAccounts=50 + Direct estimator (onlyDirectRoutes=true).
  // Validate quoted outAmount vs market before sending. Not safe for every pool/size.
  const result = await zap.getZapInDlmmDirectParams({
    user: user.publicKey,
    directSwapEstimate: estimate.result,
    maxActiveBinSlippage: 50,
    favorXInActiveId: false,
    maxAccounts: 50,
    maxTransferAmountExtendPercentage: 0,
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

  console.log("Sending zap transaction...");
  const jitoBundleResult = await sendJitoBundle(finalTx, JITO_PRIVATE_KEY);
  console.log(jitoBundleResult);
  console.log(`Zap bundle sent: ${jitoBundleResult?.result}`);
}

main();
