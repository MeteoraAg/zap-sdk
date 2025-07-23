import { clusterApiUrl, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Zap } from "../src/zap";
import {
  CpAmm,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";
import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT } from "@solana/spl-token";

(async () => {
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(require("~/.config/solana/id.json"))
  );
  const connection = new Connection(clusterApiUrl("devnet"));
  const zapSdk = new Zap(connection);
  const dammV2 = new CpAmm(connection);

  // example test pool on devnet
  const poolAddress = new PublicKey(
    "7zS8x5DHbyMQJbADRKMxE4ZS1y2SGXPwVRn238Lx1T6B"
  );
  const userPositions = await dammV2.getUserPositionByPool(
    poolAddress,
    wallet.publicKey
  );
  const poolState = await dammV2.fetchPoolState(poolAddress);

  const liquidityDelta =
    userPositions[0].positionState.unlockedLiquidity.divn(1000000); // remove liquidity with too small amount

  const amountARemoved = getAmountAFromLiquidityDelta(
    liquidityDelta,
    poolState.sqrtPrice,
    poolState.sqrtMaxPrice,
    Rounding.Up
  );
  const amountBRemoved = getAmountBFromLiquidityDelta(
    liquidityDelta,
    poolState.sqrtPrice,
    poolState.sqrtMinPrice,
    Rounding.Up
  );

  console.log({
    amountARemoved: amountARemoved.toString(),
    amountBRemoved: amountBRemoved.toString(),
  });

  const transaction = await zapSdk.removeDammV2LiquidityWithZapOut({
    user: wallet.publicKey,
    poolState: poolState,
    position: userPositions[0].position,
    poolAddress,
    positionNftAccount: userPositions[0].positionNftAccount,
    liquidityDelta,
    outputTokenMint: NATIVE_MINT, // sol
    tokenAAmountThreshold: new BN(0),
    tokenBAmountThreshold: new BN(0),
    minimumSwapAmountOut: new BN("10000"), // random number, need calculate with specific slippage
    vestings: [],
  });

  transaction.recentBlockhash = (
    await connection.getLatestBlockhash()
  ).blockhash;
  transaction.sign(wallet);

  console.log(await connection.simulateTransaction(transaction));
  // const signature = await connection.sendRawTransaction(
  //   transaction.serialize()
  // );
  // console.log(signature);
})();
