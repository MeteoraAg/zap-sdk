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
  JupiterQueryParams,
  JupiterAddressLookupTableFields,
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
import { isCreateAtaInstruction } from "./token";

function resolveJupiterConfig(config?: ZapConfig): {
  url: string;
  apiKey: string;
  version: JupiterApiVersion;
} {
  return {
    url: config?.jupiterApiUrl || DEFAULT_JUPITER_API_URL,
    apiKey: config?.jupiterApiKey || "",
    version: config?.jupiterApiVersion ?? DEFAULT_JUPITER_API_VERSION,
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

function isJupiterBuildResponse(
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
function isJupiterSwapInstructionForUser(
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

function toSearchParams(params: GetJupiterQuoteParams): URLSearchParams {
  const searchParams = new URLSearchParams();
  for (const [name, value] of Object.entries(params.queryParams ?? {})) {
    searchParams.set(name, value.toString());
  }
  searchParams.set("inputMint", params.inputMint.toString());
  searchParams.set("outputMint", params.outputMint.toString());
  searchParams.set("amount", params.amount.toString());
  return searchParams;
}

async function fetchJupiterQuoteV1(
  params: GetJupiterQuoteParams,
  config?: ZapConfig,
): Promise<JupiterQuoteResponse | null> {
  const { url: baseUrl, apiKey } = resolveJupiterConfig(config);
  const url = `${baseUrl}/swap/v1/quote?${toSearchParams(params).toString()}`;

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
  params: GetJupiterQuoteParams,
  config?: ZapConfig,
): Promise<JupiterBuildResponse | null> {
  const { url: baseUrl, apiKey } = resolveJupiterConfig(config);
  const searchParams = toSearchParams(params);
  searchParams.set("taker", params.user.toString());
  const url = `${baseUrl}/swap/v2/build?${searchParams.toString()}`;

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
 * `params.queryParams` is forwarded to Jupiter as-is, and Jupiter uses its own default for every
 * parameter not given. A low `maxAccounts` can give a much thinner route than a Jupiter UI quote.
 * `slippageBps` only bounds execution against this quote. It does not mean `outAmount` is a fair
 * price for the input size, so validate the output, price impact or simulated token balance
 * changes before sending.
 * @see https://developers.jup.ag/docs/resources/support#customer-support
 */
export async function getJupiterQuote(
  params: GetJupiterQuoteParams,
  config?: ZapConfig,
): Promise<JupiterQuoteResponse | null> {
  const { version } = resolveJupiterConfig(config);
  if (version === JupiterApiVersion.V1) {
    return fetchJupiterQuoteV1(params, config);
  }
  return fetchJupiterBuildV2(params, config);
}

async function fetchJupiterSwapInstructionV1(
  userPublicKey: PublicKey,
  quoteResponse: JupiterQuoteResponse,
  config?: ZapConfig,
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
  config?: ZapConfig,
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
async function fetchAddressLookupTableAccounts(
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

export function toTransactionInstruction(
  instruction: JupiterInstruction,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: instruction.accounts.map((item) => ({
      pubkey: new PublicKey(item.pubkey),
      isSigner: item.isSigner,
      isWritable: item.isWritable,
    })),
    programId: new PublicKey(instruction.programId),
    data: Buffer.from(instruction.data, "base64"),
  });
}

/**
 * The token account create instructions in Jupiter's `setupInstructions`. A multi-hop route can
 * need user token accounts that the zap does not create, such as one for an intermediate token.
 * Jupiter's other setup instructions wrap SOL and are left out, because the zap wraps SOL itself.
 */
export function getJupiterCreateAtaInstructions(
  setupInstructions: TransactionInstruction[],
): TransactionInstruction[] {
  return setupInstructions.filter(isCreateAtaInstruction);
}

/**
 * Get the Jupiter swap instruction for swapping `amount` of `inputMint` to `outputMint`, and the lookup tables it uses.
 * When `jupiterQuoteResponse` is given it is executed as is, and it must be a quote for `amount` by `user`.
 * Otherwise a new quote is fetched with `slippageBps`, which `jupiterQuoteOptions` can override.
 * `setupInstructions` holds all of Jupiter's setup instructions. Their token account create instructions must run
 * before the swap. The rest wrap SOL, which the zap does itself.
 * Throws when the quote does not match the swap, or when the quote, swap instruction or lookup tables cannot be fetched.
 */
export async function buildJupiterSwapTransaction(
  connection: Connection,
  user: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN,
  slippageBps: number,
  jupiterQuoteResponse?: JupiterQuoteResponse,
  config?: ZapConfig,
  jupiterQuoteOptions?: JupiterQueryParams,
): Promise<{
  instruction: TransactionInstruction;
  setupInstructions: TransactionInstruction[];
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
        queryParams: { slippageBps, ...jupiterQuoteOptions },
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
  const instruction = toTransactionInstruction(
    swapInstructionResponse.swapInstruction,
  );
  const setupInstructions = swapInstructionResponse.setupInstructions.map(
    toTransactionInstruction,
  );

  const addressLookupTableAccounts = await getJupiterAddressLookupTableAccounts(
    connection,
    swapInstructionResponse,
  );

  return {
    instruction,
    setupInstructions,
    addressLookupTableAccounts,
    quoteResponse,
  };
}
