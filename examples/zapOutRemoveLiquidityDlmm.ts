import { clusterApiUrl, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Zap } from "../src";
import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT } from "@solana/spl-token";
import DLMM, { wrapPosition } from "@meteora-ag/dlmm";

(async () => {
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(require("/Users/minhdo/.config/solana/id.json"))
  );
  const connection = new Connection(clusterApiUrl("devnet"));
  const zapSdk = new Zap(connection, "devnet");

  // example test pool on devnet
  const poolAddress = new PublicKey(
    "3eeyyRsuK6bZ2tDLPQxXZHMdp8SX5gtu8xzCUSXFx4Wp"
  );

  const position = new PublicKey(
    "BwkWL46z9oJQFebbBr9WpxovjBJs1CZ8PrQdDvd7Xbmw"
  );

  const dlmm = await DLMM.create(connection, poolAddress, {
    cluster: "devnet",
  });

  const positionAccount = await connection.getAccountInfo(position);

  const positionState = wrapPosition(dlmm.program, position, positionAccount);

  const transaction = await zapSdk.removeDlmmLiquidityWithZapOut({
    user: wallet.publicKey,
    poolAddress,
    position,
    fromBinId: positionState.lowerBinId().toNumber(),
    toBinId: positionState.upperBinId().toNumber(),
    outputTokenMint: NATIVE_MINT,
    minimumSwapAmountOut: new BN(1),
    bps: new BN(5000),
  });
  transaction.recentBlockhash = (
    await connection.getLatestBlockhash()
  ).blockhash;
  transaction.sign(wallet);

  console.log(await connection.simulateTransaction(transaction));
  const signature = await connection.sendRawTransaction(
    transaction.serialize()
  );
  console.log(signature);
})();
