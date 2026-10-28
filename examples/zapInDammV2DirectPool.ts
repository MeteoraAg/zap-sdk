import {
  CpAmm,
  derivePositionAddress,
  getTokenDecimals,
} from "@meteora-ag/cp-amm-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { Zap } from "../src";
import Decimal from "decimal.js";
import { getJupAndDammV2Quotes } from "../src/helpers/zapin";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildV0Transactions,
  createJitoTipIx,
  loadKeypairFromEnv,
  sendJitoBundle,
  signV0Transaction,
} from "./helpers";
import BN from "bn.js";
import { JUPITER_API_KEY, JUPITER_API_URL, RPC_URL } from "./constants";

const JITO_PRIVATE_KEY = process.env.JITO_PRIVATE_KEY!;

async function main() {
  const connection = new Connection(RPC_URL);
  const user = loadKeypairFromEnv();
  const dammV2Instance = new CpAmm(connection);
  const pool = new PublicKey("BnztueWcXv93mgW7yJe8WYpnCxpz34nujPhfjQT6SLu1");
  const usdcMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
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

  const { tokenAMint, tokenBMint } = poolState;

  const tokenADecimal = await getTokenDecimals(
    connection,
    tokenAMint,
    TOKEN_PROGRAM_ID,
  );

  const tokenBDecimal = await getTokenDecimals(
    connection,
    tokenBMint,
    TOKEN_PROGRAM_ID,
  );

  const { dammV2Quote, jupiterQuote } = await getJupAndDammV2Quotes({
    connection,
    user: user.publicKey,
    inputTokenMint: usdcMint,
    poolState,
    tokenADecimal,
    tokenBDecimal,
    dammV2SlippageBps: 300,
    jupSlippageBps: 300,
    jupiterQuoteOptions: { maxAccounts: 40 },
    config: {
      jupiterApiUrl: JUPITER_API_URL,
      jupiterApiKey: JUPITER_API_KEY,
    },
  });

  const result = await zap.getZapInDammV2DirectPoolParams({
    user: user.publicKey,
    inputTokenMint: usdcMint,
    amountIn: amountUseToAddLiquidity,
    pool,
    positionNftMint,
    maxSqrtPriceChangeBps: 1000, // maxSqrtPriceChangeBps
    jupiterQuoteOptions: { maxAccounts: 40 },
    maxTransferAmountExtendPercentage: 20,
    slippageBps: 300,
    jupiterQuote,
    dammV2Quote,
  });

  const zapInDammV2Tx = await zap.buildZapInDammV2Transaction(result);

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
}

main();
