import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { convertUiAmountToLamports, getJupiterQuote, Zap } from "../src";
import Decimal from "decimal.js";
import { createJitoTipIx } from "./zapInDammV2DirectPool";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";

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
    "ESn3eEkbpKqjjdusLJJN68y9RXWrhmiCQCc9dvKBChhC"
  );
  const positionNftAccount = new PublicKey(
    "FsqhsNGhoRBKcvJbJ8MKsCiDVX9vELmmW3zce3ijRzd7"
  );

  const amountUseToAddLiquidity = new Decimal(5); // 5 USDC

  const zap = new Zap(connection);

  const poolState = await dammV2Instance.fetchPoolState(pool);

  const jupiterQuoteToA = await getJupiterQuote(
    NATIVE_MINT,
    poolState.tokenAMint,
    new BN(LAMPORTS_PER_SOL),
    40, // maxAccounts,
    50, //slippageBps,
    false,
    true,
    true,
    "https://lite-api.jup.ag"
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
    "https://lite-api.jup.ag"
  );

  const result = await zap.getZapInDammV2IndirectPoolParams({
    user: user.publicKey,
    inputTokenMint: usdcMint,
    amountIn: amountUseToAddLiquidity,
    pool,
    position,
    positionNftAccount,
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

  finalTx.push(
    new Transaction().add(...[zapInDammV2Tx.setupTransaction, jitoTipsTx])
  );

  finalTx.push(new Transaction().add(...[zapInDammV2Tx.swapTransaction]));

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

  return;

  console.log("Sending zap transaction...");
  const jitoBundleResult: {
    result: string;
  } = (await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-jito-auth": JITO_PRIVATE_KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [
        finalTx.map((signedTx) => signedTx.serialize().toString("base64")),
        { encoding: "base64" },
      ],
    }),
  })
    .then((res) => res.json())
    .catch((err) => {
      console.error(err);
      return {
        result: err.message,
      };
    })) as {
    result: string;
  };

  console.log(jitoBundleResult);
  console.log(`Zap bundle sent: ${jitoBundleResult?.result}`);
})();
