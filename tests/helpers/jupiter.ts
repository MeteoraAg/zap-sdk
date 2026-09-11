import { LiteSVM } from "litesvm";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { derivePoolAuthority } from "@meteora-ag/cp-amm-sdk";
import DLMM, { deriveEventAuthority, deriveOracle } from "@meteora-ag/dlmm";
import BN from "bn.js";

import {
  AMOUNT_IN_JUP_V6_REVERSE_OFFSET,
  DAMM_V2_PROGRAM_ID,
  DLMM_PROGRAM_ID,
  JUP_V6_PROGRAM_ID,
  JUP_V6_ROUTE_DISCRIMINATOR,
  JUP_V6_ROUTE_V2_DISCRIMINATOR,
} from "../../src/constants";
import {
  JupiterApiVersion,
  JupiterBuildResponse,
  JupiterQuoteResponse,
  JupiterSwapInstructionResponse,
} from "../../src/types";
import { getDammV2Pool } from "./damm_v2";
import { getLbPair } from "./dlmm";
import { createLiteSvmConnection } from "./svm";
import { getTokenProgram } from "./token";
import { deriveDammV2EventAuthority } from "../../src/helpers";
import baseQuoteResponse from "../fixtures/jupiterQuoteResponse.json";

// Which swap instruction each Jupiter API version returns and where amount_in sits in its data.
// The offsets are spelled out here on purpose so tests pin the layout independently of
// JUPITER_INSTRUCTION_LAYOUTS in src/constants.ts.
export const JUPITER_API_VERSION_CASES: {
  version: JupiterApiVersion;
  discriminator: number[];
  amountInOffset: (dataLength: number) => number;
}[] = [
  {
    version: JupiterApiVersion.V1,
    discriminator: JUP_V6_ROUTE_DISCRIMINATOR,
    amountInOffset: (dataLength) => dataLength - 19,
  },
  {
    version: JupiterApiVersion.V2,
    discriminator: JUP_V6_ROUTE_V2_DISCRIMINATOR,
    amountInOffset: () => 8,
  },
];

function deriveJupV6EventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    JUP_V6_PROGRAM_ID,
  )[0];
}

// A single-hop Jupiter route leg: the `Swap` enum index used in the route plan and the
// accounts Jupiter forwards to the AMM (AMM program id first).
export type JupiterSwapLeg = {
  swapEnum: number;
  accounts: AccountMeta[];
};

export type JupiterSwapPoolType = "dammV2" | "dlmm";

const METEORA_DAMM_V2_ROUTE_ENUM = 77;
const METEORA_DLMM_ROUTE_ENUM = 38;

export async function getJupiterSwapLeg(
  poolType: JupiterSwapPoolType,
  svm: LiteSVM,
  pool: PublicKey,
  user: PublicKey,
  userTokenInAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  inputMint: PublicKey,
): Promise<JupiterSwapLeg> {
  switch (poolType) {
    case "dammV2":
      return getDammV2SwapLeg(
        svm,
        pool,
        user,
        userTokenInAccount,
        userTokenOutAccount,
      );
    case "dlmm":
      return await getDlmmSwapLeg(
        svm,
        pool,
        user,
        userTokenInAccount,
        userTokenOutAccount,
        inputMint,
      );
  }
}

// Accounts of Jupiter's `route` instruction followed by the swap leg.
export function getJupRemainingAccounts(
  user: PublicKey,
  userTokenInAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  outputMint: PublicKey,
  leg: JupiterSwapLeg,
): AccountMeta[] {
  return [
    // Jupiter route accounts
    {
      isSigner: false,
      isWritable: false,
      pubkey: TOKEN_PROGRAM_ID,
    },
    {
      pubkey: user,
      isSigner: true,
      isWritable: false,
    },
    {
      pubkey: userTokenInAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: userTokenOutAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: JUP_V6_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: outputMint,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: JUP_V6_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: deriveJupV6EventAuthority(),
    },
    {
      isSigner: false,
      isWritable: false,
      pubkey: JUP_V6_PROGRAM_ID,
    },
    ...leg.accounts,
  ];
}

// Accounts of Jupiter's `route_v2` instruction followed by the swap leg.
export function getJupRouteV2RemainingAccounts(
  user: PublicKey,
  userTokenInAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  inputTokenProgram: PublicKey,
  outputTokenProgram: PublicKey,
  leg: JupiterSwapLeg,
): AccountMeta[] {
  return [
    // Jupiter route_v2 accounts
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: userTokenInAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenOutAccount, isSigner: false, isWritable: true },
    { pubkey: inputMint, isSigner: false, isWritable: false },
    { pubkey: outputMint, isSigner: false, isWritable: false },
    { pubkey: inputTokenProgram, isSigner: false, isWritable: false },
    { pubkey: outputTokenProgram, isSigner: false, isWritable: false },
    // optional destination_token_account, None is encoded as the program id
    { pubkey: JUP_V6_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: deriveJupV6EventAuthority(), isSigner: false, isWritable: false },
    { pubkey: JUP_V6_PROGRAM_ID, isSigner: false, isWritable: false },
    ...leg.accounts,
  ];
}

export function getDammV2SwapLeg(
  svm: LiteSVM,
  pool: PublicKey,
  user: PublicKey,
  userTokenInAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  tokenAProgram = TOKEN_PROGRAM_ID,
  tokenBProgram = TOKEN_PROGRAM_ID,
): JupiterSwapLeg {
  const poolState = getDammV2Pool(svm, pool);

  const accounts: AccountMeta[] = [
    {
      pubkey: DAMM_V2_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: derivePoolAuthority(),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: pool,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: userTokenInAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: userTokenOutAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: poolState.tokenAVault,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: poolState.tokenBVault,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: poolState.tokenAMint,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: poolState.tokenBMint,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: user,
      isSigner: true,
      isWritable: false,
    },
    {
      pubkey: tokenAProgram,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: tokenBProgram,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: DAMM_V2_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
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

  return { swapEnum: METEORA_DAMM_V2_ROUTE_ENUM, accounts };
}

// DLMM `swap` accounts as Jupiter forwards them, followed by the bin arrays the swap crosses.
// Optional accounts that are absent (bitmap extension, host fee) are encoded as the DLMM program id.
export async function getDlmmSwapLeg(
  svm: LiteSVM,
  lbPair: PublicKey,
  user: PublicKey,
  userTokenInAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  inputMint: PublicKey,
): Promise<JupiterSwapLeg> {
  const lbPairState = getLbPair(svm, lbPair);
  const swapForY = lbPairState.tokenXMint.equals(inputMint);

  const dlmm = await DLMM.create(createLiteSvmConnection(svm), lbPair, {
    cluster: "mainnet-beta",
    programId: DLMM_PROGRAM_ID,
  });
  const binArrays = await dlmm.getBinArrayForSwap(swapForY);

  const [oracle] = deriveOracle(lbPair, DLMM_PROGRAM_ID);
  const [eventAuthority] = deriveEventAuthority(DLMM_PROGRAM_ID);

  const accounts: AccountMeta[] = [
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: lbPair, isSigner: false, isWritable: true },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: lbPairState.reserveX, isSigner: false, isWritable: true },
    { pubkey: lbPairState.reserveY, isSigner: false, isWritable: true },
    { pubkey: userTokenInAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenOutAccount, isSigner: false, isWritable: true },
    { pubkey: lbPairState.tokenXMint, isSigner: false, isWritable: false },
    { pubkey: lbPairState.tokenYMint, isSigner: false, isWritable: false },
    { pubkey: oracle, isSigner: false, isWritable: true },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ...binArrays.map((binArray) => ({
      pubkey: binArray.publicKey,
      isSigner: false,
      isWritable: true,
    })),
  ];

  return { swapEnum: METEORA_DLMM_ROUTE_ENUM, accounts };
}

export function encodeJupRouteData(inAmount: BN, swapEnum: number): Buffer {
  const routePlanStep = Buffer.from([
    swapEnum,
    100, // percent
    0, // inputIndex
    1, // outputIndex
  ]);

  const buf = Buffer.alloc(
    8 + 4 + routePlanStep.length + AMOUNT_IN_JUP_V6_REVERSE_OFFSET,
  );
  let offset = 0;
  Buffer.from(JUP_V6_ROUTE_DISCRIMINATOR).copy(buf, offset);
  offset += 8;
  buf.writeUInt32LE(1, offset); // route count
  offset += 4;
  routePlanStep.copy(buf, offset);
  offset += routePlanStep.length;
  inAmount.toBuffer("le", 8).copy(buf, offset);
  offset += 8;
  new BN(0).toBuffer("le", 8).copy(buf, offset); // quotedOutAmount
  offset += 8;
  buf.writeUInt16LE(0, offset); // slippageBps
  offset += 2;
  buf.writeUInt8(0, offset); // platformFee
  return buf;
}

// route_v2: in_amount, quoted_out_amount, slippage_bps, platform_fee_bps, positive_slippage_bps, route_plan
function encodeJupRouteV2Data(inAmount: BN, swapEnum: number): Buffer {
  const routePlanStep = Buffer.alloc(5);
  routePlanStep.writeUInt8(swapEnum, 0);
  routePlanStep.writeUInt16LE(10000, 1); // bps
  routePlanStep.writeUInt8(0, 3); // inputIndex
  routePlanStep.writeUInt8(1, 4); // outputIndex

  return Buffer.concat([
    Buffer.from(JUP_V6_ROUTE_V2_DISCRIMINATOR),
    inAmount.toArrayLike(Buffer, "le", 8),
    new BN(0).toArrayLike(Buffer, "le", 8), // quotedOutAmount
    new BN(0).toArrayLike(Buffer, "le", 2), // slippageBps
    new BN(0).toArrayLike(Buffer, "le", 2), // platformFeeBps
    new BN(0).toArrayLike(Buffer, "le", 2), // positiveSlippageBps
    new BN(1).toArrayLike(Buffer, "le", 4), // route plan length
    routePlanStep,
  ]);
}

// Mock of `GET /swap/v2/build`: quote fields plus a route_v2 swap instruction through the pool.
export async function buildJupiterBuildResponse(
  svm: LiteSVM,
  route: JupiterMockRoute,
  taker: PublicKey,
  inputTokenMint: PublicKey,
  inAmount: BN,
  outAmount: BN,
): Promise<JupiterBuildResponse> {
  const outputTokenMint = route.outputMint;

  const inputTokenProgram = getTokenProgram(svm, inputTokenMint);
  const outputTokenProgram = getTokenProgram(svm, outputTokenMint);

  const userTokenIn = getAssociatedTokenAddressSync(
    inputTokenMint,
    taker,
    true,
    inputTokenProgram,
  );
  const userTokenOut = getAssociatedTokenAddressSync(
    outputTokenMint,
    taker,
    true,
    outputTokenProgram,
  );

  const leg = await getJupiterSwapLeg(
    route.poolType ?? "dammV2",
    svm,
    route.swapPool,
    taker,
    userTokenIn,
    userTokenOut,
    inputTokenMint,
  );
  const accounts = getJupRouteV2RemainingAccounts(
    taker,
    userTokenIn,
    userTokenOut,
    inputTokenMint,
    outputTokenMint,
    inputTokenProgram,
    outputTokenProgram,
    leg,
  );

  return {
    inputMint: inputTokenMint.toBase58(),
    outputMint: outputTokenMint.toBase58(),
    inAmount: inAmount.toString(),
    outAmount: outAmount.toString(),
    otherAmountThreshold: "0",
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: "0",
    routePlan: [],
    computeBudgetInstructions: [],
    setupInstructions: [],
    swapInstruction: {
      programId: JUP_V6_PROGRAM_ID.toBase58(),
      accounts: accounts.map((a) => ({
        pubkey: a.pubkey.toBase58(),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: encodeJupRouteV2Data(inAmount, leg.swapEnum).toString("base64"),
    },
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: null,
    blockhashWithMetadata: {
      blockhash: [],
      lastValidBlockHeight: 0,
      fetchedAt: { secs_since_epoch: 0, nanos_since_epoch: 0 },
    },
  };
}

export function buildJupiterQuoteResponse(
  inputMint: PublicKey,
  outputMint: PublicKey,
  inAmount: BN,
  outAmount: BN,
): JupiterQuoteResponse {
  return {
    ...baseQuoteResponse,
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    inAmount: inAmount.toString(),
    outAmount: outAmount.toString(),
  } as JupiterQuoteResponse;
}

async function buildJupiterSwapInstructionResponse(
  svm: LiteSVM,
  route: JupiterMockRoute,
  user: PublicKey,
  inputTokenMint: PublicKey,
  inAmount: BN,
): Promise<JupiterSwapInstructionResponse> {
  const outputTokenMint = route.outputMint;

  const inputTokenProgram = getTokenProgram(svm, inputTokenMint);
  const outputTokenProgram = getTokenProgram(svm, outputTokenMint);

  const userTokenIn = getAssociatedTokenAddressSync(
    inputTokenMint,
    user,
    true,
    inputTokenProgram,
  );
  const userTokenOut = getAssociatedTokenAddressSync(
    outputTokenMint,
    user,
    true,
    outputTokenProgram,
  );

  const leg = await getJupiterSwapLeg(
    route.poolType ?? "dammV2",
    svm,
    route.swapPool,
    user,
    userTokenIn,
    userTokenOut,
    inputTokenMint,
  );
  const accounts = getJupRemainingAccounts(
    user,
    userTokenIn,
    userTokenOut,
    outputTokenMint,
    leg,
  );

  const data = encodeJupRouteData(inAmount, leg.swapEnum);

  return {
    tokenLedgerInstruction: null,
    computeBudgetInstructions: [],
    setupInstructions: [],
    swapInstruction: {
      programId: JUP_V6_PROGRAM_ID.toBase58(),
      accounts: accounts.map((a) => ({
        pubkey: a.pubkey.toBase58(),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: Buffer.from(data).toString("base64"),
    },
    cleanupInstruction: {
      programId: JUP_V6_PROGRAM_ID.toBase58(),
      accounts: [],
      data: "",
    },
    otherInstructions: [],
    addressLookupTableAddresses: [],
    prioritizationFeeLamports: 0,
    computeUnitLimit: 0,
    prioritizationType: {
      computeBudget: { microLamports: 0, estimatedMicroLamports: 0 },
    },
    simulationSlot: null,
    dynamicSlippageReport: null,
    simulationError: null,
    addressesByLookupTableAddress: null,
    blockhashWithMetadata: {
      blockhash: [],
      lastValidBlockHeight: 0,
      fetchedAt: { secs_since_epoch: 0, nanos_since_epoch: 0 },
    },
  };
}

export type JupiterMockRoute = {
  outputMint: PublicKey;
  swapPool: PublicKey;
  // Quoted output, either fixed or computed from the requested input amount.
  outAmount: BN | ((inAmount: BN) => BN);
  // Defaults to "dammV2".
  poolType?: JupiterSwapPoolType;
};

export function mockJupiterFetch(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  routes: JupiterMockRoute[],
): { mock: typeof fetch; restore: () => void } {
  const originalFetch = global.fetch;

  const getOutAmount = (route: JupiterMockRoute, inAmount: BN): BN =>
    typeof route.outAmount === "function"
      ? route.outAmount(inAmount)
      : route.outAmount;

  const findRoute = (outputMint: string): JupiterMockRoute => {
    const route = routes.find((r) => r.outputMint.toBase58() === outputMint);
    if (!route) {
      throw new Error(`No mock Jupiter route for outputMint ${outputMint}`);
    }
    return route;
  };

  const mock = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input.toString();

    if (url.includes("/swap/v1/quote")) {
      const urlObj = new URL(url);
      const inAmount = new BN(urlObj.searchParams.get("amount") || "0");
      const outputMintStr = urlObj.searchParams.get("outputMint")!;
      const route = findRoute(outputMintStr);
      const quote = buildJupiterQuoteResponse(
        inputTokenMint,
        route.outputMint,
        inAmount,
        getOutAmount(route, inAmount),
      );
      return new Response(JSON.stringify(quote), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/swap/v2/build")) {
      const urlObj = new URL(url);
      const inAmount = new BN(urlObj.searchParams.get("amount") || "0");
      const taker = new PublicKey(urlObj.searchParams.get("taker")!);
      const route = findRoute(urlObj.searchParams.get("outputMint")!);
      const buildResponse = await buildJupiterBuildResponse(
        svm,
        route,
        taker,
        inputTokenMint,
        inAmount,
        getOutAmount(route, inAmount),
      );
      return new Response(JSON.stringify(buildResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/swap/v1/swap-instructions")) {
      const body = JSON.parse((init?.body as string) || "{}");
      const inAmount = new BN(body.quoteResponse?.inAmount || "0");
      const outputMintStr = body.quoteResponse?.outputMint;
      const route = findRoute(outputMintStr);
      const swapResponse = await buildJupiterSwapInstructionResponse(
        svm,
        route,
        user,
        inputTokenMint,
        inAmount,
      );
      return new Response(JSON.stringify(swapResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return originalFetch(input, init as any);
  };

  global.fetch = mock as typeof fetch;

  return {
    mock: mock as typeof fetch,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}
