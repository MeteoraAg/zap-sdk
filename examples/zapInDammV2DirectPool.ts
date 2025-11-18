import { CpAmm, getTokenDecimals } from "@meteora-ag/cp-amm-sdk";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { Zap } from "../src";
import Decimal from "decimal.js";
import { getJupAndDammV2Quotes } from "../src/helpers/zapin";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createJitoTipIx, sendJitoBundle } from "./helpers";

const MAINNET_RPC_URL = "";

const JITO_PRIVATE_KEY = "";

const keypairPath = "";

async function main() {
  const connection = new Connection(MAINNET_RPC_URL);
  const user = Keypair.fromSecretKey(Uint8Array.from(require(keypairPath)));
  const dammV2Instance = new CpAmm(connection);
  const pool = new PublicKey("BnztueWcXv93mgW7yJe8WYpnCxpz34nujPhfjQT6SLu1");
  const usdcMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  // const poolState = await dammV2Instance.fetchPoolState(pool);

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

  const position = new PublicKey(
    "DzLAYMrP2yyYssXMFzY7577ejDnFCC2cboCRdvxUYqjt"
  );
  const positionNftAccount = new PublicKey(
    "Gptio8g1YyFAwxDf7YEA8ykPDMzZ9hYe2VDcdjMDnbTn"
  );

  const amountUseToAddLiquidity = new Decimal(5); // 5 USDC

  const zap = new Zap(connection);
  const poolState = await dammV2Instance.fetchPoolState(pool);

  const { tokenAMint, tokenBMint } = poolState;

  const tokenADecimal = await getTokenDecimals(
    connection,
    tokenAMint,
    TOKEN_PROGRAM_ID
  );

  const tokenBDecimal = await getTokenDecimals(
    connection,
    tokenBMint,
    TOKEN_PROGRAM_ID
  );

  const { dammV2Quote, jupiterQuote } = await getJupAndDammV2Quotes(
    connection,
    usdcMint,
    poolState,
    tokenADecimal,
    tokenBDecimal,
    300, //dammV2SlippageBps: 300,
    300, // jup slippageBps:
    40 // maxAccounts
  );

  const result = await zap.getZapInDammV2DirectPoolParams({
    user: user.publicKey,
    inputTokenMint: usdcMint,
    amountIn: amountUseToAddLiquidity,
    pool,
    position,
    positionNftAccount,
    maxSqrtPriceChangeBps: 1000, // maxSqrtPriceChangeBps
    maxAccounts: 40,
    maxTransferAmountExtendPercentage: 20,
    slippageBps: 300,
    jupiterQuote,
    dammV2Quote,
  });

  const zapInDammV2Tx = await zap.buildZapInDammV2Transaction(result);

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
  // finalTx.push(new Transaction().add(jitoTipsTx));

  finalTx.push(
    new Transaction().add(...[zapInDammV2Tx.setupTransaction, jitoTipsTx])
  );

  for (const swapTx of zapInDammV2Tx.swapTransactions) {
    finalTx.push(swapTx);
  }

  finalTx.push(
    new Transaction().add(
      ...[
        zapInDammV2Tx.ledgerTransaction,
        zapInDammV2Tx.zapInTx,
        zapInDammV2Tx.closeLedgerTx,
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
