import DLMM, { BinLiquidity, SwapQuote } from "@meteora-ag/dlmm";
import {
  DirectSwapEstimate,
  SwapQuoteResult,
  IndirectSwapEstimate,
} from "../types";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { getJupiterQuote } from "./jupiter";
import invariant from "invariant";

// Constants
const TOLERANCE = new Decimal(0.0001); // 0.01%
const BINARY_SEARCH_MAX_ITERATIONS = 20;
const BINARY_SEARCH_MIN_DELTA = new BN(1000);

/**
 * Calculate the value ratio of tokenX to tokenY using given price
 */
function calculateValueRatio(
  tokenXAmount: BN,
  tokenYAmount: BN,
  price: Decimal
): Decimal {
  const valueX = new Decimal(tokenXAmount.toString()).mul(price);
  const valueY = new Decimal(tokenYAmount.toString());

  if (valueY.isZero()) {
    return new Decimal(Infinity);
  }
  if (valueX.isZero()) {
    return new Decimal(0);
  }

  return valueX.div(valueY);
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

async function getDlmmSwapQuote(
  dlmm: DLMM,
  inMint: PublicKey,
  inAmount: BN,
  slippageBps: number
): Promise<SwapQuote | null> {
  const swapForY = dlmm.lbPair.tokenXMint.equals(inMint);
  const binArrays = await dlmm.getBinArrayForSwap(swapForY);
  const quotation = dlmm.swapQuote(
    inAmount,
    swapForY,
    new BN(slippageBps),
    binArrays
  );

  return quotation;
}

async function getBestSwapQuoteJupiterDlmm(
  dlmm: DLMM,
  inMint: PublicKey,
  outMint: PublicKey,
  inAmount: BN,
  swapSlippageBps: number
): Promise<SwapQuoteResult | null> {
  const [dlmmQuoteResult, jupiterQuoteResult] = await Promise.allSettled([
    getDlmmSwapQuote(dlmm, inMint, inAmount, swapSlippageBps),
    getJupiterQuote(
      inMint,
      outMint,
      inAmount,
      50,
      swapSlippageBps,
      false,
      true,
      true,
      "https://lite-api.jup.ag"
    ),
  ]);

  // normalizing the quote interface
  const jupiterQuote =
    jupiterQuoteResult.status === "fulfilled" && jupiterQuoteResult.value
      ? {
          inAmount: new BN(jupiterQuoteResult.value.inAmount),
          outAmount: new BN(jupiterQuoteResult.value.outAmount),
          route: "jupiter" as const,
          originalQuote: jupiterQuoteResult.value,
        }
      : null;
  const dlmmQuote =
    dlmmQuoteResult.status === "fulfilled" && dlmmQuoteResult.value
      ? {
          inAmount: dlmmQuoteResult.value.consumedInAmount,
          outAmount: dlmmQuoteResult.value.minOutAmount,
          route: "dlmm" as const,
          originalQuote: dlmmQuoteResult.value,
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
  tokenXAmount: BN,
  tokenYAmount: BN,
  fixedRate: Decimal,
  marketPrice: Decimal
): BN {
  let left = new BN(0);
  let right = tokenXAmount;
  let best = left.add(right).div(new BN(2));

  for (let i = 0; i < BINARY_SEARCH_MAX_ITERATIONS; i++) {
    const mid = left.add(right).div(new BN(2));

    // Stop if search space is too small
    if (right.sub(left).lte(BINARY_SEARCH_MIN_DELTA)) {
      best = mid;
      break;
    }

    const estimatedOutput = estimateSwapOutput(mid, fixedRate);
    const postSwapX = tokenXAmount.sub(mid);
    const postSwapY = tokenYAmount.add(estimatedOutput);
    const ratio = calculateValueRatio(postSwapX, postSwapY, marketPrice);

    if (ratio.sub(1).abs().lt(TOLERANCE)) {
      best = mid;
      break;
    }

    if (ratio.gt(1)) {
      left = mid; // Too much X, need to swap more
    } else {
      right = mid; // Too much Y, need to swap less
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
 */
export async function estimateIndirectSwap(
  inputTokenAmount: BN,
  inputTokenMint: PublicKey,
  dlmm: DLMM,
  swapSlippageBps: number
): Promise<IndirectSwapEstimate> {
  const activeBin = await dlmm.getActiveBin();
  const activeBinPrice = new Decimal(activeBin.price);
  const tokenXMint = dlmm.lbPair.tokenXMint;
  const tokenYMint = dlmm.lbPair.tokenYMint;

  invariant(
    !inputTokenMint.equals(tokenXMint) && !inputTokenMint.equals(tokenYMint),
    "Input token must not be tokenX or tokenY for indirect route"
  );

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
    return {
      swapToX: null,
      swapToY: null,
      swapAmountToX: new BN(0),
      swapAmountToY: new BN(0),
      postSwapX: new BN(0),
      postSwapY: new BN(0),
    };
  }

  const initialTokenX = new BN(quoteToX.outAmount);
  const initialTokenY = new BN(quoteToY.outAmount);

  const ratio = calculateValueRatio(
    initialTokenX,
    initialTokenY,
    activeBinPrice
  );

  // return early if initial split is balanced enough
  if (ratio.sub(1).abs().lt(TOLERANCE)) {
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
  if (ratio.gt(1)) {
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

    const xOverYRatio = calculateValueRatio(
      estimatedX,
      estimatedY,
      activeBinPrice
    );

    if (xOverYRatio.sub(1).abs().lt(TOLERANCE)) {
      bestAmountToX = midAmountToX;
      bestAmountToY = midAmountToY;
      break;
    }

    if (xOverYRatio.gt(1)) {
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

/**
 * Calculate optimal swap amount to achieve equal value (1:1 ratio)
 *
 * Balances tokenX and tokenY to achieve equal value by swapping excess of one token to the other
 * using either the DLMM pool or Jupiter
 */
export async function estimateDirectSwap(
  tokenXAmount: BN,
  tokenYAmount: BN,
  dlmm: DLMM,
  swapSlippageBps: number
): Promise<DirectSwapEstimate> {
  const activeBin = await dlmm.getActiveBin();
  const activeBinPrice = new Decimal(activeBin.price);

  // Determine ratio of token values in terms of Y
  const xOverYRatio = calculateValueRatio(
    tokenXAmount,
    tokenYAmount,
    activeBinPrice
  );

  // If already balanced within tolerance, no swap needed
  if (xOverYRatio.sub(1).abs().lt(TOLERANCE)) {
    return {
      swapAmount: new BN(0),
      swapDirection: "noSwap",
      expectedOutput: new BN(0),
      postSwapX: tokenXAmount,
      postSwapY: tokenYAmount,
      quote: null,
    };
  }

  let swapDirection: "xToY" | "yToX";
  let inMint: PublicKey;
  let outMint: PublicKey;

  if (xOverYRatio.gt(1)) {
    // More X than Y, swap X -> Y
    swapDirection = "xToY";
    inMint = dlmm.lbPair.tokenXMint;
    outMint = dlmm.lbPair.tokenYMint;
  } else {
    // More Y than X, swap Y -> X
    swapDirection = "yToX";
    inMint = dlmm.lbPair.tokenYMint;
    outMint = dlmm.lbPair.tokenXMint;
  }

  // Get simple initial estimate using activeBinPrice
  const initialSwapAmount =
    swapDirection === "xToY"
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
      swapDirection: "noSwap",
      expectedOutput: new BN(0),
      postSwapX: tokenXAmount,
      postSwapY: tokenYAmount,
      quote: null,
    };
  }

  const initialQuote = await getBestSwapQuoteJupiterDlmm(
    dlmm,
    inMint,
    outMint,
    initialSwapAmount,
    swapSlippageBps
  );

  if (!initialQuote) {
    // if quote fails, return no swap
    return {
      swapAmount: new BN(0),
      swapDirection: "noSwap",
      expectedOutput: new BN(0),
      postSwapX: tokenXAmount,
      postSwapY: tokenYAmount,
      quote: null,
    };
  }

  // calculate effective rate from initialQuote
  const effectiveRate = new Decimal(initialQuote.outAmount.toString()).div(
    new Decimal(initialQuote.inAmount.toString())
  );

  const postSwapX =
    swapDirection === "xToY"
      ? tokenXAmount.sub(initialSwapAmount) // Spent X
      : tokenXAmount.add(initialQuote.outAmount); // Received X
  const postSwapY =
    swapDirection === "xToY"
      ? tokenYAmount.add(initialQuote.outAmount) // Received Y
      : tokenYAmount.sub(initialSwapAmount); // Spent Y
  const ratio = calculateValueRatio(postSwapX, postSwapY, activeBinPrice);

  // check if initialSwapAmount is good enough
  if (ratio.sub(1).abs().lt(TOLERANCE)) {
    return {
      swapAmount: initialSwapAmount,
      swapDirection,
      expectedOutput: initialQuote.outAmount,
      postSwapX,
      postSwapY,
      quote: initialQuote,
    };
  }

  // binary search refinement
  const refinedAmount =
    swapDirection === "xToY"
      ? binarySearchRefineDirectSwapAmount(
          tokenXAmount,
          tokenYAmount,
          effectiveRate,
          activeBinPrice
        )
      : binarySearchRefineDirectSwapAmount(
          tokenYAmount,
          tokenXAmount,
          effectiveRate,
          activeBinPrice.pow(-1)
        );

  // get final quote for refinedAmount
  const finalQuote = await getBestSwapQuoteJupiterDlmm(
    dlmm,
    inMint,
    outMint,
    refinedAmount,
    swapSlippageBps
  );

  if (!finalQuote) {
    // if quote fails, return initial quote
    return {
      swapAmount: initialSwapAmount,
      swapDirection,
      expectedOutput: initialQuote.outAmount,
      postSwapX,
      postSwapY,
      quote: initialQuote,
    };
  }

  const finalPostSwapX =
    swapDirection === "xToY"
      ? tokenXAmount.sub(refinedAmount) // Spent X
      : tokenXAmount.add(finalQuote.outAmount); // Received X
  const finalPostSwapY =
    swapDirection === "xToY"
      ? tokenYAmount.add(finalQuote.outAmount) // Received Y
      : tokenYAmount.sub(refinedAmount); // Spent Y

  return {
    swapAmount: refinedAmount,
    swapDirection,
    expectedOutput: finalQuote.outAmount,
    postSwapX: finalPostSwapX,
    postSwapY: finalPostSwapY,
    quote: finalQuote,
  };
}
