import DLMM, {
  BinArrayAccount,
  BinLiquidity,
  StrategyType,
  toAmountsBothSideByStrategy,
} from "@meteora-ag/dlmm";
import {
  DirectSwapEstimate,
  SwapQuoteResult,
  IndirectSwapEstimate,
  DlmmSwapType,
  DlmmDirectSwapQuoteRoute,
  DlmmSingleSided,
  EstimateDlmmDirectSwapParams,
  EstimateDlmmIndirectSwapParams,
  EstimateDlmmRebalanceSwapParams,
} from "../../types";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { getJupiterQuote } from "../jupiter";
import invariant from "invariant";

// Constants
const TOLERANCE = new Decimal(0.0001); // 0.01%
const BINARY_SEARCH_MAX_ITERATIONS = 20;
const BINARY_SEARCH_MIN_DELTA = new BN(1000);
const SWAP_BIN_ARRAY_COUNT = 4;

interface BinAmountDistribution {
  binId: number;
  amountX: BN;
  amountY: BN;
  price: string;
}

function getBinAmountDistribution(
  dlmm: DLMM,
  activeBin: BinLiquidity,
  minBinId: number,
  maxBinId: number,
  tokenXAmount: BN,
  tokenYAmount: BN,
  bins: BinLiquidity[],
  strategy: StrategyType
): BinAmountDistribution[] {
  const amountDistribution = toAmountsBothSideByStrategy(
    activeBin.binId,
    dlmm.lbPair.binStep,
    minBinId,
    maxBinId,
    tokenXAmount,
    tokenYAmount,
    activeBin.xAmount,
    activeBin.yAmount,
    strategy,
    dlmm.tokenX.mint,
    dlmm.tokenY.mint,
    dlmm.clock
  );
  const binAmountDistribution = bins
    .filter((bin) => bin.binId >= minBinId && bin.binId <= maxBinId) // direct estimate route passes extra bins so we need to filter them out
    .map((bin, i) => ({
      binId: bin.binId,
      amountX: amountDistribution[i].amountX,
      amountY: amountDistribution[i].amountY,
      price: bin.price,
    }));

  invariant(
    binAmountDistribution.length === amountDistribution.length,
    "binAmountDistribution length mismatch"
  );

  return binAmountDistribution;
}

/**
 * Calculate the value ratio of tokenX to tokenY using bin array prices
 * the ratio is thesum of y token in each bin vs the sum of x token multiply by price of y/x in each bin
 */
function calculateValueRatio(
  binAmountDistribution: BinAmountDistribution[]
): Decimal {
  const totalXAmountInTermsOfY = binAmountDistribution.reduce((acc, bin) => {
    const xInTermsOfY = new Decimal(bin.amountX.toString()).mul(
      new Decimal(bin.price)
    );
    return acc.add(xInTermsOfY);
  }, new Decimal(0));
  const totalYAmount = binAmountDistribution.reduce((acc, bin) => {
    return acc.add(new Decimal(bin.amountY.toString()));
  }, new Decimal(0));

  if (totalYAmount.isZero()) {
    return new Decimal(Infinity);
  }
  if (totalXAmountInTermsOfY.isZero()) {
    return new Decimal(0);
  }

  return totalXAmountInTermsOfY.div(totalYAmount);
}

/**
 * Fast estimation of swap output for binary search iterations
 * Uses the effective rate from an actual quote (which already includes slippage/fees)
 */
function estimateSwapOutput(inAmount: BN, effectiveRate: Decimal): BN {
  const inAmountDecimal = new Decimal(inAmount.toString());
  const estimatedOutput = inAmountDecimal.mul(effectiveRate);

  return new BN(estimatedOutput.floor().toString());
}

async function getBestSwapQuoteJupiterDlmm(
  dlmm: DLMM,
  inMint: PublicKey,
  outMint: PublicKey,
  inAmount: BN,
  swapSlippageBps: number,
  swapForY: boolean,
  binArrays: BinArrayAccount[]
): Promise<SwapQuoteResult | null> {
  let dlmmQuoteResult = null;
  try {
    dlmmQuoteResult = dlmm.swapQuote(
      inAmount,
      swapForY,
      new BN(swapSlippageBps),
      binArrays
    );
  } catch (error) {
    // dlmm quote can fail, if the pool has insufficient liquidity
    console.error("Error getting DLMM quote, using jupiter quote only:", error);
  }
  const jupiterQuoteResult = await getJupiterQuote(
    inMint,
    outMint,
    inAmount,
    50,
    swapSlippageBps,
    false,
    true,
    true,
    "https://lite-api.jup.ag"
  );

  // normalizing the quote interface
  const jupiterQuote = jupiterQuoteResult
    ? {
        inAmount: new BN(jupiterQuoteResult.inAmount),
        outAmount: new BN(jupiterQuoteResult.outAmount),
        route: DlmmDirectSwapQuoteRoute.Jupiter,
        originalQuote: jupiterQuoteResult,
      }
    : null;
  const dlmmQuote = dlmmQuoteResult
    ? {
        inAmount: dlmmQuoteResult.consumedInAmount,
        outAmount: dlmmQuoteResult.minOutAmount,
        route: DlmmDirectSwapQuoteRoute.Dlmm,
        originalQuote: dlmmQuoteResult,
      }
    : null;

  if (!dlmmQuote && !jupiterQuote) return null;
  if (!dlmmQuote) return jupiterQuote;
  if (!jupiterQuote) return dlmmQuote;

  return jupiterQuote.outAmount.gt(dlmmQuote.outAmount)
    ? jupiterQuote
    : dlmmQuote;
}

function calculateInitialSwapEstimate(
  tokenXAmount: BN,
  tokenYAmount: BN,
  currentPrice: Decimal
): BN {
  const valueX = new Decimal(tokenXAmount.toString()).mul(currentPrice);
  const valueY = new Decimal(tokenYAmount.toString());

  const diff = valueX.sub(valueY);

  if (diff.abs().div(valueX.add(valueY)).lt(TOLERANCE)) {
    return new BN(0);
  }

  // Handle negative case (Y side has excess), should not happen as we already checked the trade direction
  if (diff.lte(0)) {
    return new BN(0);
  }

  const swapValue = diff.div(2);
  const swapAmount = swapValue.div(currentPrice);

  return new BN(swapAmount.floor().toString());
}

function binarySearchRefineDirectSwapAmount(
  dlmm: DLMM,
  initialActiveBin: BinLiquidity,
  initialMinBinId: number,
  initialMaxBinId: number,
  minDeltaId: number,
  maxDeltaId: number,
  tokenXAmount: BN,
  tokenYAmount: BN,
  bins: BinLiquidity[],
  strategy: StrategyType,
  initialEffectiveSwapRate: Decimal,
  swapDirection: DlmmSwapType,
  initialRoute: DlmmDirectSwapQuoteRoute,
  swapSlippageBps: number,
  binArrayForSwap: BinArrayAccount[]
): BN {
  let left = new BN(0);
  let right = swapDirection === DlmmSwapType.XToY ? tokenXAmount : tokenYAmount;
  let best = left.add(right).div(new BN(2));
  const swapSlippageBpsBn = new BN(swapSlippageBps);
  let effectiveSwapRate = initialEffectiveSwapRate;
  let activeBin = initialActiveBin;
  let minBinId = initialMinBinId;
  let maxBinId = initialMaxBinId;
  let route = initialRoute;

  for (let i = 0; i < BINARY_SEARCH_MAX_ITERATIONS; i++) {
    const mid = left.add(right).div(new BN(2));

    // Stop if search space is too small
    if (right.sub(left).lte(BINARY_SEARCH_MIN_DELTA)) {
      best = mid;
      break;
    }

    if (route === DlmmDirectSwapQuoteRoute.Dlmm) {
      // if dlmm route is better, refresh dlmm quote for better accuracy since its fast enough
      try {
        const dlmmQuote = dlmm.swapQuote(
          mid,
          swapDirection === DlmmSwapType.XToY,
          swapSlippageBpsBn,
          binArrayForSwap
        );
        effectiveSwapRate = new Decimal(dlmmQuote.minOutAmount.toString()).div(
          new Decimal(dlmmQuote.consumedInAmount.toString())
        );
        // TODO: if we change the dlmm-sdk to return the activeBin.id, we can diirectly use that
        const newActiveBin = bins.find(
          (x) => x.price === dlmmQuote.endPrice.toString()
        );
        if (
          newActiveBin &&
          Math.abs(newActiveBin.binId - initialActiveBin.binId) <=
            SWAP_BIN_ARRAY_COUNT // check if new bin will be within the amount of bins that we initially fetched
        ) {
          activeBin = newActiveBin;
          minBinId = newActiveBin.binId + minDeltaId;
          maxBinId = newActiveBin.binId + maxDeltaId;
        } else {
          // do not refine, the bins that were swapped through exceed the amount of bins that we initially fetched
        }
      } catch (error) {
        // dlmm quote can fail, if the pool has insufficient liquidity
        console.error(
          "Error getting DLMM quote, using jupiter quote only:",
          error
        );
        route = DlmmDirectSwapQuoteRoute.Jupiter;
      }
    }

    const estimatedOutput = estimateSwapOutput(mid, effectiveSwapRate);
    const postSwapX =
      swapDirection === DlmmSwapType.XToY
        ? tokenXAmount.sub(mid)
        : tokenXAmount.add(estimatedOutput);
    const postSwapY =
      swapDirection === DlmmSwapType.XToY
        ? tokenYAmount.add(estimatedOutput)
        : tokenYAmount.sub(mid);
    const postSwapBinAmountDistribution = getBinAmountDistribution(
      dlmm,
      activeBin,
      minBinId,
      maxBinId,
      postSwapX,
      postSwapY,
      bins,
      strategy
    );
    const ratio = calculateValueRatio(postSwapBinAmountDistribution);

    if (ratio.sub(1).abs().lt(TOLERANCE)) {
      best = mid;
      break;
    }

    // Adjust binary search bounds based on ratio and swap direction
    if (swapDirection === DlmmSwapType.XToY) {
      if (ratio.gt(1)) {
        left = mid; // Too much X, need to swap more X
      } else {
        right = mid; // Too much Y, need to swap less X
      }
    } else {
      if (ratio.gt(1)) {
        right = mid; // Too much X, need to swap less Y
      } else {
        left = mid; // Too much Y, need to swap more Y
      }
    }

    best = mid;
  }

  return best;
}

/**
 * Calculate swap amounts from a single input token (that is not tokenX or tokenY)
 * to achieve balanced tokenX and tokenY amounts
 *
 * Uses Jupiter for swaps since input token is not part of the DLMM pool
 * First tries a 50:50 split (inputToken -> X and inputToken -> Y)
 * then refines using binary search if the resulting X and Y values are not balanced enough.
 *
 * @param params - Parameters for estimating indirect swap
 * @param params.inputTokenAmount - The amount of input token
 * @param params.inputTokenMint - The mint of the input token
 * @param params.lbPair - The LB pair address
 * @param params.connection - A connection to a fullnode JSON RPC endpoint
 * @param params.swapSlippageBps - Slippage tolerance in basis points
 * @param params.minDeltaId - Minimum bin delta from active bin
 * @param params.maxDeltaId - Maximum bin delta from active bin
 * @param params.strategy - Strategy type for the position
 * @param params.singleSided - If provided, swaps all input to the specified token (X or Y) instead of balancing
 * @returns IndirectSwapEstimate with swap details and post-swap token amounts
 */
export async function estimateDlmmIndirectSwap({
  inputTokenAmount,
  inputTokenMint,
  lbPair,
  connection,
  swapSlippageBps,
  minDeltaId,
  maxDeltaId,
  strategy,
  singleSided,
}: EstimateDlmmIndirectSwapParams): Promise<IndirectSwapEstimate> {
  const dlmm = await DLMM.create(connection, lbPair);
  const activeBin = await dlmm.getActiveBin();
  const tokenXMint = dlmm.lbPair.tokenXMint;
  const tokenYMint = dlmm.lbPair.tokenYMint;

  invariant(
    !inputTokenMint.equals(tokenXMint) && !inputTokenMint.equals(tokenYMint),
    "Input token must not be tokenX or tokenY for indirect route"
  );

  if (singleSided !== undefined) {
    // swap all input to target token
    const singleSidedX = singleSided === DlmmSingleSided.X;
    const outputTokenMint = singleSidedX ? tokenXMint : tokenYMint;

    const quote = await getJupiterQuote(
      inputTokenMint,
      outputTokenMint,
      inputTokenAmount,
      50,
      swapSlippageBps,
      false,
      true,
      true,
      "https://lite-api.jup.ag"
    );

    if (!quote) {
      throw new Error(
        `Failed to get Jupiter quote for single-sided indirect swap to ${
          singleSidedX ? "tokenX" : "tokenY"
        }`
      );
    }

    return {
      swapToX: singleSidedX ? quote : null,
      swapToY: singleSidedX ? null : quote,
      swapAmountToX: singleSidedX ? inputTokenAmount : new BN(0),
      swapAmountToY: singleSidedX ? new BN(0) : inputTokenAmount,
      postSwapX: singleSidedX ? new BN(quote.outAmount) : new BN(0),
      postSwapY: singleSidedX ? new BN(0) : new BN(quote.outAmount),
    };
  }

  const halfAmount = inputTokenAmount.div(new BN(2));
  const [quoteToXResult, quoteToYResult] = await Promise.allSettled([
    getJupiterQuote(
      inputTokenMint,
      tokenXMint,
      halfAmount,
      50,
      swapSlippageBps,
      false,
      true,
      true,
      "https://lite-api.jup.ag"
    ),
    getJupiterQuote(
      inputTokenMint,
      tokenYMint,
      halfAmount,
      50,
      swapSlippageBps,
      false,
      true,
      true,
      "https://lite-api.jup.ag"
    ),
  ]);

  const quoteToX =
    quoteToXResult.status === "fulfilled" ? quoteToXResult.value : null;
  const quoteToY =
    quoteToYResult.status === "fulfilled" ? quoteToYResult.value : null;

  if (!quoteToX || !quoteToY) {
    throw new Error(
      `Failed to get Jupiter quotes for indirect swap: ${
        !quoteToX ? "quoteToX failed" : ""
      }${!quoteToX && !quoteToY ? " and " : ""}${
        !quoteToY ? "quoteToY failed" : ""
      }`
    );
  }

  const initialTokenX = new BN(quoteToX.outAmount);
  const initialTokenY = new BN(quoteToY.outAmount);
  const minBinId = activeBin.binId + minDeltaId;
  const maxBinId = activeBin.binId + maxDeltaId;
  const binMeta = await dlmm.getBinsBetweenLowerAndUpperBound(
    minBinId,
    maxBinId
  );
  const binAmountDistribution = getBinAmountDistribution(
    dlmm,
    activeBin,
    minBinId,
    maxBinId,
    initialTokenX,
    initialTokenY,
    binMeta.bins,
    strategy
  );
  const initialRatio = calculateValueRatio(binAmountDistribution);

  // return early if initial split is balanced enough
  if (initialRatio.sub(1).abs().lt(TOLERANCE)) {
    return {
      swapToX: quoteToX,
      swapToY: quoteToY,
      swapAmountToX: halfAmount,
      swapAmountToY: halfAmount,
      postSwapX: initialTokenX,
      postSwapY: initialTokenY,
    };
  }

  const effectiveRateToX = new Decimal(quoteToX.outAmount).div(
    new Decimal(quoteToX.inAmount)
  );
  const effectiveRateToY = new Decimal(quoteToY.outAmount).div(
    new Decimal(quoteToY.inAmount)
  );

  // binary search to find optimal input
  // Initialize bounds based on initial 50:50 result to skip redundant first iteration
  let left: BN;
  let right: BN;
  if (initialRatio.gt(1)) {
    // Too much X value, need to swap less to X
    left = new BN(0);
    right = halfAmount;
  } else {
    // Too much Y value, need to swap more to X
    left = halfAmount;
    right = inputTokenAmount;
  }

  let bestAmountToX = halfAmount;
  let bestAmountToY = halfAmount;

  for (let i = 0; i < BINARY_SEARCH_MAX_ITERATIONS; i++) {
    const midAmountToX = left.add(right).div(new BN(2));
    const midAmountToY = inputTokenAmount.sub(midAmountToX);

    if (right.sub(left).lte(BINARY_SEARCH_MIN_DELTA)) {
      bestAmountToX = midAmountToX;
      bestAmountToY = midAmountToY;
      break;
    }

    const estimatedX = estimateSwapOutput(midAmountToX, effectiveRateToX);
    const estimatedY = estimateSwapOutput(midAmountToY, effectiveRateToY);
    const postSwapBinAmountDistribution = getBinAmountDistribution(
      dlmm,
      activeBin,
      minBinId,
      maxBinId,
      estimatedX,
      estimatedY,
      binMeta.bins,
      strategy
    );
    const ratio = calculateValueRatio(postSwapBinAmountDistribution);

    if (ratio.sub(1).abs().lt(TOLERANCE)) {
      bestAmountToX = midAmountToX;
      bestAmountToY = midAmountToY;
      break;
    }

    if (ratio.gt(1)) {
      // Too much X value, swap less to X (move left)
      right = midAmountToX;
    } else {
      // Too much Y value, swap more to X (move right)
      left = midAmountToX;
    }

    bestAmountToX = midAmountToX;
    bestAmountToY = midAmountToY;
  }

  // Get final quotes with refined amounts
  const [finalQuoteToXResult, finalQuoteToYResult] = await Promise.allSettled([
    getJupiterQuote(
      inputTokenMint,
      tokenXMint,
      bestAmountToX,
      50,
      swapSlippageBps,
      false,
      true,
      true,
      "https://lite-api.jup.ag"
    ),
    getJupiterQuote(
      inputTokenMint,
      tokenYMint,
      bestAmountToY,
      50,
      swapSlippageBps,
      false,
      true,
      true,
      "https://lite-api.jup.ag"
    ),
  ]);

  const finalQuoteToX =
    finalQuoteToXResult.status === "fulfilled"
      ? finalQuoteToXResult.value
      : null;
  const finalQuoteToY =
    finalQuoteToYResult.status === "fulfilled"
      ? finalQuoteToYResult.value
      : null;

  if (!finalQuoteToX || !finalQuoteToY) {
    // Fallback to initial 50:50 quotes
    return {
      swapToX: quoteToX,
      swapToY: quoteToY,
      swapAmountToX: halfAmount,
      swapAmountToY: halfAmount,
      postSwapX: initialTokenX,
      postSwapY: initialTokenY,
    };
  }

  const finalTokenX = new BN(finalQuoteToX.outAmount);
  const finalTokenY = new BN(finalQuoteToY.outAmount);

  return {
    swapToX: finalQuoteToX,
    swapToY: finalQuoteToY,
    swapAmountToX: bestAmountToX,
    swapAmountToY: bestAmountToY,
    postSwapX: finalTokenX,
    postSwapY: finalTokenY,
  };
}

interface EstimateDlmmDirectSwapCoreParams {
  tokenXAmount: BN;
  tokenYAmount: BN;
  lbPair: PublicKey;
  connection: Connection;
  swapSlippageBps: number;
  minDeltaId: number;
  maxDeltaId: number;
  strategy: StrategyType;
  singleSided?: DlmmSingleSided;
}

/**
 * Internal core implementation for direct swap estimation
 *
 * @internal - Use estimateDlmmDirectSwap or estimateDlmmRebalanceSwap instead
 */
async function estimateDlmmDirectSwapCore({
  tokenXAmount,
  tokenYAmount,
  lbPair,
  connection,
  swapSlippageBps,
  minDeltaId,
  maxDeltaId,
  strategy,
  singleSided,
}: EstimateDlmmDirectSwapCoreParams): Promise<DirectSwapEstimate> {
  const dlmm = await DLMM.create(connection, lbPair);
  if (singleSided !== undefined) {
    // swap all input to target token
    const singleSidedX = singleSided === DlmmSingleSided.X;
    if (singleSidedX && tokenYAmount.gt(new BN(0))) {
      const quote = await getJupiterQuote(
        dlmm.lbPair.tokenYMint,
        dlmm.lbPair.tokenXMint,
        tokenYAmount,
        50,
        swapSlippageBps,
        false,
        true,
        true,
        "https://lite-api.jup.ag"
      );

      if (!quote) {
        throw new Error(
          "Failed to get Jupiter quote for single-sided direct swap from Y to X"
        );
      }

      return {
        swapType: DlmmSwapType.YToX,
        swapAmount: tokenYAmount,
        expectedOutput: new BN(quote.outAmount),
        postSwapX: tokenXAmount.add(new BN(quote.outAmount)),
        postSwapY: new BN(0),
        quote: {
          inAmount: new BN(quote.inAmount),
          outAmount: new BN(quote.outAmount),
          route: DlmmDirectSwapQuoteRoute.Jupiter,
          originalQuote: quote,
        },
      };
    } else if (!singleSidedX && tokenXAmount.gt(new BN(0))) {
      const quote = await getJupiterQuote(
        dlmm.lbPair.tokenXMint,
        dlmm.lbPair.tokenYMint,
        tokenXAmount,
        50,
        swapSlippageBps,
        false,
        true,
        true,
        "https://lite-api.jup.ag"
      );

      if (!quote) {
        throw new Error(
          "Failed to get Jupiter quote for single-sided direct swap from X to Y"
        );
      }

      return {
        swapType: DlmmSwapType.XToY,
        swapAmount: tokenXAmount,
        expectedOutput: new BN(quote.outAmount),
        postSwapX: new BN(0),
        postSwapY: tokenYAmount.add(new BN(quote.outAmount)),
        quote: {
          inAmount: new BN(quote.inAmount),
          outAmount: new BN(quote.outAmount),
          route: DlmmDirectSwapQuoteRoute.Jupiter,
          originalQuote: quote,
        },
      };
    } else {
      // No swap needed, already have the correct token
      return {
        swapType: DlmmSwapType.NoSwap,
        swapAmount: new BN(0),
        expectedOutput: new BN(0),
        postSwapX: tokenXAmount,
        postSwapY: tokenYAmount,
        quote: null,
      };
    }
  }

  // Original balanced swap logic below
  const activeBin = await dlmm.getActiveBin();
  const minBinId = activeBin.binId + minDeltaId;
  const maxBinId = activeBin.binId + maxDeltaId;
  // get bins between minBinId and maxBinId with SWAP_BIN_ARRAY_COUNT extra bins on each side
  const binMeta = await dlmm.getBinsBetweenLowerAndUpperBound(
    minBinId - SWAP_BIN_ARRAY_COUNT,
    maxBinId + SWAP_BIN_ARRAY_COUNT
  );
  const binAmountDistribution = getBinAmountDistribution(
    dlmm,
    activeBin,
    minBinId,
    maxBinId,
    tokenXAmount,
    tokenYAmount,
    binMeta.bins,
    strategy
  );
  const activeBinPrice = new Decimal(activeBin.price);

  // Determine ratio of token values in terms of Y
  const initialRatio = calculateValueRatio(binAmountDistribution);

  // If already balanced within tolerance, no swap needed
  if (initialRatio.sub(1).abs().lt(TOLERANCE)) {
    return {
      swapAmount: new BN(0),
      swapType: DlmmSwapType.NoSwap,
      expectedOutput: new BN(0),
      postSwapX: tokenXAmount,
      postSwapY: tokenYAmount,
      quote: null,
    };
  }

  let swapType: DlmmSwapType;
  let inMint: PublicKey;
  let outMint: PublicKey;

  if (initialRatio.gt(1)) {
    // More X than Y, swap X -> Y
    swapType = DlmmSwapType.XToY;
    inMint = dlmm.lbPair.tokenXMint;
    outMint = dlmm.lbPair.tokenYMint;
  } else {
    // More Y than X, swap Y -> X
    swapType = DlmmSwapType.YToX;
    inMint = dlmm.lbPair.tokenYMint;
    outMint = dlmm.lbPair.tokenXMint;
  }

  // Get simple initial estimate using activeBinPrice
  const initialSwapAmount =
    swapType === DlmmSwapType.XToY
      ? calculateInitialSwapEstimate(tokenXAmount, tokenYAmount, activeBinPrice)
      : calculateInitialSwapEstimate(
          tokenYAmount,
          tokenXAmount,
          activeBinPrice.pow(-1)
        );

  // if zero, then calculation failed
  if (initialSwapAmount.isZero()) {
    return {
      swapAmount: new BN(0),
      swapType: DlmmSwapType.NoSwap,
      expectedOutput: new BN(0),
      postSwapX: tokenXAmount,
      postSwapY: tokenYAmount,
      quote: null,
    };
  }

  const swapForY = swapType === DlmmSwapType.XToY;
  const binArrayForSwap = await dlmm.getBinArrayForSwap(
    swapForY,
    SWAP_BIN_ARRAY_COUNT
  );
  const initialQuote = await getBestSwapQuoteJupiterDlmm(
    dlmm,
    inMint,
    outMint,
    initialSwapAmount,
    swapSlippageBps,
    swapForY,
    binArrayForSwap
  );

  if (!initialQuote) {
    throw new Error(
      `Failed to get initial swap quote for balanced direct swap (${
        swapType === DlmmSwapType.XToY ? "X to Y" : "Y to X"
      })`
    );
  }

  // calculate effective rate from initialQuote
  const effectiveSwapRate = new Decimal(initialQuote.outAmount.toString()).div(
    new Decimal(initialQuote.inAmount.toString())
  );

  const postSwapX =
    swapType === DlmmSwapType.XToY
      ? tokenXAmount.sub(initialSwapAmount) // Spent X
      : tokenXAmount.add(initialQuote.outAmount); // Received X
  const postSwapY =
    swapType === DlmmSwapType.XToY
      ? tokenYAmount.add(initialQuote.outAmount) // Received Y
      : tokenYAmount.sub(initialSwapAmount); // Spent Y
  const postSwapBinAmountDistribution = getBinAmountDistribution(
    dlmm,
    activeBin,
    minBinId,
    maxBinId,
    postSwapX,
    postSwapY,
    binMeta.bins,
    strategy
  );
  const ratio = calculateValueRatio(postSwapBinAmountDistribution);

  // check if initialSwapAmount is good enough
  if (ratio.sub(1).abs().lt(TOLERANCE)) {
    return {
      swapAmount: initialSwapAmount,
      swapType,
      expectedOutput: initialQuote.outAmount,
      postSwapX,
      postSwapY,
      quote: initialQuote,
    };
  }

  // binary search refinement
  const refinedAmount = binarySearchRefineDirectSwapAmount(
    dlmm,
    activeBin,
    minBinId,
    maxBinId,
    minDeltaId,
    maxDeltaId,
    tokenXAmount,
    tokenYAmount,
    binMeta.bins,
    strategy,
    effectiveSwapRate,
    swapType,
    initialQuote.route,
    swapSlippageBps,
    binArrayForSwap
  );

  // get final quote for refinedAmount
  const finalQuote = await getBestSwapQuoteJupiterDlmm(
    dlmm,
    inMint,
    outMint,
    refinedAmount,
    swapSlippageBps,
    swapForY,
    binArrayForSwap
  );

  if (!finalQuote) {
    // if quote fails, return initial quote
    return {
      swapAmount: initialSwapAmount,
      swapType,
      expectedOutput: initialQuote.outAmount,
      postSwapX,
      postSwapY,
      quote: initialQuote,
    };
  }

  const finalPostSwapX =
    swapType === DlmmSwapType.XToY
      ? tokenXAmount.sub(refinedAmount) // Spent X
      : tokenXAmount.add(finalQuote.outAmount); // Received X
  const finalPostSwapY =
    swapType === DlmmSwapType.XToY
      ? tokenYAmount.add(finalQuote.outAmount) // Received Y
      : tokenYAmount.sub(refinedAmount); // Spent Y

  return {
    swapAmount: refinedAmount,
    swapType,
    expectedOutput: finalQuote.outAmount,
    postSwapX: finalPostSwapX,
    postSwapY: finalPostSwapY,
    quote: finalQuote,
  };
}

/**
 * Calculate optimal swap amount for zap-in deposits (single token input)
 *
 * For balanced deposits: Balances single token input to achieve equal value by swapping
 * For single-sided deposits: Swaps all input to the specified target token (X or Y)
 *
 * @param params - Parameters for estimating direct swap
 * @param params.tokenAmount - The amount of input token
 * @param params.isInputTokenX - Whether the input token is tokenX (true) or tokenY (false)
 * @param params.lbPair - The LB pair address
 * @param params.connection - A connection to a fullnode JSON RPC endpoint
 * @param params.swapSlippageBps - Slippage tolerance in basis points
 * @param params.minDeltaId - Minimum bin delta from active bin
 * @param params.maxDeltaId - Maximum bin delta from active bin
 * @param params.strategy - Strategy type for the position
 * @param params.singleSided - If provided, swaps all input to the specified token (X or Y) instead of balancing
 * @returns DirectSwapEstimate with swap details and post-swap token amounts
 */
export async function estimateDlmmDirectSwap({
  tokenAmount,
  isInputTokenX,
  lbPair,
  connection,
  swapSlippageBps,
  minDeltaId,
  maxDeltaId,
  strategy,
  singleSided,
}: EstimateDlmmDirectSwapParams): Promise<DirectSwapEstimate> {
  const tokenXAmount = isInputTokenX ? tokenAmount : new BN(0);
  const tokenYAmount = isInputTokenX ? new BN(0) : tokenAmount;

  return estimateDlmmDirectSwapCore({
    tokenXAmount,
    tokenYAmount,
    lbPair,
    connection,
    swapSlippageBps,
    minDeltaId,
    maxDeltaId,
    strategy,
    singleSided,
  });
}

/**
 * Calculate optimal swap amount for rebalancing existing positions (both tokens)
 *
 * Balances existing tokenX and tokenY amounts to achieve equal value by swapping
 * excess of one token to the other using either the DLMM pool or Jupiter
 *
 * @param params - Parameters for estimating rebalance swap
 * @param params.tokenXAmount - The amount of tokenX
 * @param params.tokenYAmount - The amount of tokenY
 * @param params.lbPair - The LB pair address
 * @param params.connection - A connection to a fullnode JSON RPC endpoint
 * @param params.swapSlippageBps - Slippage tolerance in basis points
 * @param params.minDeltaId - Minimum bin delta from active bin
 * @param params.maxDeltaId - Maximum bin delta from active bin
 * @param params.strategy - Strategy type for the position
 * @returns DirectSwapEstimate with swap details and post-swap token amounts
 */
export async function estimateDlmmRebalanceSwap({
  tokenXAmount,
  tokenYAmount,
  lbPair,
  connection,
  swapSlippageBps,
  minDeltaId,
  maxDeltaId,
  strategy,
}: EstimateDlmmRebalanceSwapParams): Promise<DirectSwapEstimate> {
  return estimateDlmmDirectSwapCore({
    tokenXAmount,
    tokenYAmount,
    lbPair,
    connection,
    swapSlippageBps,
    minDeltaId,
    maxDeltaId,
    strategy,
    singleSided: undefined, // rebalance does not use single-sided deposits
  });
}
