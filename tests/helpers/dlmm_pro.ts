import { LiteSVM } from "litesvm";
import { lamports } from "@solana/kit";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DecodedPosition,
  DlmmProClient,
  OperatorPermission,
  Pool,
  TickRange,
  deriveOperator,
  derivePosition,
  deriveStaticConfig,
  encodeFixedBaseFeeData,
  getAmountsFromLiquidity,
} from "@meteora-ag/dlmm-pro-sdk";

import { DLMM_PRO_PROGRAM_ID } from "../../src/constants";
import {
  createLiteSvmConnection,
  signAndSendTransaction,
  toAddress,
} from "./svm";

export const DLMM_PRO_TICK_SPACING = 1;
// Price 1, so the pool starts at tick 0.
export const DLMM_PRO_INIT_SQRT_PRICE = new BN(1).shln(64);
export const DLMM_PRO_SEED_TICK_RANGE: TickRange = {
  tickLowerId: -128,
  tickUpperId: 128,
};
// Admin seeds the pool with far more than the user deposits or swaps, so a swap of the user's
// whole position stays inside the seeded range.
export const DLMM_PRO_SEED_LIQUIDITY = new BN("10000000000000000");
export const DLMM_PRO_LIQUIDITY = new BN("10000000000000");

const U64_MAX = new BN("18446744073709551615");
const STATIC_CONFIG_INDEX = new BN(0);
const BASE_FEE_NUMERATOR = 1_000_000; // 10 bps

export function createDlmmProClient(svm: LiteSVM): DlmmProClient {
  return new DlmmProClient(createLiteSvmConnection(svm));
}

export function getDlmmProPool(svm: LiteSVM, pool: PublicKey): Promise<Pool> {
  return createDlmmProClient(svm).state.fetchPool(pool);
}

export function getDlmmProOutputMint(
  poolState: Pool,
  inputTokenMint: PublicKey,
): PublicKey {
  return poolState.tokenXMint.equals(inputTokenMint)
    ? poolState.tokenYMint
    : poolState.tokenXMint;
}

// The ranges of a position, in the order they were opened.
export async function getDlmmProPositionRanges(
  svm: LiteSVM,
  nftMint: PublicKey,
): Promise<DecodedPosition[]> {
  const { positions } = await createDlmmProClient(
    svm,
  ).state.fetchPositionArrayWithPositions(derivePosition(nftMint), {
    withReward: false,
  });
  return positions;
}

// The fixture is the program deployed on mainnet, where only the hardcoded DLMM Pro admin can
// create an operator, so write the operator account into the SVM.
async function setDlmmProOperator(
  svm: LiteSVM,
  client: DlmmProClient,
  whitelistedAddress: PublicKey,
  permissions: OperatorPermission[],
): Promise<void> {
  const data = await client.program.coder.accounts.encode("operator", {
    whitelistedAddress,
    permission: permissions.reduce(
      (bitmask, permission) => bitmask.or(new BN(1).shln(permission)),
      new BN(0),
    ),
  });
  svm.setAccount({
    address: toAddress(deriveOperator(whitelistedAddress)),
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: toAddress(DLMM_PRO_PROGRAM_ID),
    space: BigInt(data.length),
  });
}

export async function createDlmmProPool(
  svm: LiteSVM,
  creator: Keypair,
  tokenXMint: PublicKey,
  tokenYMint: PublicKey,
): Promise<PublicKey> {
  const client = createDlmmProClient(svm);
  await setDlmmProOperator(svm, client, creator.publicKey, [
    OperatorPermission.CreateConfigKey,
  ]);

  const config = deriveStaticConfig(STATIC_CONFIG_INDEX);
  const createConfigTx = await client.program.methods
    .createStaticConfig(STATIC_CONFIG_INDEX, {
      poolFees: {
        baseFeeParameter: {
          baseFeeMode: BaseFeeMode.Fixed,
          data: encodeFixedBaseFeeData(BASE_FEE_NUMERATOR),
        },
        dynamicFeeParameter: null,
      },
      tickSpacing: DLMM_PRO_TICK_SPACING,
      collectFeeMode: CollectFeeMode.OutputToken,
      activationType: ActivationType.Timestamp,
      extensions: 0,
      poolCreatorAuthority: null,
    })
    .accountsPartial({
      config,
      operator: deriveOperator(creator.publicKey),
      signer: creator.publicKey,
      payer: creator.publicKey,
    })
    .transaction();
  signAndSendTransaction(svm, createConfigTx, [creator]);

  const { tx, pool } = await client.pool.initializePoolWithStaticConfig({
    config,
    tokenXMint,
    tokenYMint,
    creator: creator.publicKey,
    payer: creator.publicKey,
    initialSqrtPrice: DLMM_PRO_INIT_SQRT_PRICE,
  });
  signAndSendTransaction(svm, tx, [creator]);

  return pool;
}

// Returns the position NFT mint.
export async function openDlmmProPositionAndAddLiquidity(
  svm: LiteSVM,
  owner: Keypair,
  pool: PublicKey,
  tickRange: TickRange,
  liquidity: BN,
): Promise<PublicKey> {
  const client = createDlmmProClient(svm);
  const { tokenXMint, tokenYMint } = await client.state.fetchPool(pool);
  const nftMint = Keypair.generate();

  const { tx: openPositionTx } = await client.position.openPosition({
    pool,
    owner: owner.publicKey,
    payer: owner.publicKey,
    nftMint: nftMint.publicKey,
    tickRanges: [tickRange],
  });
  signAndSendTransaction(svm, openPositionTx, [owner, nftMint]);

  const { tx: addLiquidityTx } = await client.position.addLiquidity({
    pool,
    nftMint: nftMint.publicKey,
    owner: owner.publicKey,
    signer: owner.publicKey,
    tokenXMint,
    tokenYMint,
    tickRanges: [tickRange],
    parameters: {
      maxAmountX: U64_MAX,
      maxAmountY: U64_MAX,
      expectedLayoutVersion: null,
      bitmap: new BN(1),
      liquidities: [liquidity],
    },
  });
  signAndSendTransaction(svm, addLiquidityTx, [owner]);

  return nftMint.publicKey;
}

// Create a pool and seed it with admin liquidity so a later swap has something to trade against.
export async function createSeededDlmmProPool(
  svm: LiteSVM,
  admin: Keypair,
  tokenXMint: PublicKey,
  tokenYMint: PublicKey,
): Promise<PublicKey> {
  const pool = await createDlmmProPool(svm, admin, tokenXMint, tokenYMint);
  await openDlmmProPositionAndAddLiquidity(
    svm,
    admin,
    pool,
    DLMM_PRO_SEED_TICK_RANGE,
    DLMM_PRO_SEED_LIQUIDITY,
  );
  return pool;
}

// Seed a pool, add liquidity for `user`, and build (but not send) the remove-liquidity tx,
// returning the amounts of `inputTokenMint` and of the other token it withdraws.
export async function setupDlmmProPoolAndRemoveLiquidity(
  svm: LiteSVM,
  admin: Keypair,
  user: Keypair,
  tokenXMint: PublicKey,
  tokenYMint: PublicKey,
  inputTokenMint: PublicKey,
): Promise<{
  pool: PublicKey;
  removeLiquidityTx: Transaction;
  estimatedAmountIn: BN;
  estimatedAmountOut: BN;
}> {
  const pool = await createSeededDlmmProPool(
    svm,
    admin,
    tokenXMint,
    tokenYMint,
  );
  const nftMint = await openDlmmProPositionAndAddLiquidity(
    svm,
    user,
    pool,
    DLMM_PRO_SEED_TICK_RANGE,
    DLMM_PRO_LIQUIDITY,
  );

  const client = createDlmmProClient(svm);
  const poolState = await client.state.fetchPool(pool);
  const { tx: removeLiquidityTx } = await client.position.removeLiquidity({
    pool,
    nftMint,
    owner: user.publicKey,
    signer: user.publicKey,
    tokenXMint,
    tokenYMint,
    tickRanges: [DLMM_PRO_SEED_TICK_RANGE],
    parameters: {
      minAmountX: new BN(0),
      minAmountY: new BN(0),
      expectedLayoutVersion: null,
      bitmap: new BN(1),
      liquidities: [DLMM_PRO_LIQUIDITY],
    },
  });

  const { amountX, amountY } = getAmountsFromLiquidity({
    tickCurrentId: poolState.tickCurrentId,
    currentSqrtPrice: poolState.sqrtPrice,
    liquidity: DLMM_PRO_LIQUIDITY.neg(),
    ...DLMM_PRO_SEED_TICK_RANGE,
  });

  const [estimatedAmountIn, estimatedAmountOut] = poolState.tokenXMint.equals(
    inputTokenMint,
  )
    ? [amountX, amountY]
    : [amountY, amountX];

  return { pool, removeLiquidityTx, estimatedAmountIn, estimatedAmountOut };
}
