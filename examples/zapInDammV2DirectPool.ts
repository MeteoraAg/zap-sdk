import { CpAmm, derivePositionAddress } from "@meteora-ag/cp-amm-sdk";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { Zap } from "../src";
import Decimal from "decimal.js";
import { derivePosition } from "@meteora-ag/dlmm";

const MAINNET_RPC_URL = "";

const JITO_PRIVATE_KEY = "";

const keypairPath = "";

export function createJitoTipIx({
  payer,
  lamports,
}: {
  payer: PublicKey;
  lamports: string;
}) {
  const tipAccount = new PublicKey(
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"
  );
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: tipAccount,
    lamports: BigInt(lamports),
  });
}
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

  const {
    amount,
    tokenAMint,
    tokenBMint,
    tokenAVault,
    tokenBVault,
    tokenAProgram,
    tokenBProgram,
    preInstructions,
    isDirectPool,
    maxTransferAmount,
    swapTransaction,
    maxSqrtPriceChangeBps,
    preSqrtPrice,
    cleanUpInstructions,
  } = await zap.getZapInDammV2DirectPoolParams(
    user.publicKey,
    usdcMint,
    amountUseToAddLiquidity,
    pool,
    position,
    positionNftAccount,
    1000 // maxSqrtPriceChangeBps
  );

  const zapInDammV2Tx = await zap.buildZapInDammV2Transaction({
    user: user.publicKey,
    pool,
    position,
    positionNftAccount,
    tokenAMint,
    tokenBMint,
    tokenAVault,
    tokenBVault,
    tokenAProgram,
    tokenBProgram,
    maxTransferAmount, // increase 20%
    preSqrtPrice,
    maxSqrtPriceChangeBps,
    amount,
    isDirectPool,
    preInstructions,
    swapTransaction,
    cleanUpInstructions,
  });

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
    new Transaction().add(
      ...[
        zapInDammV2Tx.setupTransaction,
        jitoTipsTx,
        zapInDammV2Tx.swapTransaction,
      ]
    )
  );

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
}

main();
