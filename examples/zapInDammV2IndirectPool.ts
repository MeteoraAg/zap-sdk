import { CpAmm, derivePositionAddress } from "@meteora-ag/cp-amm-sdk";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { getJupiterQuote, Zap } from "../src";
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

(async () => {
  const connection = new Connection(RPC_URL);
  const user = loadKeypairFromEnv();
  const dammV2Instance = new CpAmm(connection);
  const pool = new PublicKey("9x7WTWq66KbMC1w7AUX72khNg31nQmWRE4N4cDvJY7JT"); // MET-SOL
  const usdcMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  ); // USDC
  const poolState = await dammV2Instance.fetchPoolState(pool);

  // A new empty position for the zap in. Its create instruction goes in the same bundle as the
  // zap in, so the position is only created if the zap in lands.
  const positionNft = Keypair.generate();
  const positionNftMint = positionNft.publicKey;
  const createPositionTx = await dammV2Instance.createPosition({
    owner: user.publicKey,
    payer: user.publicKey,
    pool,
    positionNft: positionNftMint,
  });

  const usdcDecimal = 6; // USDC has 6 decimals
  const amountUseToAddLiquidity = new BN(5 * 10 ** usdcDecimal); // 5 USDC

  const zap = new Zap(connection, {
    jupiterApiUrl: JUPITER_API_URL,
    jupiterApiKey: JUPITER_API_KEY,
  });

  const jupiterQuoteToA = await getJupiterQuote(
    {
      inputMint: NATIVE_MINT,
      outputMint: poolState.tokenAMint,
      amount: new BN(LAMPORTS_PER_SOL),
      user: user.publicKey,
      maxAccounts: 40,
      slippageBps: 50,
    },
    {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    },
  );

  const jupiterQuoteToB = await getJupiterQuote(
    {
      inputMint: NATIVE_MINT,
      outputMint: poolState.tokenBMint,
      amount: new BN(LAMPORTS_PER_SOL),
      user: user.publicKey,
      maxAccounts: 40,
      slippageBps: 50,
    },
    {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    },
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
    instructions: [
      ...createPositionTx.instructions,
      ...zapInDammV2Tx.instructions,
      jitoTipsIx,
    ],
    addressLookupTableAccounts: zapInDammV2Tx.addressLookupTableAccounts,
  });
  for (const tx of finalTx) {
    signV0Transaction(tx, [user, positionNft]);

    // const simulate = await connection.simulateTransaction(tx);
    // console.log(simulate.value.logs);
    // console.log(simulate.value.err);
  }

  // return;

  console.log("Sending zap transaction...");
  const jitoBundleResult = await sendJitoBundle(finalTx, JITO_PRIVATE_KEY);
  console.log(jitoBundleResult);
  console.log(`Zap bundle sent: ${jitoBundleResult?.result}`);
  console.log(`Position NFT mint: ${positionNftMint.toBase58()}`);
  console.log(`Position: ${derivePositionAddress(positionNftMint).toBase58()}`);
})();
