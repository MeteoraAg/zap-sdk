import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { Zap } from "../src";
import Decimal from "decimal.js";
import { createJitoTipIx } from "./zapInDammV2DirectPool";

const MAINNET_RPC_URL = "";

const JITO_PRIVATE_KEY = "";

const keypairPath = "";

(async () => {
  const connection = new Connection(MAINNET_RPC_URL);
  const user = Keypair.fromSecretKey(Uint8Array.from(require(keypairPath)));
  const dammV2Instance = new CpAmm(connection);
  const pool = new PublicKey("BnztueWcXv93mgW7yJe8WYpnCxpz34nujPhfjQT6SLu1");

  //   const poolState = await dammV2Instance.fetchPoolState(pool);
  //   const positionNft = Keypair.generate();
  //   const createPositionTx = await dammV2Instance.createPosition({
  //     owner: user.publicKey,
  //     payer: user.publicKey,
  //     pool,
  //     positionNft: positionNft.publicKey,
  //   });

  //   createPositionTx.feePayer = user.publicKey;
  //   createPositionTx.recentBlockhash = (
  //     await connection.getLatestBlockhash()
  //   ).blockhash;

  //   const sig = await connection.sendTransaction(createPositionTx, [
  //     user,
  //     positionNft,
  //   ]);
  //   console.log(sig);

  //   return;

  const position = new PublicKey(
    "DzLAYMrP2yyYssXMFzY7577ejDnFCC2cboCRdvxUYqjt"
  );
  const positionNftAccount = new PublicKey(
    "Gptio8g1YyFAwxDf7YEA8ykPDMzZ9hYe2VDcdjMDnbTn"
  );

  const amountUseToAddLiquidity = new Decimal(0.1); // 0.1 SOL

  const zap = new Zap(connection);

  const result = await zap.getZapInDammV2IndirectPoolParams(
    user.publicKey,
    amountUseToAddLiquidity,
    pool,
    position,
    positionNftAccount,
    1000 // maxSqrtPriceChangeBps
  );

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
        zapInDammV2Tx.initializeLedgerTx,
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
