import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { Zap, estimateDlmmIndirectSwap } from "../src";
import Decimal from "decimal.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { createJitoTipIx, getKeypairFromSeed, sendJitoBundle } from "./helpers";

const JITO_PRIVATE_KEY = process.env.JITO_PRIVATE_KEY!;

const keypairPath = "";

const SWAP_SLIPPAGE_BPS = 1.5 * 100;

(async () => {
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  // const user = getKeypairFromSeed(process.env.SEED_PHRASE!);
  const user = Keypair.fromSecretKey(Uint8Array.from([]));
  // MET-USDC pool
  const dlmmPool = new PublicKey(
    "5hbf9JP8k5zdrZp9pokPypFQoBse5mGCmW6nqodurGcd"
  );
  const inputTokenMint = NATIVE_MINT;

  const amountUseToAddLiquidity = new BN(0.001 * LAMPORTS_PER_SOL);

  const zap = new Zap(connection);

  const dlmm = await DLMM.create(connection, dlmmPool);
  const binDelta = 34;
  const indirectSwapEstimate = await estimateDlmmIndirectSwap(
    amountUseToAddLiquidity,
    inputTokenMint,
    dlmmPool,
    connection,
    SWAP_SLIPPAGE_BPS,
    -binDelta,
    binDelta,
    StrategyType.Spot
  );

  const result = await zap.getZapInDlmmIndirectParams({
    user: user.publicKey,
    lbPair: dlmmPool,
    inputTokenMint: inputTokenMint,
    amountIn: amountUseToAddLiquidity,
    maxActiveBinSlippage: 50,
    minDeltaId: -binDelta,
    maxDeltaId: binDelta,
    strategy: StrategyType.Spot,
    favorXInActiveId: false,
    indirectSwapEstimate,
    maxAccounts: 50,
    slippageBps: SWAP_SLIPPAGE_BPS,
    maxTransferAmountExtendPercentage: 0,
  });

  const position = Keypair.generate();
  const zapInDlmmTx = await zap.buildZapInDlmmTransaction({
    ...result,
    position: position.publicKey,
  });

  // return;

  const finalTx = [];
  const res: { landed50: number } = (await fetch(
    "https://worker.jup.ag/jito-floor"
  ).then((res) => res.json())) as { landed50: number };

  const jitoFloor = res.landed50;

  const jitoTip = new Decimal(jitoFloor)
    .mul(10 ** 9)
    .toDP(0)
    .toNumber();

  const jitoTipsTx = createJitoTipIx({
    payer: user.publicKey,
    lamports: jitoTip.toString(),
  });

  if (zapInDlmmTx.setupTransaction) {
    finalTx.push(zapInDlmmTx.setupTransaction);
  }
  for (const swapTx of zapInDlmmTx.swapTransactions) {
    finalTx.push(swapTx);
  }
  finalTx.push(
    new Transaction().add(
      ...[
        zapInDlmmTx.ledgerTransaction,
        zapInDlmmTx.zapInTransaction,
        zapInDlmmTx.cleanUpTransaction,
        jitoTipsTx,
      ]
    )
  );

  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  for (const tx of finalTx) {
    tx.recentBlockhash = blockhash;
    tx.feePayer = user.publicKey;

    const txAccounts = tx.instructions.flatMap(({ keys }) =>
      keys.map((key) => key)
    );
    if (
      txAccounts.some(
        ({ isSigner, pubkey }) => isSigner && pubkey.equals(position.publicKey)
      )
    ) {
      tx.partialSign(position);
    }

    tx.partialSign(user);

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
