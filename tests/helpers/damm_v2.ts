import {
  AnchorProvider,
  BN,
  BorshCoder,
  IdlAccounts,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import {
  clusterApiUrl,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { DAMM_V2_PROGRAM_ID } from "../../src/constants";
import { CpAmm } from "../fixtures/damm_v2";
import DammV2IDL from "../fixtures/damm_v2.json";
import {
  deriveConfigAddress,
  deriveCustomizablePoolAddress,
  deriveOperatorAddress,
  derivePoolAddress,
  derivePoolAuthority,
  derivePositionAddress,
  derivePositionNftAccount,
  deriveTokenVaultAddress,
  CollectFeeMode,
  U64_MAX,
} from "@meteora-ag/cp-amm-sdk";

import { signAndSendTransaction } from "./svm";
import { getTokenProgram } from "./token";
import { deriveDammV2EventAuthority } from "../../src/helpers";

const cpAmmCoder = new BorshCoder(DammV2IDL as any);

export const LIQUIDITY_DELTA = new BN("1844674407800459963300003758876517305");
export const SQRT_PRICE_50A_50B = new BN("18446744073709551616"); // 1 << 64, price = 1 (50:50)
export const SQRT_PRICE_70A_30B = new BN("12076231902830000000"); // sqrt(3/7) * 2^64, gives price = 3/7 ≈ 0.4286 (B/A) → pool ratio 70 tokenA : 30 tokenB
export const LIQUIDITY_DELTA_2 = new BN("18446744078004599633000037588765");

export type DammV2Program = Program<CpAmm>;
export type Pool = IdlAccounts<CpAmm>["pool"];
export type Position = IdlAccounts<CpAmm>["position"];

export function createDammV2Program(): DammV2Program {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(
    new Connection(clusterApiUrl("devnet")),
    wallet,
    {},
  );
  return new Program<CpAmm>(DammV2IDL as CpAmm, provider);
}

enum BaseFeeMode {
  FeeTimeSchedulerLinear,
  FeeTimeSchedulerExponential,
  RateLimiter,
}

export function encodeFeeTimeSchedulerParams(
  cliffFeeNumerator: BN,
  numberOfPeriod: number,
  periodFrequency: BN,
  reductionFactor: BN,
  baseFeeMode: BaseFeeMode,
): Buffer {
  return cpAmmCoder.types.encode("BorshFeeTimeScheduler", {
    cliff_fee_numerator: cliffFeeNumerator,
    number_of_period: numberOfPeriod,
    period_frequency: periodFrequency,
    reduction_factor: reductionFactor,
    base_fee_mode: baseFeeMode,
  });
}

export function getDammV2Pool(svm: LiteSVM, pool: PublicKey): Pool {
  const program = createDammV2Program();
  const account = svm.getAccount(pool);
  return program.coder.accounts.decode("pool", Buffer.from(account!.data));
}

export function getDammV2Position(svm: LiteSVM, position: PublicKey): Position {
  const program = createDammV2Program();
  const account = svm.getAccount(position);
  return program.coder.accounts.decode("position", Buffer.from(account!.data));
}

export const SQRT_MIN_PRICE = new BN("4295048016");
export const SQRT_MAX_PRICE = new BN("79226673521066979257578248091");

export async function createDammV2Pool(params: {
  svm: LiteSVM;
  creator: Keypair;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  sqrtPrice?: BN;
  sqrtMinPrice?: BN;
  sqrtMaxPrice?: BN;
  liquidity?: BN;
  collectFeeMode?: CollectFeeMode;
  compoundingFeeBps?: number;
}): Promise<PublicKey> {
  const { svm, creator, tokenAMint, tokenBMint } = params;
  const program = createDammV2Program();

  const sqrtMinPrice = params.sqrtMinPrice ?? SQRT_MIN_PRICE;
  const sqrtMaxPrice = params.sqrtMaxPrice ?? SQRT_MAX_PRICE;
  const sqrtPrice = params.sqrtPrice ?? SQRT_PRICE_50A_50B;
  const liquidity = params.liquidity ?? LIQUIDITY_DELTA;
  const collectFeeMode = params.collectFeeMode ?? CollectFeeMode.OnlyB;
  const compoundingFeeBps = params.compoundingFeeBps ?? 0;

  const poolAuthority = derivePoolAuthority();
  const pool = deriveCustomizablePoolAddress(tokenAMint, tokenBMint);

  const positionNftKP = Keypair.generate();
  const position = derivePositionAddress(positionNftKP.publicKey);
  const positionNftAccount = derivePositionNftAccount(positionNftKP.publicKey);

  const tokenAVault = deriveTokenVaultAddress(tokenAMint, pool);
  const tokenBVault = deriveTokenVaultAddress(tokenBMint, pool);

  const tokenAProgram = svm.getAccount(tokenAMint)!.owner;
  const tokenBProgram = svm.getAccount(tokenBMint)!.owner;

  const payerTokenA = getAssociatedTokenAddressSync(
    tokenAMint,
    creator.publicKey,
    true,
    tokenAProgram,
  );
  const payerTokenB = getAssociatedTokenAddressSync(
    tokenBMint,
    creator.publicKey,
    true,
    tokenBProgram,
  );

  const baseFee = {
    data: Array.from(
      encodeFeeTimeSchedulerParams(
        new BN(2_500_000),
        0,
        new BN(0),
        new BN(0),
        BaseFeeMode.FeeTimeSchedulerLinear,
      ),
    ),
  };

  const transaction = await program.methods
    .initializeCustomizablePool({
      poolFees: {
        baseFee,
        compoundingFeeBps,
        padding: 0,
        dynamicFee: null,
      },
      sqrtMinPrice,
      sqrtMaxPrice,
      hasAlphaVault: false,
      liquidity,
      sqrtPrice,
      activationType: 0,
      collectFeeMode,
      activationPoint: null,
    })
    .accountsPartial({
      creator: creator.publicKey,
      positionNftAccount,
      positionNftMint: positionNftKP.publicKey,
      payer: creator.publicKey,
      poolAuthority,
      pool,
      position,
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      payerTokenA,
      payerTokenB,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      tokenAProgram,
      tokenBProgram,
    })
    .transaction();

  signAndSendTransaction(svm, transaction, [creator, positionNftKP]);

  return pool;
}

/**
 * Create a config-based pool using initializePool.
 * Pool address = PDA(["pool", config, maxKey, minKey]), so the same token pair
 * can have multiple pools with different configs (unlike customizable pools).
 */
export async function createDammV2PoolWithConfig(params: {
  svm: LiteSVM;
  creator: Keypair;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  configIndex: BN;
  sqrtPrice?: BN;
  liquidity?: BN;
}): Promise<PublicKey> {
  const { svm, creator, tokenAMint, tokenBMint, configIndex } = params;
  const program = createDammV2Program();

  const sqrtPrice = params.sqrtPrice ?? SQRT_PRICE_50A_50B;
  const liquidity = params.liquidity ?? LIQUIDITY_DELTA;

  // 1. Create operator for the creator
  const operatorAddress = deriveOperatorAddress(creator.publicKey);
  const operatorAccount = svm.getAccount(operatorAddress);
  if (!operatorAccount) {
    const createOperatorTx = await program.methods
      .createOperatorAccount(new BN(1)) // permission bit 0 = CreateConfigKey
      .accountsPartial({
        operator: operatorAddress,
        whitelistedAddress: creator.publicKey,
        signer: creator.publicKey,
        payer: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    signAndSendTransaction(svm, createOperatorTx, [creator]);
  }

  // 2. Create static config
  const config = deriveConfigAddress(configIndex);
  const baseFee = {
    data: Array.from(
      encodeFeeTimeSchedulerParams(
        new BN(2_500_000),
        0,
        new BN(0),
        new BN(0),
        BaseFeeMode.FeeTimeSchedulerLinear,
      ),
    ),
  };

  const createConfigTx = await program.methods
    .createConfig(configIndex, {
      poolFees: {
        baseFee,
        compoundingFeeBps: 0,
        padding: 0,
        dynamicFee: null,
      },
      sqrtMinPrice: SQRT_MIN_PRICE,
      sqrtMaxPrice: SQRT_MAX_PRICE,
      vaultConfigKey: PublicKey.default,
      poolCreatorAuthority: PublicKey.default,
      activationType: 0,
      collectFeeMode: 1,
    })
    .accountsPartial({
      config,
      operator: operatorAddress,
      signer: creator.publicKey,
      payer: creator.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  signAndSendTransaction(svm, createConfigTx, [creator]);

  // 3. Initialize pool
  const poolAuthority = derivePoolAuthority();
  const pool = derivePoolAddress(config, tokenAMint, tokenBMint);

  const positionNftKP = Keypair.generate();
  const position = derivePositionAddress(positionNftKP.publicKey);
  const positionNftAccount = derivePositionNftAccount(positionNftKP.publicKey);

  const tokenAVault = deriveTokenVaultAddress(tokenAMint, pool);
  const tokenBVault = deriveTokenVaultAddress(tokenBMint, pool);

  const tokenAProgram = svm.getAccount(tokenAMint)!.owner;
  const tokenBProgram = svm.getAccount(tokenBMint)!.owner;

  const payerTokenA = getAssociatedTokenAddressSync(
    tokenAMint,
    creator.publicKey,
    true,
    tokenAProgram,
  );
  const payerTokenB = getAssociatedTokenAddressSync(
    tokenBMint,
    creator.publicKey,
    true,
    tokenBProgram,
  );

  const initPoolTx = await program.methods
    .initializePool({
      liquidity,
      sqrtPrice,
      activationPoint: null,
    })
    .accountsPartial({
      creator: creator.publicKey,
      positionNftAccount,
      positionNftMint: positionNftKP.publicKey,
      payer: creator.publicKey,
      config,
      poolAuthority,
      pool,
      position,
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      payerTokenA,
      payerTokenB,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      tokenAProgram,
      tokenBProgram,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  initPoolTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }));

  signAndSendTransaction(svm, initPoolTx, [creator, positionNftKP]);

  return pool;
}

export async function createPositionAndAddLiquidity(
  svm: LiteSVM,
  user: Keypair,
  pool: PublicKey,
): Promise<PublicKey> {
  const program = createDammV2Program();

  const positionNftKP = Keypair.generate();
  const position = derivePositionAddress(positionNftKP.publicKey);
  const poolAuthority = derivePoolAuthority();
  const positionNftAccount = derivePositionNftAccount(positionNftKP.publicKey);

  const poolState = getDammV2Pool(svm, pool);

  const tokenAAccount = getAssociatedTokenAddressSync(
    poolState.tokenAMint,
    user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  const tokenBAccount = getAssociatedTokenAddressSync(
    poolState.tokenBMint,
    user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  const createPositionTx = await program.methods
    .createPosition()
    .accountsPartial({
      owner: user.publicKey,
      positionNftMint: positionNftKP.publicKey,
      poolAuthority,
      positionNftAccount,
      payer: user.publicKey,
      pool,
      position,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .transaction();

  const addLiquidityTx = await program.methods
    .addLiquidity({
      liquidityDelta: LIQUIDITY_DELTA_2,
      tokenAAmountThreshold: U64_MAX,
      tokenBAmountThreshold: U64_MAX,
    })
    .accountsPartial({
      pool,
      position,
      positionNftAccount,
      owner: user.publicKey,
      tokenAAccount,
      tokenBAccount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
    })
    .transaction();

  const finalTransaction = new Transaction()
    .add(createPositionTx)
    .add(addLiquidityTx);

  signAndSendTransaction(svm, finalTransaction, [user, positionNftKP]);

  return position;
}

export async function removeLiquidity(
  svm: LiteSVM,
  user: PublicKey,
  pool: PublicKey,
  position: PublicKey,
  tokenAAccount: PublicKey,
  tokenBAccount: PublicKey,
): Promise<Transaction> {
  const program = createDammV2Program();
  const poolState = getDammV2Pool(svm, pool);
  const positionState = getDammV2Position(svm, position);
  const positionNftAccount = derivePositionNftAccount(positionState.nftMint);
  const poolAuthority = derivePoolAuthority();

  return await program.methods
    .removeLiquidity({
      liquidityDelta: positionState.unlockedLiquidity,
      tokenAAmountThreshold: new BN(0),
      tokenBAmountThreshold: new BN(0),
    })
    .accountsPartial({
      poolAuthority,
      pool,
      position,
      positionNftAccount,
      owner: user,
      tokenAAccount,
      tokenBAccount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
    })
    .transaction();
}

export async function createPosition(
  svm: LiteSVM,
  user: Keypair,
  pool: PublicKey,
): Promise<{ position: PublicKey; positionNftMint: PublicKey }> {
  const program = createDammV2Program();

  const positionNftKP = Keypair.generate();
  const position = derivePositionAddress(positionNftKP.publicKey);
  const poolAuthority = derivePoolAuthority();
  const positionNftAccount = derivePositionNftAccount(positionNftKP.publicKey);

  const createPositionTx = await program.methods
    .createPosition()
    .accountsPartial({
      owner: user.publicKey,
      positionNftMint: positionNftKP.publicKey,
      poolAuthority,
      positionNftAccount,
      payer: user.publicKey,
      pool,
      position,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .transaction();

  signAndSendTransaction(svm, createPositionTx, [user, positionNftKP]);
  return { position, positionNftMint: positionNftKP.publicKey };
}

export async function swapDammV2(
  svm: LiteSVM,
  user: PublicKey,
  pool: PublicKey,
  inputTokenMint: PublicKey,
  amountIn: BN,
): Promise<Transaction> {
  const program = createDammV2Program();
  const poolState = getDammV2Pool(svm, pool);

  const outputTokenMint = poolState.tokenAMint.equals(inputTokenMint)
    ? poolState.tokenBMint
    : poolState.tokenAMint;

  const inputTokenProgram = getTokenProgram(svm, inputTokenMint);
  const outputTokenProgram = getTokenProgram(svm, outputTokenMint);

  const inputTokenAccount = getAssociatedTokenAddressSync(
    inputTokenMint,
    user,
    true,
    inputTokenProgram,
  );
  const outputTokenAccount = getAssociatedTokenAddressSync(
    outputTokenMint,
    user,
    true,
    outputTokenProgram,
  );

  return await program.methods
    .swap({
      amountIn,
      minimumAmountOut: new BN(0),
    })
    .accountsPartial({
      poolAuthority: derivePoolAuthority(),
      pool,
      inputTokenAccount,
      outputTokenAccount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      payer: user,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    })
    .transaction();
}

export function getDammV2RemainingAccounts(
  svm: LiteSVM,
  pool: PublicKey,
  user: PublicKey,
  userInputTokenAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  tokenAProgram = TOKEN_PROGRAM_ID,
  tokenBProgram = TOKEN_PROGRAM_ID,
): Array<{
  isSigner: boolean;
  isWritable: boolean;
  pubkey: PublicKey;
}> {
  const poolState = getDammV2Pool(svm, pool);

  return [
    {
      isSigner: false,
      isWritable: false,
      pubkey: derivePoolAuthority(),
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: pool,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: userInputTokenAccount,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: userTokenOutAccount,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: poolState.tokenAVault,
    },
    {
      isSigner: false,
      isWritable: true,
      pubkey: poolState.tokenBVault,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: poolState.tokenAMint,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: poolState.tokenBMint,
    },
    {
      isSigner: true,
      isWritable: false,
      pubkey: user,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: tokenAProgram,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: tokenBProgram,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: DAMM_V2_PROGRAM_ID,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: deriveDammV2EventAuthority(),
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: DAMM_V2_PROGRAM_ID,
    },
  ];
}
