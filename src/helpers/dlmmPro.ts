import {
  AccountMeta,
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { IdlTypes } from "@anchor-lang/core";
import {
  DlmmProClient,
  Pool,
  SwapParams,
  deriveReserve,
  deriveTickArray,
  deriveTickArrayBitmapExtension,
  getExtraAccountMetasForTransferHook,
  tickArrayIndexesForTickIds,
  tickArraysForSwap,
  tickIndexFromId,
} from "@meteora-ag/dlmm-pro-sdk";
import invariant from "invariant";
import { AccountsType, DLMM_PRO_PROGRAM_ID } from "../constants";
import { Zap } from "../idl/zap/idl";
import { DlmmProZapInParameters } from "../types";

/**
 * The DLMM Pro `swap` instruction alone. The DLMM Pro SDK also creates the token accounts and
 * wraps SOL around it, which the zap does itself.
 */
export async function getDlmmProSwapInstruction(
  client: DlmmProClient,
  params: SwapParams,
): Promise<TransactionInstruction> {
  const { tx } = await client.pool.swap(params);
  const swapInstruction = tx.instructions.find((ix) =>
    ix.programId.equals(DLMM_PRO_PROGRAM_ID),
  );
  invariant(swapInstruction, "DLMM Pro swap instruction not found");
  return swapInstruction;
}

export async function getDlmmProTickArraysForSwap(
  client: DlmmProClient,
  pool: PublicKey,
  poolState: Pool,
  swapForY: boolean,
): Promise<PublicKey[]> {
  const extensionState =
    poolState.isBitmapExtensionInitialized === 1
      ? await client.state.fetchTickArrayBitmapExtension(
          deriveTickArrayBitmapExtension(pool),
        )
      : null;
  return tickArraysForSwap({ pool, poolState, extensionState, swapForY })
    .tickArrays;
}

/**
 * Tick arrays `zap_in_dlmm_pro` takes as remaining accounts.
 * Without `leftover`, the tick arrays of the ranges, in the order the program opens them.
 * With `leftover`, only one of its two ranges is opened and a relative inner bound follows the
 * pool tick, so this also returns every tick array either range can need for a pool tick within
 * `currentTickId ± maxTickSlippage`. The program picks the ones it needs.
 */
export function getDlmmProZapInTickArrays(
  pool: PublicKey,
  tickSpacing: number,
  parameters: Pick<
    DlmmProZapInParameters,
    "ranges" | "currentTickId" | "maxTickSlippage" | "leftover"
  >,
): AccountMeta[] {
  const { ranges, currentTickId, maxTickSlippage, leftover } = parameters;
  const tickIds = ranges.flatMap((range) => [
    range.tickLowerId,
    range.tickUpperId,
  ]);
  if (leftover) {
    tickIds.push(leftover.rangeX.outerTickId, leftover.rangeY.outerTickId);
  }
  const indexes = new Set(tickArrayIndexesForTickIds(tickIds, tickSpacing));

  if (leftover) {
    const { rangeX, rangeY, isInnerTickRelative } = leftover;
    const align = (tickId: number) =>
      Math.floor(tickId / tickSpacing) * tickSpacing;
    const innerTickIdX = (poolTickId: number) =>
      isInnerTickRelative
        ? align(poolTickId) + (rangeX.innerTickId + 1) * tickSpacing
        : rangeX.innerTickId;
    const innerTickIdY = (poolTickId: number) =>
      isInnerTickRelative
        ? align(poolTickId) - rangeY.innerTickId * tickSpacing
        : rangeY.innerTickId;
    const lowestPoolTickId = currentTickId - maxTickSlippage;
    const highestPoolTickId = currentTickId + maxTickSlippage;
    for (const innerTickId of [innerTickIdX, innerTickIdY]) {
      const lastIndex = tickIndexFromId(
        innerTickId(highestPoolTickId),
        tickSpacing,
      );
      for (
        let index = tickIndexFromId(innerTickId(lowestPoolTickId), tickSpacing);
        index <= lastIndex;
        index++
      ) {
        indexes.add(index);
      }
    }
  }

  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      pubkey: deriveTickArray(pool, index),
      isSigner: false,
      isWritable: true,
    }));
}

/** Returns no accounts and no slices when neither mint has a transfer hook. */
export async function getDlmmProDepositTransferHookAccounts(
  connection: Connection,
  params: {
    pool: PublicKey;
    user: PublicKey;
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    userTokenX: PublicKey;
    userTokenY: PublicKey;
  },
): Promise<{
  remainingAccounts: AccountMeta[];
  remainingAccountsInfo: IdlTypes<Zap>["dlmmProDlmmProTypesRemainingAccountsInfo"];
}> {
  const { pool, user, tokenXMint, tokenYMint, userTokenX, userTokenY } = params;
  const [transferHookX, transferHookY] = await Promise.all([
    getExtraAccountMetasForTransferHook(connection, {
      mint: tokenXMint,
      source: userTokenX,
      destination: deriveReserve(tokenXMint, pool),
      authority: user,
    }),
    getExtraAccountMetasForTransferHook(connection, {
      mint: tokenYMint,
      source: userTokenY,
      destination: deriveReserve(tokenYMint, pool),
      authority: user,
    }),
  ]);

  const slices = [
    { accountsType: AccountsType.TransferHookX, length: transferHookX.length },
    { accountsType: AccountsType.TransferHookY, length: transferHookY.length },
  ].filter((slice) => slice.length > 0);

  return {
    remainingAccounts: [...transferHookX, ...transferHookY],
    remainingAccountsInfo: { slices },
  };
}
