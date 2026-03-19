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
  Connection,
  Keypair,
  PublicKey,
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
  deriveCustomizablePoolAddress,
  derivePoolAuthority,
  derivePositionAddress,
  derivePositionNftAccount,
  deriveTokenVaultAddress,
  CollectFeeMode,
  U64_MAX,
} from "@meteora-ag/cp-amm-sdk";

import { signAndSendTransaction } from "./svm";

const cpAmmCoder = new BorshCoder(DammV2IDL as any);

export const LIQUIDITY_DELTA = new BN("1844674407800459963300003758876517305");
export const INIT_PRICE = new BN("18446744073709551616"); // 1 << 64
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

function deriveDammV2EventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DAMM_V2_PROGRAM_ID,
  )[0];
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

export async function createDammV2Pool(params: {
  svm: LiteSVM;
  creator: Keypair;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
}): Promise<PublicKey> {
  const { svm, creator, tokenAMint, tokenBMint } = params;
  const program = createDammV2Program();

  const sqrtMinPrice = new BN("4295048016");
  const sqrtMaxPrice = new BN("79226673521066979257578248091");
  const sqrtPrice = INIT_PRICE;
  const collectFeeMode = CollectFeeMode.OnlyB;

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
        compoundingFeeBps: 0,
        padding: 0,
        dynamicFee: null,
      },
      sqrtMinPrice,
      sqrtMaxPrice,
      hasAlphaVault: false,
      liquidity: LIQUIDITY_DELTA,
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
