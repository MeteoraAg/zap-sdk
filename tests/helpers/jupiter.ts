import { LiteSVM } from "litesvm";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { derivePoolAuthority } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";

import { DAMM_V2_PROGRAM_ID, JUP_V6_PROGRAM_ID } from "../../src/constants";
import {
  JupiterQuoteResponse,
  JupiterSwapInstructionResponse,
} from "../../src/types";
import { getDammV2Pool } from "./damm_v2";
import { getTokenProgram } from "./token";
import { deriveDammV2EventAuthority } from "../../src/helpers";
import baseQuoteResponse from "../fixtures/jupiterQuoteResponse.json";

export const JUP_ROUTE_DISC = [229, 23, 203, 151, 122, 227, 173, 42];

function deriveJupV6EventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    JUP_V6_PROGRAM_ID,
  )[0];
}

export function getJupRemainingAccounts(
  svm: LiteSVM,
  pool: PublicKey,
  user: PublicKey,
  userTokenInAccount: PublicKey,
  userTokenOutAccount: PublicKey,
  outputMint: PublicKey,
  tokenAProgram = TOKEN_PROGRAM_ID,
  tokenBProgram = TOKEN_PROGRAM_ID,
): Array<{
  isSigner: boolean;
  isWritable: boolean;
  pubkey: PublicKey;
}> {
  const poolState = getDammV2Pool(svm, pool);

  return [
    // Jupiter accounts
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
    // DAMM V2 swap accounts
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
}

const METEORA_DAMM_V2_ROUTE_ENUM = 77;

function encodeJupRouteData(inAmount: BN): Buffer {
  const routePlanStep = Buffer.from([
    METEORA_DAMM_V2_ROUTE_ENUM,
    100, // percent
    0, // inputIndex
    1, // outputIndex
  ]);

  const buf = Buffer.alloc(8 + 4 + routePlanStep.length + 19);
  let offset = 0;
  new BN(JUP_ROUTE_DISC, "le").toBuffer("le", 8).copy(buf, offset);
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

function buildJupiterSwapInstructionResponse(
  svm: LiteSVM,
  swapPool: PublicKey,
  user: PublicKey,
  inputTokenMint: PublicKey,
  inAmount: BN,
): JupiterSwapInstructionResponse {
  const poolState = getDammV2Pool(svm, swapPool);
  const outputTokenMint = poolState.tokenAMint.equals(inputTokenMint)
    ? poolState.tokenBMint
    : poolState.tokenAMint;

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

  const accounts: AccountMeta[] = getJupRemainingAccounts(
    svm,
    swapPool,
    user,
    userTokenIn,
    userTokenOut,
    outputTokenMint,
  );

  const data = encodeJupRouteData(inAmount);

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
  outAmount: BN;
};

export function mockJupiterFetch(
  svm: LiteSVM,
  user: PublicKey,
  inputTokenMint: PublicKey,
  routes: JupiterMockRoute[],
): { mock: typeof fetch; restore: () => void } {
  const originalFetch = global.fetch;

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
        route.outAmount,
      );
      return new Response(JSON.stringify(quote), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/swap/v1/swap-instructions")) {
      const body = JSON.parse((init?.body as string) || "{}");
      const inAmount = new BN(body.quoteResponse?.inAmount || "0");
      const outputMintStr = body.quoteResponse?.outputMint;
      const route = findRoute(outputMintStr);
      const swapResponse = buildJupiterSwapInstructionResponse(
        svm,
        route.swapPool,
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
