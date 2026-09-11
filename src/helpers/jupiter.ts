import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  GetJupiterQuoteParams,
  JupiterApiVersion,
  JupiterBuildResponse,
  JupiterInstruction,
  JupiterInstructionLayout,
  JupiterQuoteResponse,
  JupiterSwapInstructionResponse,
  JupiterSwapInstructions,
  ZapConfig,
} from "../types";
import {
  DEFAULT_JUPITER_API_URL,
  DEFAULT_JUPITER_API_VERSION,
  JUPITER_INSTRUCTION_LAYOUTS,
} from "../constants";

export function resolveJupiterConfig(config: ZapConfig = {}): {
  url: string;
  apiKey: string;
  version: JupiterApiVersion;
} {
  return {
    url: config.jupiterApiUrl || DEFAULT_JUPITER_API_URL,
    apiKey: config.jupiterApiKey || "",
    version: config.jupiterApiVersion ?? DEFAULT_JUPITER_API_VERSION,
  };
}

export function getJupiterInstructionLayout(
  data: Buffer,
): JupiterInstructionLayout {
  const discriminator = data.subarray(0, 8).toString("hex");
  const layout = JUPITER_INSTRUCTION_LAYOUTS[discriminator];
  if (!layout) {
    throw new Error(
      `Unsupported Jupiter instruction discriminator ${discriminator}`,
    );
  }
  return layout;
}

export function isJupiterBuildResponse(
  quoteResponse: JupiterQuoteResponse,
): quoteResponse is JupiterBuildResponse {
  return (
    (quoteResponse as Partial<JupiterBuildResponse>).swapInstruction !==
    undefined
  );
}

/**
 * Whether the swap instruction was built for `user`, i.e. `user` is its user transfer authority.
 * Throws for an unknown Jupiter instruction discriminator.
 */
export function isJupiterSwapInstructionForUser(
  swapInstruction: JupiterInstruction,
  user: PublicKey,
): boolean {
  const layout = getJupiterInstructionLayout(
    Buffer.from(swapInstruction.data, "base64"),
  );
  const authority = swapInstruction.accounts[layout.userTransferAuthorityIndex];
  return (
    authority !== undefined && new PublicKey(authority.pubkey).equals(user)
  );
}

function jupiterHeaders(apiKey: string, json: boolean): Record<string, string> {
  return {
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
}

type JupiterQuoteQuery = {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: string;
  slippageBps: number;
  maxAccounts?: number;
  dynamicSlippage: boolean;
  onlyDirectRoutes: boolean;
  restrictIntermediateTokens: boolean;
  forJitoBundle: boolean;
};

function toSearchParams(query: JupiterQuoteQuery): URLSearchParams {
  return new URLSearchParams({
    inputMint: query.inputMint.toString(),
    outputMint: query.outputMint.toString(),
    amount: query.amount,
    slippageBps: query.slippageBps.toString(),
    ...(query.maxAccounts !== undefined
      ? { maxAccounts: query.maxAccounts.toString() }
      : {}),
    onlyDirectRoutes: query.onlyDirectRoutes.toString(),
    restrictIntermediateTokens: query.restrictIntermediateTokens.toString(),
    dynamicSlippage: query.dynamicSlippage.toString(),
    forJitoBundle: query.forJitoBundle.toString(),
  });
}

async function fetchJupiterQuoteV1(
  query: JupiterQuoteQuery,
  config: ZapConfig,
): Promise<JupiterQuoteResponse | null> {
  const { url: baseUrl, apiKey } = resolveJupiterConfig(config);
  const url = `${baseUrl}/swap/v1/quote?${toSearchParams(query).toString()}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: jupiterHeaders(apiKey, false),
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as JupiterQuoteResponse;
  } catch (error) {
    return null;
  }
}

async function fetchJupiterBuildV2(
  query: JupiterQuoteQuery,
  taker: PublicKey,
  config: ZapConfig,
): Promise<JupiterBuildResponse | null> {
  const { url: baseUrl, apiKey } = resolveJupiterConfig(config);
  const params = toSearchParams(query);
  params.set("taker", taker.toString());
  const url = `${baseUrl}/swap/v2/build?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: jupiterHeaders(apiKey, false),
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as JupiterBuildResponse;
  } catch (error) {
    return null;
  }
}

/**
 * Get a Jupiter quote.
 * - v1: `GET /swap/v1/quote`, returns the quote only.
 * - v2: `GET /swap/v2/build`, returns the quote together with the swap instructions built for `params.user`
 *   (a `JupiterBuildResponse`), so no second request is needed for the swap.
 * Returns null when the request fails.
 */
export async function getJupiterQuote(
  params: GetJupiterQuoteParams,
  config: ZapConfig = {},
): Promise<JupiterQuoteResponse | null> {
  const query: JupiterQuoteQuery = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: params.slippageBps,
    maxAccounts: params.maxAccounts,
    dynamicSlippage: params.dynamicSlippage ?? false,
    onlyDirectRoutes: params.onlyDirectRoutes ?? true,
    restrictIntermediateTokens: params.restrictIntermediateTokens ?? true,
    forJitoBundle: params.forJitoBundle ?? true,
  };

  const { version } = resolveJupiterConfig(config);
  if (version === JupiterApiVersion.V1) {
    return fetchJupiterQuoteV1(query, config);
  }
  return fetchJupiterBuildV2(query, params.user, config);
}

async function fetchJupiterSwapInstructionV1(
  userPublicKey: PublicKey,
  quoteResponse: JupiterQuoteResponse,
  config: ZapConfig,
): Promise<JupiterSwapInstructionResponse> {
  const { url: baseUrl, apiKey } = resolveJupiterConfig(config);
  const url = `${baseUrl}/swap/v1/swap-instructions`;

  const requestBody = {
    userPublicKey: userPublicKey.toString(),
    quoteResponse,
  };

  let response = null;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: jupiterHeaders(apiKey, true),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Jupiter swap instruction failed (${response.status}): ${errorText}`,
      );
    }
  } catch (error) {
    throw new Error(`Jupiter swap instruction failed to fetch`);
  }

  return (await response.json()) as JupiterSwapInstructionResponse;
}

/**
 * Get the Jupiter swap instructions for a quote.
 * - v1: `POST /swap/v1/swap-instructions`.
 * - v2: returns `quoteResponse` as is when it already carries swap instructions built for `userPublicKey`;
 *   otherwise calls `GET /swap/v2/build` once for the quote's mints, amount and slippage.
 * Throws when the request fails.
 */
export async function getJupiterSwapInstruction(
  userPublicKey: PublicKey,
  quoteResponse: JupiterQuoteResponse,
  config: ZapConfig = {},
): Promise<JupiterSwapInstructions> {
  const { version } = resolveJupiterConfig(config);
  if (version === JupiterApiVersion.V1) {
    return fetchJupiterSwapInstructionV1(userPublicKey, quoteResponse, config);
  }

  if (
    isJupiterBuildResponse(quoteResponse) &&
    isJupiterSwapInstructionForUser(
      quoteResponse.swapInstruction,
      userPublicKey,
    )
  ) {
    return quoteResponse;
  }

  const buildResponse = await fetchJupiterBuildV2(
    {
      inputMint: new PublicKey(quoteResponse.inputMint),
      outputMint: new PublicKey(quoteResponse.outputMint),
      amount: quoteResponse.inAmount,
      slippageBps: quoteResponse.slippageBps,
      dynamicSlippage: false,
      onlyDirectRoutes: true,
      restrictIntermediateTokens: true,
      forJitoBundle: true,
    },
    userPublicKey,
    config,
  );
  if (!buildResponse) {
    throw new Error(`Jupiter swap instruction failed to fetch`);
  }
  return buildResponse;
}

/**
 * Whether `quoteResponse` can be reused for a swap of `amount` by `user` without a new request:
 * the quoted amount must match and, when it carries instructions, they must be built for `user`.
 */
function canReuseQuote(
  quoteResponse: JupiterQuoteResponse,
  user: PublicKey,
  amount: BN,
): boolean {
  if (quoteResponse.inAmount !== amount.toString()) {
    return false;
  }
  if (isJupiterBuildResponse(quoteResponse)) {
    return isJupiterSwapInstructionForUser(quoteResponse.swapInstruction, user);
  }
  return true;
}

export async function buildJupiterSwapTransaction(
  user: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN,
  maxAccounts: number,
  slippageBps: number,
  jupiterQuoteResponse?: JupiterQuoteResponse,
  config: ZapConfig = {},
): Promise<{
  transaction: Transaction;
  quoteResponse: JupiterQuoteResponse;
}> {
  const quoteResponse =
    jupiterQuoteResponse && canReuseQuote(jupiterQuoteResponse, user, amount)
      ? jupiterQuoteResponse
      : await getJupiterQuote(
          {
            inputMint,
            outputMint,
            amount,
            user,
            maxAccounts,
            slippageBps,
          },
          config,
        );

  if (!quoteResponse) {
    throw new Error(
      `Failed to get Jupiter quote for swap from ${inputMint.toBase58()} to ${outputMint.toBase58()}`,
    );
  }

  const swapInstructionResponse = await getJupiterSwapInstruction(
    user,
    quoteResponse,
    config,
  );
  const instruction = new TransactionInstruction({
    keys: swapInstructionResponse.swapInstruction.accounts.map((item) => {
      return {
        pubkey: new PublicKey(item.pubkey),
        isSigner: item.isSigner,
        isWritable: item.isWritable,
      };
    }),
    programId: new PublicKey(swapInstructionResponse.swapInstruction.programId),
    data: Buffer.from(swapInstructionResponse.swapInstruction.data, "base64"),
  });

  return { transaction: new Transaction().add(instruction), quoteResponse };
}
