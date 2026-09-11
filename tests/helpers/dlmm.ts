import {
  AnchorProvider,
  BN,
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
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import DLMM, {
  DEFAULT_BIN_PER_POSITION,
  deriveBinArray,
  deriveCustomizablePermissionlessLbPair,
  deriveOracle,
  deriveReserve,
  getBinArrayAccountMetasCoverage,
  getBinArrayIndexesCoverage,
  LbPosition,
  MAX_BIN_ARRAY_SIZE,
} from "@meteora-ag/dlmm";

import { DLMM_PROGRAM_ID, MEMO_PROGRAM_ID } from "../../src/constants";
import { LbClmm } from "../fixtures/dlmm";
import DlmmIDL from "../fixtures/dlmm.json";
import { createLiteSvmConnection, signAndSendTransaction } from "./svm";
import { getTokenBalance } from "./token";

export type DlmmProgram = Program<LbClmm>;
export type LbPairState = IdlAccounts<LbClmm>["lbPair"];

export const DLMM_ACTIVE_ID = 0;
export const DLMM_BIN_STEP = 10;
export const DLMM_BASE_FACTOR = 10_000;
// Admin seeds the pool with far more than the user deposits so a zap-out swap of the
// user's whole position stays inside the seeded bins (mirrors LIQUIDITY_DELTA vs LIQUIDITY_DELTA_2 for DAMM V2).
export const DLMM_SEED_LIQUIDITY_AMOUNT = new BN(100_000).mul(new BN(10 ** 9));
export const DLMM_LIQUIDITY_AMOUNT = new BN(100).mul(new BN(10 ** 9));

const SET_COMPUTE_UNIT_LIMIT_IX = ComputeBudgetProgram.setComputeUnitLimit({
  units: 1_400_000,
});
const SET_COMPUTE_UNIT_LIMIT_INIT_BIN_ARRAY_IX =
  ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });

export function createDlmmProgram(): DlmmProgram {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(
    new Connection(clusterApiUrl("devnet")),
    wallet,
    {},
  );
  return new Program<LbClmm>(DlmmIDL as LbClmm, provider);
}

export function getLbPair(svm: LiteSVM, lbPair: PublicKey): LbPairState {
  const program = createDlmmProgram();
  const account = svm.getAccount(lbPair);
  return program.coder.accounts.decode("lbPair", Buffer.from(account!.data));
}

export function getDlmmOutputMint(
  lbPairState: LbPairState,
  inputTokenMint: PublicKey,
): PublicKey {
  return lbPairState.tokenXMint.equals(inputTokenMint)
    ? lbPairState.tokenYMint
    : lbPairState.tokenXMint;
}

export async function createDlmmPool(params: {
  svm: LiteSVM;
  creator: Keypair;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  activeId?: number;
  binStep?: number;
  baseFactor?: number;
}): Promise<PublicKey> {
  const { svm, creator, tokenXMint, tokenYMint } = params;
  const program = createDlmmProgram();

  const activeId = params.activeId ?? DLMM_ACTIVE_ID;
  const binStep = params.binStep ?? DLMM_BIN_STEP;
  const baseFactor = params.baseFactor ?? DLMM_BASE_FACTOR;

  const [lbPair] = deriveCustomizablePermissionlessLbPair(
    tokenXMint,
    tokenYMint,
    DLMM_PROGRAM_ID,
  );
  const [reserveX] = deriveReserve(tokenXMint, lbPair, DLMM_PROGRAM_ID);
  const [reserveY] = deriveReserve(tokenYMint, lbPair, DLMM_PROGRAM_ID);
  const [oracle] = deriveOracle(lbPair, DLMM_PROGRAM_ID);

  const userTokenX = getAssociatedTokenAddressSync(
    tokenXMint,
    creator.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  const userTokenY = getAssociatedTokenAddressSync(
    tokenYMint,
    creator.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  const transaction = await program.methods
    .initializeCustomizablePermissionlessLbPair({
      activeId,
      binStep,
      baseFactor,
      activationType: 0,
      hasAlphaVault: false,
      activationPoint: null,
      creatorPoolOnOffControl: false,
      baseFeePowerFactor: 0,
      concreteFunctionType: 0,
      collectFeeMode: 0,
      padding: new Array(60).fill(0),
    })
    .accountsPartial({
      lbPair,
      binArrayBitmapExtension: null,
      tokenMintX: tokenXMint,
      tokenMintY: tokenYMint,
      reserveX,
      reserveY,
      oracle,
      userTokenX,
      userTokenY,
      funder: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  signAndSendTransaction(svm, transaction, [creator]);

  return lbPair;
}

export async function createBinArrays(
  svm: LiteSVM,
  funder: Keypair,
  lbPair: PublicKey,
  lowerBinId: number,
  upperBinId: number,
): Promise<void> {
  const program = createDlmmProgram();
  const indexes = getBinArrayIndexesCoverage(
    new BN(lowerBinId),
    new BN(upperBinId),
  );

  for (const index of indexes) {
    const [binArray] = deriveBinArray(lbPair, index, DLMM_PROGRAM_ID);
    if (svm.getAccount(binArray)) {
      continue;
    }

    const transaction = await program.methods
      .initializeBinArray(index)
      .accountsPartial({
        binArray,
        funder: funder.publicKey,
        lbPair,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([SET_COMPUTE_UNIT_LIMIT_INIT_BIN_ARRAY_IX])
      .transaction();

    signAndSendTransaction(svm, transaction, [funder]);
  }
}

// Create a position centered on the active bin and deposit `amountX` / `amountY`
// spread evenly across every bin in the position (spot balanced).
export async function createDlmmPositionAndAddLiquidity(
  svm: LiteSVM,
  user: Keypair,
  lbPair: PublicKey,
  amountX: BN,
  amountY: BN,
): Promise<{ position: PublicKey; lowerBinId: number; upperBinId: number }> {
  const program = createDlmmProgram();
  const lbPairState = getLbPair(svm, lbPair);

  const width = DEFAULT_BIN_PER_POSITION.toNumber();
  const lowerBinId = lbPairState.activeId - Math.floor(width / 2);
  const upperBinId = lowerBinId + width - 1;

  await createBinArrays(svm, user, lbPair, lowerBinId, upperBinId);

  const positionKP = Keypair.generate();

  const createPositionTx = await program.methods
    .initializePosition(lowerBinId, width)
    .accountsPartial({
      payer: user.publicKey,
      position: positionKP.publicKey,
      lbPair,
      owner: user.publicKey,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .transaction();

  const userTokenX = getAssociatedTokenAddressSync(
    lbPairState.tokenXMint,
    user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  const userTokenY = getAssociatedTokenAddressSync(
    lbPairState.tokenYMint,
    user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  const binArrays = getBinArrayAccountMetasCoverage(
    new BN(lowerBinId),
    new BN(upperBinId),
    lbPair,
    DLMM_PROGRAM_ID,
  );

  const addLiquidityTx = await program.methods
    .addLiquidityByStrategy2(
      {
        amountX,
        amountY,
        activeId: lbPairState.activeId,
        maxActiveBinSlippage: 10,
        strategyParameters: {
          minBinId: lowerBinId,
          maxBinId: upperBinId,
          strategyType: { spotBalanced: {} },
          parameteres: new Array(64).fill(0),
        },
      },
      { slices: [] },
    )
    .accountsPartial({
      position: positionKP.publicKey,
      lbPair,
      binArrayBitmapExtension: null,
      userTokenX,
      userTokenY,
      reserveX: lbPairState.reserveX,
      reserveY: lbPairState.reserveY,
      tokenXMint: lbPairState.tokenXMint,
      tokenYMint: lbPairState.tokenYMint,
      sender: user.publicKey,
      tokenXProgram: TOKEN_PROGRAM_ID,
      tokenYProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(binArrays)
    .transaction();

  const finalTransaction = new Transaction()
    .add(SET_COMPUTE_UNIT_LIMIT_IX)
    .add(createPositionTx)
    .add(addLiquidityTx);

  signAndSendTransaction(svm, finalTransaction, [user, positionKP]);

  return { position: positionKP.publicKey, lowerBinId, upperBinId };
}

export async function removeDlmmLiquidity(
  svm: LiteSVM,
  user: PublicKey,
  lbPair: PublicKey,
  position: PublicKey,
  lowerBinId: number,
  upperBinId: number,
): Promise<Transaction> {
  const program = createDlmmProgram();
  const lbPairState = getLbPair(svm, lbPair);

  const userTokenX = getAssociatedTokenAddressSync(
    lbPairState.tokenXMint,
    user,
    true,
    TOKEN_PROGRAM_ID,
  );
  const userTokenY = getAssociatedTokenAddressSync(
    lbPairState.tokenYMint,
    user,
    true,
    TOKEN_PROGRAM_ID,
  );

  const binArrays = getBinArrayAccountMetasCoverage(
    new BN(lowerBinId),
    new BN(upperBinId),
    lbPair,
    DLMM_PROGRAM_ID,
  );

  return await program.methods
    .removeLiquidityByRange2(lowerBinId, upperBinId, 10_000, { slices: [] })
    .accountsPartial({
      position,
      lbPair,
      binArrayBitmapExtension: null,
      userTokenX,
      userTokenY,
      reserveX: lbPairState.reserveX,
      reserveY: lbPairState.reserveY,
      tokenXMint: lbPairState.tokenXMint,
      tokenYMint: lbPairState.tokenYMint,
      sender: user,
      tokenXProgram: TOKEN_PROGRAM_ID,
      tokenYProgram: TOKEN_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
    })
    .remainingAccounts(binArrays)
    .preInstructions([SET_COMPUTE_UNIT_LIMIT_IX])
    .transaction();
}

// Create a pool and seed it with admin liquidity so a later swap has something to trade against.
export async function createSeededDlmmPool(
  svm: LiteSVM,
  admin: Keypair,
  tokenXMint: PublicKey,
  tokenYMint: PublicKey,
): Promise<PublicKey> {
  const lbPair = await createDlmmPool({
    svm,
    creator: admin,
    tokenXMint,
    tokenYMint,
  });

  // The pool activates at the current slot and the ask side (token X) can only be
  // withdrawn after the activation slot, so move one slot forward.
  svm.warpToSlot(svm.getClock().slot + BigInt(1));

  await createDlmmPositionAndAddLiquidity(
    svm,
    admin,
    lbPair,
    DLMM_SEED_LIQUIDITY_AMOUNT,
    DLMM_SEED_LIQUIDITY_AMOUNT,
  );

  // Positions always reference the bin array above their lower one, so a position that
  // starts at the active bin needs the next array up. Create two arrays on each side.
  const { activeId } = getLbPair(svm, lbPair);
  const binArraySpan = MAX_BIN_ARRAY_SIZE.toNumber() * 2;
  await createBinArrays(
    svm,
    admin,
    lbPair,
    activeId - binArraySpan,
    activeId + binArraySpan - 1,
  );

  return lbPair;
}

export async function getDlmmPosition(
  svm: LiteSVM,
  lbPair: PublicKey,
  position: PublicKey,
): Promise<LbPosition> {
  const dlmm = await DLMM.create(createLiteSvmConnection(svm), lbPair, {
    cluster: "mainnet-beta",
    programId: DLMM_PROGRAM_ID,
  });
  return await dlmm.getPosition(position);
}

// Seed a pool, add liquidity for `user`, and build (but not send) the remove-liquidity tx,
// returning what a zap-out test needs to assert on balances afterwards.
export async function setupDlmmPoolAndRemoveLiquidity(
  svm: LiteSVM,
  admin: Keypair,
  user: Keypair,
  tokenXMint: PublicKey,
  tokenYMint: PublicKey,
  inputTokenMint: PublicKey,
) {
  const lbPair = await createSeededDlmmPool(svm, admin, tokenXMint, tokenYMint);

  const { position, lowerBinId, upperBinId } =
    await createDlmmPositionAndAddLiquidity(
      svm,
      user,
      lbPair,
      DLMM_LIQUIDITY_AMOUNT,
      DLMM_LIQUIDITY_AMOUNT,
    );

  const removeLiquidityTx = await removeDlmmLiquidity(
    svm,
    user.publicKey,
    lbPair,
    position,
    lowerBinId,
    upperBinId,
  );

  const lbPairState = getLbPair(svm, lbPair);
  const outputTokenMint = getDlmmOutputMint(lbPairState, inputTokenMint);

  const { positionData } = await getDlmmPosition(svm, lbPair, position);
  const estimatedAmountIn = lbPairState.tokenXMint.equals(inputTokenMint)
    ? positionData.totalXAmountExcludeTransferFee
    : positionData.totalYAmountExcludeTransferFee;

  const userTokenInAccount = getAssociatedTokenAddressSync(
    inputTokenMint,
    user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  const userTokenOutAccount = getAssociatedTokenAddressSync(
    outputTokenMint,
    user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  const preUserTokenInBalance = getTokenBalance(svm, userTokenInAccount);
  const preUserTokenOutBalance = getTokenBalance(svm, userTokenOutAccount);

  return {
    lbPair,
    removeLiquidityTx,
    userTokenInAccount,
    userTokenOutAccount,
    preUserTokenInBalance,
    preUserTokenOutBalance,
    estimatedAmountIn,
  };
}

// Swap `amountIn` of `inputTokenMint` on the pool as `user`, moving the active bin.
export async function swapDlmm(
  svm: LiteSVM,
  user: Keypair,
  lbPair: PublicKey,
  inputTokenMint: PublicKey,
  amountIn: BN,
): Promise<void> {
  const dlmm = await DLMM.create(createLiteSvmConnection(svm), lbPair, {
    cluster: "mainnet-beta",
    programId: DLMM_PROGRAM_ID,
  });
  const swapForY = dlmm.lbPair.tokenXMint.equals(inputTokenMint);
  const binArrays = await dlmm.getBinArrayForSwap(swapForY);

  const transaction = await dlmm.swap({
    inToken: inputTokenMint,
    outToken: getDlmmOutputMint(dlmm.lbPair, inputTokenMint),
    inAmount: amountIn,
    minOutAmount: new BN(0),
    lbPair,
    user: user.publicKey,
    binArraysPubkey: binArrays.map((binArray) => binArray.publicKey),
  });

  signAndSendTransaction(svm, transaction, [user]);
}
