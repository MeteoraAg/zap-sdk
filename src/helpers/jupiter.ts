import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  GetJupiterQuoteParams,
  JupiterAddressLookupTableFields,
  JupiterApiVersion,
  JupiterBuildResponse,
  JupiterInstruction,
  JupiterInstructionLayout,
  JupiterQuoteOptions,
  JupiterQuoteResponse,
  JupiterSwapInstructionResponse,
  JupiterSwapInstructions,
  ZapConfig,
} from "../types";
import {
  DEFAULT_JUPITER_API_URL,
  DEFAULT_JUPITER_API_VERSION,
  DEFAULT_JUPITER_QUOTE_OPTIONS,
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
  additionalQueryParams?: Record<string, string>;
};

function toSearchParams(query: JupiterQuoteQuery): URLSearchParams {
  const params = new URLSearchParams({
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
  for (const [name, value] of Object.entries(
    query.additionalQueryParams ?? {},
  )) {
    params.set(name, value);
  }
  return params;
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
 *
 * `maxAccounts` and the options in `JupiterQuoteOptions` are forwarded to Jupiter as-is. They can
 * give a much thinner route than a Jupiter UI quote, because the UI does not set them.
 * `slippageBps` only bounds execution against this quote. It does not mean `outAmount` is a fair
 * price for the input size, so validate the output, price impact or simulated token balance
 * changes before sending.
 * @see https://developers.jup.ag/docs/resources/support#customer-support
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
    dynamicSlippage:
      params.dynamicSlippage ?? DEFAULT_JUPITER_QUOTE_OPTIONS.dynamicSlippage,
    onlyDirectRoutes:
      params.onlyDirectRoutes ?? DEFAULT_JUPITER_QUOTE_OPTIONS.onlyDirectRoutes,
    restrictIntermediateTokens:
      params.restrictIntermediateTokens ??
      DEFAULT_JUPITER_QUOTE_OPTIONS.restrictIntermediateTokens,
    forJitoBundle:
      params.forJitoBundle ?? DEFAULT_JUPITER_QUOTE_OPTIONS.forJitoBundle,
    additionalQueryParams: params.additionalQueryParams,
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
 * - v2: returns `quoteResponse` as is. It must be a `GET /swap/v2/build` response built for `userPublicKey`,
 *   so the executed swap is the quoted one.
 * Throws when the request fails, or under v2 when `quoteResponse` has no swap instructions built for `userPublicKey`.
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

  if (!isJupiterBuildResponse(quoteResponse)) {
    throw new Error(
      "Jupiter quote has no swap instructions, get the quote with getJupiterQuote under Jupiter API v2",
    );
  }
  if (
    !isJupiterSwapInstructionForUser(
      quoteResponse.swapInstruction,
      userPublicKey,
    )
  ) {
    throw new Error(
      `Jupiter quote swap instructions are not built for ${userPublicKey.toBase58()}`,
    );
  }
  return quoteResponse;
}

/**
 * Whether `quoteResponse` is a quote for a swap of `amount` by `user`:
 * the quoted amount must match and, when it carries instructions, they must be built for `user`.
 */
function isQuoteMatchesSwap(
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

const ACTIVE_LOOKUP_TABLE_DEACTIVATION_SLOT = BigInt("0xffffffffffffffff");

/**
 * Build lookup table accounts from Jupiter v2's `addressesByLookupTableAddress` without an RPC call.
 * Only `key` and `state.addresses` are real. The other state fields are placeholders, because
 * `compileToV0Message` does not read them, so `isActive()` on the result does not reflect the chain.
 */
export function toAddressLookupTableAccounts(
  addressesByLookupTableAddress: Record<string, string[]> | null,
): AddressLookupTableAccount[] {
  return Object.entries(addressesByLookupTableAddress ?? {}).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          addresses: addresses.map((address) => new PublicKey(address)),
          deactivationSlot: ACTIVE_LOOKUP_TABLE_DEACTIVATION_SLOT,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
        },
      }),
  );
}

/**
 * Fetch lookup table accounts by address with one RPC call. Used for Jupiter v1, which returns
 * only `addressLookupTableAddresses`.
 * Throws when a table does not exist or is not owned by the address lookup table program.
 */
export async function fetchAddressLookupTableAccounts(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) {
    return [];
  }

  const keys = addresses.map((address) => new PublicKey(address));
  const accounts = await connection.getMultipleAccountsInfo(keys);

  return keys.map((key, i) => {
    const account = accounts[i];
    if (
      !account ||
      !account.owner.equals(AddressLookupTableProgram.programId)
    ) {
      throw new Error(`Address lookup table not found: ${key.toBase58()}`);
    }
    return new AddressLookupTableAccount({
      key,
      state: AddressLookupTableAccount.deserialize(account.data),
    });
  });
}

/** Merge lookup table lists, keeping the first occurrence of each table key. */
export function mergeAddressLookupTableAccounts(
  ...lists: AddressLookupTableAccount[][]
): AddressLookupTableAccount[] {
  const merged = new Map<string, AddressLookupTableAccount>();
  for (const table of lists.flat()) {
    const key = table.key.toBase58();
    if (!merged.has(key)) {
      merged.set(key, table);
    }
  }
  return [...merged.values()];
}

/**
 * Resolve the lookup tables a Jupiter swap instruction needs.
 * - v2 (`addressesByLookupTableAddress`): built from the response, no RPC call.
 * - v1 (`addressLookupTableAddresses` only): fetched with one RPC call.
 * Returns an empty array when the response carries neither.
 */
export async function getJupiterAddressLookupTableAccounts(
  connection: Connection,
  response: JupiterAddressLookupTableFields,
): Promise<AddressLookupTableAccount[]> {
  if (response.addressesByLookupTableAddress) {
    return toAddressLookupTableAccounts(response.addressesByLookupTableAddress);
  }
  return fetchAddressLookupTableAccounts(
    connection,
    response.addressLookupTableAddresses ?? [],
  );
}

/**
 * Get the Jupiter swap instruction for swapping `amount` of `inputMint` to `outputMint`, and the lookup tables it uses.
 * When `jupiterQuoteResponse` is given it is executed as is, and it must be a quote for `amount` by `user`.
 * Otherwise a new quote is fetched with `maxAccounts`, `slippageBps` and `jupiterQuoteOptions`.
 * Throws when the quote does not match the swap, or when the quote, swap instruction or lookup tables cannot be fetched.
 */
export async function buildJupiterSwapTransaction(
  connection: Connection,
  user: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN,
  maxAccounts: number,
  slippageBps: number,
  jupiterQuoteResponse?: JupiterQuoteResponse,
  config: ZapConfig = {},
  jupiterQuoteOptions: JupiterQuoteOptions = {},
): Promise<{
  instruction: TransactionInstruction;
  addressLookupTableAccounts: AddressLookupTableAccount[];
  quoteResponse: JupiterQuoteResponse;
}> {
  if (
    jupiterQuoteResponse &&
    !isQuoteMatchesSwap(jupiterQuoteResponse, user, amount)
  ) {
    throw new Error(
      `Jupiter quote does not match the swap of ${amount.toString()} by ${user.toBase58()} (quoted inAmount ${jupiterQuoteResponse.inAmount})`,
    );
  }

  const quoteResponse =
    jupiterQuoteResponse ??
    (await getJupiterQuote(
      {
        inputMint,
        outputMint,
        amount,
        user,
        maxAccounts,
        slippageBps,
        ...jupiterQuoteOptions,
      },
      config,
    ));

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

  const addressLookupTableAccounts = await getJupiterAddressLookupTableAccounts(
    connection,
    swapInstructionResponse,
  );

  return { instruction, addressLookupTableAccounts, quoteResponse };
}
