import {
  CpAmm,
  derivePositionAddress,
  derivePositionNftAccount,
} from "@meteora-ag/cp-amm-sdk";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { getJupiterQuote, Zap } from "../src";
import Decimal from "decimal.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { createJitoTipIx, sendJitoBundle } from "./helpers";
import { JUPITER_API_KEY, JUPITER_API_URL } from "./constants";

const MAINNET_RPC_URL = "";

const JITO_PRIVATE_KEY = "";

const keypairPath = "";

(async () => {
  const connection = new Connection(MAINNET_RPC_URL);
  const user = Keypair.fromSecretKey(Uint8Array.from(require(keypairPath)));
  const dammV2Instance = new CpAmm(connection);
  const pool = new PublicKey("Ep5MouzWgvdSSwUyekGQ3UyHMzaa4FKLZga4fEqk2VHG");
  const usdcMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const poolState = await dammV2Instance.fetchPoolState(pool);

  // const positionNft = Keypair.generate();
  // const createPositionTx = await dammV2Instance.createPosition({
  //   owner: user.publicKey,
  //   payer: user.publicKey,
  //   pool,
  //   positionNft: positionNft.publicKey,
  // });

  // createPositionTx.feePayer = user.publicKey;
  // createPositionTx.recentBlockhash = (
  //   await connection.getLatestBlockhash()
  // ).blockhash;

  // const sig = await connection.sendTransaction(createPositionTx, [
  //   user,
  //   positionNft,
  // ]);
  // console.log(sig);

  // return;

  const positionNftMint = new PublicKey("ENTER POSITION NFT MINT");

  const usdcDecimal = 6; // USDC has 6 decimals
  const amountUseToAddLiquidity = new BN(5 * 10 ** usdcDecimal); // 5 USDC

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });

  const jupiterQuoteToA = await getJupiterQuote(
    NATIVE_MINT,
    poolState.tokenAMint,
    new BN(LAMPORTS_PER_SOL),
    40, // maxAccounts,
    50, //slippageBps,
    false,
    true,
    true,
    {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    }
  );

  const jupiterQuoteToB = await getJupiterQuote(
    NATIVE_MINT,
    poolState.tokenBMint,
    new BN(LAMPORTS_PER_SOL),
    40, // maxAccounts,
    50, //slippageBps,
    false,
    true,
    true,
    {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    }
  );

  const result = await zap.getZapInDammV2IndirectPoolParams({
    user: user.publicKey,
    inputTokenMint: usdcMint,
    amountIn: amountUseToAddLiquidity,
    pool,
    positionNftMint,
    maxSqrtPriceChangeBps: 1000, // maxSqrtPriceChangeBps,
    maxAccounts: 50,
    slippageBps: 300,
    maxTransferAmountExtendPercentage: 20,
    jupiterQuoteToA,
    jupiterQuoteToB,
  });

  console.log(result);

  const zapInDammV2Tx = await zap.buildZapInDammV2Transaction(result!);

  //   return;

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

  if (zapInDammV2Tx.setupTransaction) {
    finalTx.push(zapInDammV2Tx.setupTransaction);
  }

  for (const swapTx of zapInDammV2Tx.swapTransactions) {
    finalTx.push(swapTx);
  }

  finalTx.push(
    new Transaction().add(
      ...[
        zapInDammV2Tx.ledgerTransaction,
        zapInDammV2Tx.zapInTransaction,
        zapInDammV2Tx.cleanUpTransaction,
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
})();
