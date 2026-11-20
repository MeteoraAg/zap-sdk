import {
  DecodedPoolExtensions,
  DlmmProClient,
  Pool,
  QuoteExactInResponse,
  TokenProgramFlags,
  calculateTransferFeeExcludedAmount,
  deriveTickArrayBitmapExtension,
  getSqrtPriceFromTickId,
  quoteExactIn,
  readClock,
  tickArraysForSwap,
} from "@meteora-ag/dlmm-pro-sdk";
import { Mint, TOKEN_2022_PROGRAM_ID, getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import invariant from "invariant";
import {
  DlmmProDirectSwapEstimate,
  DlmmProDirectSwapQuoteRoute,
  DlmmProIndirectSwapEstimate,
  DlmmProPositionRangeParameters,
  DlmmProSwapQuoteResult,
  DlmmSwapType,
  EstimateDlmmProDirectSwapParams,
  EstimateDlmmProIndirectSwapParams,
} from "../../types";
import { getJupiterQuote } from "../jupiter";

const Q128 = new BN(1).shln(128);
const U128_MAX = Q128.subn(1);

type PoolPrice = Pick<Pool, "tickCurrentId" | "sqrtPrice">;

function divCeil(numerator: BN, denominator: BN): BN {
  const { div, mod } = numerator.divmod(denominator);
  return mod.isZero() ? div : div.addn(1);
}

/**
 * Token amounts the ranges take per unit of multiplier, in Q64 and rounded up per range, as
 * `get_balanced_multiplier` of the zap program sums them.
 */
function getAmountsPerMultiplier(
  ranges: DlmmProPositionRangeParameters[],
  { tickCurrentId, sqrtPrice }: PoolPrice,
): { amountX: BN; amountY: BN } {
  const amountX = new BN(0);
  const amountY = new BN(0);
  // with liquidity = weight << 64:
  // Δx = (liquidity << 64) * (√P_upper - √P_lower) / (√P_upper * √P_lower)
  // Δy = liquidity * (√P_upper - √P_lower) >> 64
  const addAmountX = (lower: BN, upper: BN, weight: number) =>
    amountX.iadd(
      divCeil(upper.sub(lower).muln(weight).shln(128), lower.mul(upper)),
    );
  const addAmountY = (lower: BN, upper: BN, weight: number) =>
    amountY.iadd(upper.sub(lower).muln(weight));

  for (const { tickLowerId, tickUpperId, weight } of ranges) {
    const lowerSqrtPrice = getSqrtPriceFromTickId(tickLowerId);
    const upperSqrtPrice = getSqrtPriceFromTickId(tickUpperId);
    // DLMM Pro picks the side by tick id, not by sqrt price
    if (tickCurrentId < tickLowerId) {
      addAmountX(lowerSqrtPrice, upperSqrtPrice, weight);
    } else if (tickCurrentId < tickUpperId) {
      addAmountX(sqrtPrice, upperSqrtPrice, weight);
      addAmountY(lowerSqrtPrice, sqrtPrice, weight);
    } else {
      addAmountY(lowerSqrtPrice, upperSqrtPrice, weight);
    }
  }
  return { amountX, amountY };
}

/**
 * The multiplier `zap_in_dlmm_pro` sizes the deposit with, mirroring `get_balanced_multiplier` of
 * the zap program: the largest one whose deposit of `multiplier * weight` liquidity into every
 * range fits both amounts. It is 0 when a side the ranges take cannot fund any liquidity, which
 * the program rejects with `ZeroLiquidity`.
 *
 * `tickCurrentId` and `sqrtPrice` are the pool's when the zap in executes. `amountX` and `amountY`
 * are what reaches the pool, after the Token 2022 transfer fee.
 */
export function getDlmmProZapInMultiplier(args: {
  ranges: DlmmProPositionRangeParameters[];
  tickCurrentId: number;
  sqrtPrice: BN;
  amountX: BN;
  amountY: BN;
}): BN {
  const { ranges, amountX, amountY } = args;
  const amountsPerMultiplier = getAmountsPerMultiplier(ranges, args);
  const rangeCount = new BN(ranges.length);
  const maxWeight = Math.max(1, ...ranges.map((range) => range.weight));

  // DLMM Pro computes `multiplier * weight` in u128
  let multiplier = U128_MAX.divn(maxWeight);
  for (const [amount, amountPerMultiplier] of [
    [amountX, amountsPerMultiplier.amountX],
    [amountY, amountsPerMultiplier.amountY],
  ]) {
    if (amountPerMultiplier.isZero()) {
      continue;
    }
    // every range rounds its deposit up, by less than one unit each
    const budget = BN.max(amount.sub(rangeCount), new BN(0));
    multiplier = BN.min(multiplier, budget.shln(64).div(amountPerMultiplier));
  }
  return multiplier;
}

function getShare(amount: BN, shareValue: BN, otherValue: BN): BN {
  return amount.mul(shareValue).div(shareValue.add(otherValue));
}

/**
 * The pool and what a quote reads besides it, fetched once so every quote of an estimate sees the
 * same state.
 */
type PoolSnapshot = {
  poolState: Pool;
  extensions: DecodedPoolExtensions;
  /** `null` for an SPL Token mint, which has no transfer fee */
  mintX: Mint | null;
  mintY: Mint | null;
  clock: Awaited<ReturnType<typeof readClock>>;
};

async function fetchPoolSnapshot(
  client: DlmmProClient,
  connection: Connection,
  pool: PublicKey,
): Promise<PoolSnapshot> {
  const { pool: poolState, extensions } =
    await client.state.fetchPoolWithExtensions(pool);
  const getTransferFeeMint = (mint: PublicKey, tokenFlag: number) =>
    tokenFlag === TokenProgramFlags.TokenProgram2022
      ? getMint(connection, mint, undefined, TOKEN_2022_PROGRAM_ID)
      : null;
  const [mintX, mintY, clock] = await Promise.all([
    getTransferFeeMint(poolState.tokenXMint, poolState.tokenXFlag),
    getTransferFeeMint(poolState.tokenYMint, poolState.tokenYFlag),
    readClock(connection),
  ]);
  return { poolState, extensions, mintX, mintY, clock };
}

/** What reaches the pool of a deposit of `amount`, after the Token 2022 transfer fee */
function getDepositAmount(
  { clock }: PoolSnapshot,
  mint: Mint | null,
  amount: BN,
): BN {
  return calculateTransferFeeExcludedAmount(mint, clock.epoch, amount).amount;
}

function getExpectedMultiplier(
  snapshot: PoolSnapshot,
  ranges: DlmmProPositionRangeParameters[],
  poolPrice: PoolPrice,
  amountX: BN,
  amountY: BN,
): BN {
  return getDlmmProZapInMultiplier({
    ranges,
    ...poolPrice,
    amountX: getDepositAmount(snapshot, snapshot.mintX, amountX),
    amountY: getDepositAmount(snapshot, snapshot.mintY, amountY),
  });
}

/**
 * Quotes swaps through the pool from the snapshot, without further RPC calls once the tick
 * arrays are fetched. A quote is `null` when the swap would revert.
 */
async function getPoolSwapQuoter(
  client: DlmmProClient,
  pool: PublicKey,
  { poolState, extensions, mintX, mintY, clock }: PoolSnapshot,
  swapForY: boolean,
  swapper: PublicKey,
): Promise<(inputAmount: BN) => QuoteExactInResponse | null> {
  const bitmapExtensionAddress = deriveTickArrayBitmapExtension(pool);
  const bitmapExtension =
    poolState.isBitmapExtensionInitialized === 1
      ? await client.state.fetchTickArrayBitmapExtension(bitmapExtensionAddress)
      : null;
  const selection = tickArraysForSwap({
    pool,
    poolState,
    extensionState: bitmapExtension,
    swapForY,
  });
  const tickArrays = (
    await client.state.fetchTickArraysWithTicks(selection.tickArrays, {
      withReward: extensions.rewards !== undefined,
    })
  ).map(({ tickArray, ticks }) => ({
    pool: tickArray.pool,
    tickIndex: tickArray.tickIndex,
    ticks,
  }));

  return (inputAmount) => {
    try {
      const quote = quoteExactIn({
        poolAddress: pool,
        pool: poolState,
        poolActivation: extensions.activation ?? null,
        tickArrays,
        bitmapExtension,
        inputAmount,
        swapForY,
        hasReferral: false,
        swapper,
        currentSlot: clock.slot,
        currentTimestamp: clock.timestamp,
        epoch: clock.epoch,
        inputMint: swapForY ? mintX : mintY,
        outputMint: swapForY ? mintY : mintX,
      });
      // the swap reverts when the pool cannot take the whole input
      if (!quote.amountLeft.isZero()) {
        return null;
      }
      return {
        quote,
        tickArrays: selection.tickArrays,
        tickArrayBitmapExtension: selection.requiresBitmapExtension
          ? bitmapExtensionAddress
          : null,
      };
    } catch {
      // the pool cannot take the swap, such as with no liquidity in its direction
      return null;
    }
  };
}

/**
 * Calculate the swap amount for a DLMM Pro zap in from tokenX or tokenY, so that what is left of
 * the input token and what the swap returns are in the ratio the ranges take them.
 *
 * The swap goes through Jupiter or the pool itself, whichever quotes more for a swap sized at the
 * pool price. A Jupiter swap is then sized again at the rate of that quote. A swap through the
 * pool moves its price, and with it the ratio the ranges take, so it is sized with pool quotes at
 * the price each one ends at.
 *
 * @param params - Parameters for estimating direct swap
 * @param params.user - The wallet the swap is built for
 * @param params.amountIn - The amount of input token
 * @param params.inputTokenMint - The mint of the input token
 * @param params.pool - The DLMM Pro pool address
 * @param params.connection - A connection to a fullnode JSON RPC endpoint
 * @param params.swapSlippageBps - Slippage tolerance in basis points
 * @param params.ranges - The position ranges in absolute tick ids, with their weights
 * @param params.jupiterQuoteOptions - Optional Jupiter query parameters, see `GetJupiterQuoteParams.queryParams`
 * @param params.config - Optional configuration for Jupiter API URL (default: https://api.jup.ag) and API key (default: empty string)
 * @returns The swap, the token amounts after it, and the pool tick and multiplier expected at the zap in
 * @throws if inputTokenMint is not a token of the pool
 * @throws if failed to get both Jupiter and DLMM Pro swap quotes
 */
export async function estimateDlmmProDirectSwap({
  user,
  amountIn,
  inputTokenMint,
  pool,
  connection,
  swapSlippageBps,
  ranges,
  jupiterQuoteOptions,
  config,
}: EstimateDlmmProDirectSwapParams): Promise<DlmmProDirectSwapEstimate> {
  const client = new DlmmProClient(connection);
  const snapshot = await fetchPoolSnapshot(client, connection, pool);
  const { poolState } = snapshot;
  const { tokenXMint, tokenYMint } = poolState;

  invariant(
    inputTokenMint.equals(tokenXMint) || inputTokenMint.equals(tokenYMint),
    "Input token must be tokenX or tokenY for direct route",
  );

  const isInputTokenX = inputTokenMint.equals(tokenXMint);
  const [inputMint, outputMint] = isInputTokenX
    ? [snapshot.mintX, snapshot.mintY]
    : [snapshot.mintY, snapshot.mintX];

  // what the ranges take of the input and of the output token per unit of multiplier
  const getNeeds = (poolPrice: PoolPrice) => {
    const { amountX, amountY } = getAmountsPerMultiplier(ranges, poolPrice);
    return isInputTokenX ? [amountX, amountY] : [amountY, amountX];
  };

  const toEstimate = (
    quote: DlmmProSwapQuoteResult | null,
  ): DlmmProDirectSwapEstimate => {
    const swapAmount = quote?.inAmount ?? new BN(0);
    const expectedOutput = quote?.outAmount ?? new BN(0);
    const [postSwapX, postSwapY] = isInputTokenX
      ? [amountIn.sub(swapAmount), expectedOutput]
      : [expectedOutput, amountIn.sub(swapAmount)];

    let swapType = DlmmSwapType.NoSwap;
    let poolPrice: PoolPrice = poolState;
    if (quote) {
      swapType = isInputTokenX ? DlmmSwapType.XToY : DlmmSwapType.YToX;
      if (quote.route === DlmmProDirectSwapQuoteRoute.DlmmPro) {
        const { nextTickId, nextSqrtPrice } = quote.originalQuote.quote;
        poolPrice = { tickCurrentId: nextTickId, sqrtPrice: nextSqrtPrice };
      }
    }

    return {
      result: {
        swapType,
        swapAmount,
        expectedOutput,
        postSwapX,
        postSwapY,
        quote,
        currentTickId: poolPrice.tickCurrentId,
        multiplier: getExpectedMultiplier(
          snapshot,
          ranges,
          poolPrice,
          postSwapX,
          postSwapY,
        ),
      },
      context: { amountIn, inputTokenMint, pool, swapSlippageBps, ranges },
    };
  };

  // (amountIn - swapAmount) / (swapAmount * rateOut / rateIn) = needIn / needOut
  const [needIn, needOut] = getNeeds(poolState);
  const getSwapAmount = (rateIn: BN, rateOut: BN) =>
    getShare(amountIn, needOut.mul(rateIn), needIn.mul(rateOut));

  // price of tokenX in tokenY = sqrtPrice^2 / 2^128
  const sqrtPriceSquared = poolState.sqrtPrice.sqr();
  const initialSwapAmount = isInputTokenX
    ? getSwapAmount(Q128, sqrtPriceSquared)
    : getSwapAmount(sqrtPriceSquared, Q128);
  if (initialSwapAmount.isZero()) {
    return toEstimate(null);
  }

  // Jupiter quote with jupiterQuoteOptions.
  // Not equivalent to Jupiter UI. Caller must validate outAmount.
  const getJupiterSwapQuote = (amount: BN) =>
    getJupiterQuote(
      {
        inputMint: inputTokenMint,
        outputMint: isInputTokenX ? tokenYMint : tokenXMint,
        amount,
        user,
        queryParams: {
          slippageBps: swapSlippageBps,
          ...jupiterQuoteOptions,
        },
      },
      config,
    );
  const quotePoolSwap = await getPoolSwapQuoter(
    client,
    pool,
    snapshot,
    isInputTokenX,
    user,
  );

  const initialPoolQuote = quotePoolSwap(initialSwapAmount);
  const initialJupiterQuote = await getJupiterSwapQuote(initialSwapAmount);
  if (!initialPoolQuote && !initialJupiterQuote) {
    throw new Error(
      `Failed to get swap quote for direct swap (${
        isInputTokenX ? "X to Y" : "Y to X"
      })`,
    );
  }

  if (
    initialJupiterQuote &&
    (!initialPoolQuote ||
      new BN(initialJupiterQuote.outAmount).gt(
        initialPoolQuote.quote.transferFeeExcludedOutAmount,
      ))
  ) {
    const refinedSwapAmount = getSwapAmount(
      new BN(initialJupiterQuote.inAmount),
      new BN(initialJupiterQuote.outAmount),
    );
    let jupiterQuote = initialJupiterQuote;
    if (
      !refinedSwapAmount.isZero() &&
      !refinedSwapAmount.eq(initialSwapAmount)
    ) {
      jupiterQuote =
        (await getJupiterSwapQuote(refinedSwapAmount)) ?? initialJupiterQuote;
    }
    return toEstimate({
      inAmount: new BN(jupiterQuote.inAmount),
      outAmount: new BN(jupiterQuote.outAmount),
      route: DlmmProDirectSwapQuoteRoute.Jupiter,
      originalQuote: jupiterQuote,
    });
  }

  // Swapping more leaves less of the input token while the ranges take more of it at the price
  // the swap moves to, so the largest swap that leaves enough input for what it returns uses up
  // both tokens.
  const isInputEnough = (swapAmount: BN): boolean => {
    const poolQuote = quotePoolSwap(swapAmount);
    if (!poolQuote) {
      return false;
    }
    const { nextTickId, nextSqrtPrice, transferFeeExcludedOutAmount } =
      poolQuote.quote;
    const [needIn, needOut] = getNeeds({
      tickCurrentId: nextTickId,
      sqrtPrice: nextSqrtPrice,
    });
    return getDepositAmount(snapshot, inputMint, amountIn.sub(swapAmount))
      .mul(needOut)
      .gte(
        getDepositAmount(
          snapshot,
          outputMint,
          transferFeeExcludedOutAmount,
        ).mul(needIn),
      );
  };
  let swapAmount = new BN(0);
  let tooLargeSwapAmount = amountIn.addn(1);
  while (tooLargeSwapAmount.sub(swapAmount).gtn(1)) {
    const middle = swapAmount.add(tooLargeSwapAmount).shrn(1);
    if (isInputEnough(middle)) {
      swapAmount = middle;
    } else {
      tooLargeSwapAmount = middle;
    }
  }

  const poolQuote = swapAmount.isZero() ? null : quotePoolSwap(swapAmount);
  return toEstimate(
    poolQuote && {
      inAmount: swapAmount,
      outAmount: poolQuote.quote.transferFeeExcludedOutAmount,
      route: DlmmProDirectSwapQuoteRoute.DlmmPro,
      originalQuote: poolQuote,
    },
  );
}

/**
 * Calculate the swap amounts for a DLMM Pro zap in from a token that is neither tokenX nor
 * tokenY, so that the two outputs are in the ratio the ranges take them.
 *
 * Both swaps go through Jupiter. The input is first split in half, then split again at the rates
 * of the first quotes. A side the ranges do not take gets no swap.
 *
 * @param params - Parameters for estimating indirect swap
 * @param params.user - The wallet the swaps are built for
 * @param params.amountIn - The amount of input token
 * @param params.inputTokenMint - The mint of the input token
 * @param params.pool - The DLMM Pro pool address
 * @param params.connection - A connection to a fullnode JSON RPC endpoint
 * @param params.swapSlippageBps - Slippage tolerance in basis points
 * @param params.ranges - The position ranges in absolute tick ids, with their weights
 * @param params.jupiterQuoteOptions - Optional Jupiter query parameters, see `GetJupiterQuoteParams.queryParams`
 * @param params.config - Optional configuration for Jupiter API URL (default: https://api.jup.ag) and API key (default: empty string)
 * @returns The swaps, the token amounts after them, and the pool tick and multiplier expected at the zap in
 * @throws if inputTokenMint is a token of the pool
 * @throws if failed to get Jupiter swap quote
 */
export async function estimateDlmmProIndirectSwap({
  user,
  amountIn,
  inputTokenMint,
  pool,
  connection,
  swapSlippageBps,
  ranges,
  jupiterQuoteOptions,
  config,
}: EstimateDlmmProIndirectSwapParams): Promise<DlmmProIndirectSwapEstimate> {
  const snapshot = await fetchPoolSnapshot(
    new DlmmProClient(connection),
    connection,
    pool,
  );
  const { poolState } = snapshot;
  const { tokenXMint, tokenYMint } = poolState;

  invariant(
    !inputTokenMint.equals(tokenXMint) && !inputTokenMint.equals(tokenYMint),
    "Input token must not be tokenX or tokenY for indirect route",
  );

  const getQuote = async (outputMint: PublicKey, amount: BN) =>
    amount.isZero()
      ? null
      : getJupiterQuote(
          {
            inputMint: inputTokenMint,
            outputMint,
            amount,
            user,
            queryParams: {
              slippageBps: swapSlippageBps,
              ...jupiterQuoteOptions,
            },
          },
          config,
        );

  const getQuotes = async (swapAmountToX: BN) => {
    const swapAmountToY = amountIn.sub(swapAmountToX);
    const [swapToX, swapToY] = await Promise.all([
      getQuote(tokenXMint, swapAmountToX),
      getQuote(tokenYMint, swapAmountToY),
    ]);
    const isQuoted =
      (swapToX !== null || swapAmountToX.isZero()) &&
      (swapToY !== null || swapAmountToY.isZero());
    return isQuoted ? { swapToX, swapToY, swapAmountToX, swapAmountToY } : null;
  };

  const { amountX: needX, amountY: needY } = getAmountsPerMultiplier(
    ranges,
    poolState,
  );
  let initialSwapAmountToX = amountIn.divn(2);
  if (needY.isZero()) {
    initialSwapAmountToX = amountIn;
  } else if (needX.isZero()) {
    initialSwapAmountToX = new BN(0);
  }

  const initialQuotes = await getQuotes(initialSwapAmountToX);
  if (!initialQuotes) {
    throw new Error("Failed to get Jupiter quotes for indirect swap");
  }

  let quotes = initialQuotes;
  if (initialQuotes.swapToX && initialQuotes.swapToY) {
    // outX / outY = needX / needY, with each output at the rate of its initial quote
    const refinedSwapAmountToX = getShare(
      amountIn,
      needX
        .mul(new BN(initialQuotes.swapToY.outAmount))
        .mul(initialQuotes.swapAmountToX),
      needY
        .mul(new BN(initialQuotes.swapToX.outAmount))
        .mul(initialQuotes.swapAmountToY),
    );
    quotes = (await getQuotes(refinedSwapAmountToX)) ?? initialQuotes;
  }

  const postSwapX = new BN(quotes.swapToX?.outAmount ?? 0);
  const postSwapY = new BN(quotes.swapToY?.outAmount ?? 0);

  return {
    result: {
      ...quotes,
      postSwapX,
      postSwapY,
      currentTickId: poolState.tickCurrentId,
      multiplier: getExpectedMultiplier(
        snapshot,
        ranges,
        poolState,
        postSwapX,
        postSwapY,
      ),
    },
    context: { amountIn, inputTokenMint, pool, swapSlippageBps, ranges },
  };
}
