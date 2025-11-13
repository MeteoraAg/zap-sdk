import DLMM, { BinLiquidity } from "@meteora-ag/dlmm";
import { JupiterQuoteResponse, SwapEstimate, SwapQuoteResult } from "../types";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";

const TOLERANCE = new Decimal(0.0001); // 0.01%

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
  slippage: number
): Promise<SwapQuoteResult | null> {
  try {
    const swapForY = dlmm.lbPair.tokenXMint.equals(inMint);
    const binArrays = await dlmm.getBinArrayForSwap(swapForY);
    const quotation = dlmm.swapQuote(
      inAmount,
      swapForY,
      new BN(slippage * 100),
      binArrays
    );

    return {
      inAmount: quotation.consumedInAmount,
      outAmount: quotation.outAmount,
      minOutAmount: quotation.minOutAmount,
      route: "dlmm",
      originalQuote: quotation,
    };
  } catch (error) {
    console.error("DLMM swap quote failed:", error);
    return null;
  }
}

// TODO: use the existing jupiter quote function
async function getJupiterSwapQuote(
  inMint: string,
  outMint: string,
  inAmount: BN,
  inTokenDecimals: number,
  slippage: number
): Promise<SwapQuoteResult | null> {
  try {
    const params = new URLSearchParams({
      inputMint: inMint,
      outputMint: outMint,
      amount: inAmount.toString(),
      slippageBps: (slippage * 100).toString(),
      maxAccounts: "50",
      onlyDirectRoutes: "true",
      restrictIntermediateTokens: "true",
    });

    const response = await fetch(
      `https://lite-api.jup.ag/swap/v1/quote?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      }
    );

    const data = (await response.json()) as JupiterQuoteResponse;

    if ("error" in data || !data.inAmount || !data.outAmount) {
      return null;
    }

    return {
      inAmount: new BN(data.inAmount),
      outAmount: new BN(data.outAmount),
      minOutAmount: new BN(data.outAmount), // Jupiter already includes slippage
      route: "jupiter",
      originalQuote: data,
    };
  } catch (error) {
    console.error("Jupiter swap quote failed:", error);
    return null;
  }
}

async function getBestSwapQuoteJupiterDlmm(
  dlmm: DLMM,
  inMint: PublicKey,
  outMint: PublicKey,
  inAmount: BN,
  inTokenDecimals: number,
  slippage: number
): Promise<SwapQuoteResult | null> {
  const [dlmmQuote, jupiterQuote] = await Promise.all([
    getDlmmSwapQuote(dlmm, inMint, inAmount, slippage),
    getJupiterSwapQuote(
      inMint.toBase58(),
      outMint.toBase58(),
      inAmount,
      inTokenDecimals,
      slippage
    ),
  ]);

  // Choose the quote with better output
  if (!dlmmQuote && !jupiterQuote) return null;
  if (!dlmmQuote) return jupiterQuote;
  if (!jupiterQuote) return dlmmQuote;

  // Compare minimum output amounts
  return dlmmQuote.minOutAmount.gt(jupiterQuote.minOutAmount)
    ? dlmmQuote
    : jupiterQuote;
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

function binarySearchRefineSwapAmount(
  tokenXAmount: BN,
  tokenYAmount: BN,
  fixedRate: Decimal,
  marketPrice: Decimal
): BN {
  const MAX_ITERATIONS = 20;

  let left = new BN(0);
  let right = tokenXAmount;
  let best = left.add(right).div(new BN(2));

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const mid = left.add(right).div(new BN(2));

    // Stop if search space is too small (down to ~1000 lamports)
    if (right.sub(left).lte(new BN(1000))) {
      best = mid;
      break;
    }

    // Estimate output
    const estimatedOutput = estimateSwapOutput(mid, fixedRate);

    // Calculate ratio: valueX / valueY
    const postSwapX = tokenXAmount.sub(mid);
    const postSwapY = tokenYAmount.add(estimatedOutput);
    const valueX = new Decimal(postSwapX.toString()).mul(marketPrice);
    const valueY = new Decimal(postSwapY.toString());
    const ratio = valueX.div(valueY);

    // Stop if within tolerance
    if (ratio.sub(1).abs().lt(TOLERANCE)) {
      console.log(
        `✓ Converged in ${i + 1} iterations (ratio: ${ratio.toFixed(6)})`
      );
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
 * Calculate optimal swap amount to achieve equal value (1:1 ratio)
 */
export async function estimateBalancedSwap(
  tokenXAmount: BN,
  tokenYAmount: BN,
  dlmm: DLMM,
  activeBin: BinLiquidity,
  swapSlippage: number
): Promise<SwapEstimate> {
  const activeBinPrice = new Decimal(activeBin.price);

  // Determine ratio of token values in terms of Y
  const valueX = new Decimal(tokenXAmount.toString()).mul(activeBinPrice);
  const valueY = new Decimal(tokenYAmount.toString());

  let xOverYRatio: Decimal;
  if (valueY.isZero()) {
    // All X, need to swap to Y
    xOverYRatio = new Decimal(Infinity);
  } else if (valueX.isZero()) {
    // All Y, need to swap to X
    xOverYRatio = new Decimal(0);
  } else {
    xOverYRatio = valueX.div(valueY);
  }

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
  let inTokenDecimals: number;

  if (xOverYRatio.gt(1)) {
    // More X than Y, swap X -> Y
    swapDirection = "xToY";
    inMint = dlmm.lbPair.tokenXMint;
    outMint = dlmm.lbPair.tokenYMint;
    inTokenDecimals = dlmm.tokenX.mint.decimals;
  } else {
    // More Y than X, swap Y -> X
    swapDirection = "yToX";
    inMint = dlmm.lbPair.tokenYMint;
    outMint = dlmm.lbPair.tokenXMint;
    inTokenDecimals = dlmm.tokenY.mint.decimals;
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
    inTokenDecimals,
    swapSlippage
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
  const effectiveRate = new Decimal(initialQuote.minOutAmount.toString()).div(
    new Decimal(initialQuote.inAmount.toString())
  );

  const postSwapX =
    swapDirection === "xToY"
      ? tokenXAmount.sub(initialSwapAmount) // Spent X
      : tokenXAmount.add(initialQuote.minOutAmount); // Received X
  const postSwapY =
    swapDirection === "xToY"
      ? tokenYAmount.add(initialQuote.minOutAmount) // Received Y
      : tokenYAmount.sub(initialSwapAmount); // Spent Y
  const testValueX = new Decimal(postSwapX.toString()).mul(activeBinPrice);
  const testValueY = new Decimal(postSwapY.toString());
  const ratio = testValueX.div(testValueY);

  // check if initialSwapAmount is good enough
  if (ratio.sub(1).abs().lt(TOLERANCE)) {
    return {
      swapAmount: initialSwapAmount,
      swapDirection,
      expectedOutput: initialQuote.minOutAmount,
      postSwapX,
      postSwapY,
      quote: initialQuote,
    };
  }

  // binary search refinement
  const refinedAmount =
    swapDirection === "xToY"
      ? binarySearchRefineSwapAmount(
          tokenXAmount,
          tokenYAmount,
          effectiveRate,
          activeBinPrice
        )
      : binarySearchRefineSwapAmount(
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
    inTokenDecimals,
    swapSlippage
  );

  if (!finalQuote) {
    // if quote fails, return initial quote
    return {
      swapAmount: initialSwapAmount,
      swapDirection,
      expectedOutput: initialQuote.minOutAmount,
      postSwapX,
      postSwapY,
      quote: initialQuote,
    };
  }

  const finalPostSwapX =
    swapDirection === "xToY"
      ? tokenXAmount.sub(refinedAmount) // Spent X
      : tokenXAmount.add(finalQuote.minOutAmount); // Received X
  const finalPostSwapY =
    swapDirection === "xToY"
      ? tokenYAmount.add(finalQuote.minOutAmount) // Received Y
      : tokenYAmount.sub(refinedAmount); // Spent Y

  return {
    swapAmount: refinedAmount,
    swapDirection,
    expectedOutput: finalQuote.minOutAmount,
    postSwapX: finalPostSwapX,
    postSwapY: finalPostSwapY,
    quote: finalQuote,
  };
}
