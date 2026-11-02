# Zap SDK: Function Documentation

## Table of Contents

- [Building Transactions](#building-transactions)
- [Zap Functions](#zap-functions)
  - [zapOut](#zapOut)
  - [zapOutThroughDammV2](#zapOutThroughDammV2)
  - [zapOutThroughDlmm](#zapOutThroughDlmm)
  - [zapOutThroughJupiter](#zapOutThroughJupiter)

- [Helper Functions](#helper-functions)
  - [getTokenProgramFromMint](#getTokenProgramFromMint)
  - [getJupiterQuote](#getJupiterQuote)
  - [getJupiterSwapInstruction](#getJupiterSwapInstruction)

---

## Building Transactions

Every Zap method that builds on-chain work returns the same shape, and the client builds the transactions itself, in any format (legacy or v0):

```typescript
type ZapInstructionsResponse = {
  instructions: TransactionInstruction[];
  addressLookupTableAccounts: AddressLookupTableAccount[];
};
```

The methods are `buildZapInDammV2Transaction`, `buildZapInDlmmTransaction`, `rebalanceDlmmPosition` (which also returns `estimation`), `zapOut`, `zapOutThroughJupiter`, `zapOutThroughDammV2` and `zapOutThroughDlmm`.

`instructions` is in execution order:

- Zap in (DAMM v2 and DLMM): token account setup and SOL wrapping, then the swaps, then the ledger instructions, then the zap-in instruction, then closing the ledger and unwrapping SOL.
- `rebalanceDlmmPosition`: token account setup, then bin array initialization, then the position rebalance, then the swap, then the ledger instructions, then the zap-in instruction, then closing the ledger and unwrapping SOL.
- Zap out: token account setup, then the zap-out instruction, then SOL unwrapping.

The instructions must run in that order, but they can be split across several transactions at any point, because the state passed between steps is kept in accounts. Pack them in order and start a new transaction when the next instruction does not fit. When the instructions are split, a later transaction can fail after earlier ones landed (for example, the swap lands but the zap-in fails), so send split transactions as a Jito bundle.

`addressLookupTableAccounts` holds the lookup tables used by the Jupiter swap instructions, each table once, and is empty when no Jupiter swap is involved. Pass it to `compileToV0Message`. With Jupiter API v2 the tables come from the Jupiter response without an RPC call; their `state` fields other than `addresses` are placeholders, so do not rely on `isActive()`. With Jupiter API v1 the SDK fetches the tables with one RPC call.

The returned instructions contain no compute budget instructions, including the ones the DLMM SDK adds to its swaps and rebalances, because the right limit depends on how the instructions are grouped. Set the compute unit limit and price for each transaction yourself, for example by simulating it. The DLMM zap-in instruction of `rebalanceDlmmPosition` was measured at about 462k compute units; without a compute unit limit a transaction gets 200k units per instruction (up to 1.4M), which may not cover it.

#### Example

```typescript
const { instructions, addressLookupTableAccounts } =
  await zap.buildZapInDammV2Transaction(params);

const { blockhash } = await connection.getLatestBlockhash();
const transaction = new VersionedTransaction(
  new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts),
);
transaction.sign([user]);
```

When the instructions do not fit in one transaction, split them in order. `buildV0Transactions` in `examples/helpers.ts` shows one way to do it.

---

## Zap Functions

### zapOut

Executes a generic zap out operation with custom parameters.

#### Function

```typescript
async zapOut(params: ZapOutParams): Promise<ZapInstructionsResponse>
```

#### Parameters

```typescript
interface ZapOutParams {
  userTokenInAccount: PublicKey;
  zapOutParams: ZapOutParameters;
  remainingAccounts: AccountMeta[];
  ammProgram: PublicKey;
  preInstructions: TransactionInstruction[];
  postInstructions: TransactionInstruction[];
}
```

#### Returns

A `ZapInstructionsResponse`: the pre-instructions, the zap out instruction and the post-instructions in order, and an empty `addressLookupTableAccounts`. See [Building Transactions](#building-transactions).

#### Example

```typescript
const preUserTokenBalance = (
  await this.connection.getTokenAccountBalance(userInputMintAta)
).value.amount;

const remainingAccounts = await getDammV2RemainingAccounts(
  this.connection,
  poolAddress,
  user,
  userInputMintAta,
  outputTokenAccountAta,
  inputTokenProgram,
  outputTokenProgram,
);

const payloadData = createDammV2SwapPayload(amountIn, minimumSwapAmountOut);

const transaction = await client.zap.zapOut({
  userTokenInAccount: new PublicKey(
    "userTokenInAccount1234567890abcdefghijklmnopqrstuvwxyz",
  ),
  zapOutParams: {
    percentage: 100,
    offsetAmountIn: AMOUNT_IN_DAMM_V2_OFFSET,
    preUserTokenBalance: preUserTokenBalance,
    maxSwapAmount: new BN(1000000000),
    payloadData: payloadData,
  },
  remainingAccounts: remainingAccounts,
  ammProgram: DAMM_V2_PROGRAM_ID,
});
```

#### Notes

- This is a generic function that can be used to zap out from any AMM program. In this example, we are using zap out of DAMM v2 pool.

---

### zapOutThroughJupiter

Executes a zap out operation through Jupiter Aggregator v6.

#### Function

```typescript
async zapOutThroughJupiter(params: ZapOutThroughJupiterParams): Promise<ZapInstructionsResponse>
```

#### Parameters

```typescript
interface ZapOutThroughJupiterParams {
  user: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  jupiterSwapResponse: Pick<JupiterSwapInstructions, "swapInstruction"> &
    Partial<Pick<JupiterSwapInstructions, "setupInstructions">> &
    JupiterAddressLookupTableFields; // v2 build response or v1 swap-instructions response (deprecated)
  maxSwapAmount: BN;
  percentageToZapOut: number;
}
```

#### Returns

A `ZapInstructionsResponse`: the ordered instructions and the lookup tables of the Jupiter swap. The tables come from `addressesByLookupTableAddress` (v2) or are fetched from `addressLookupTableAddresses` (v1) when the response carries them. See [Building Transactions](#building-transactions).

The instructions create the user's input and output token accounts. When `jupiterSwapResponse` carries `setupInstructions`, they also create the other token accounts Jupiter asks for, such as one for an intermediate token of a multi-hop route. Each token account is created once. Pass the whole Jupiter response so these are included.

#### Example

```typescript
const quoteResponse = await getJupiterQuote(
  {
    inputMint,
    outputMint,
    amount: swapAmount,
    user: wallet.publicKey,
    queryParams: { maxAccounts: 40, slippageBps: 50 },
  },
  {
    jupiterApiUrl: "https://api.jup.ag",
    jupiterApiKey: "YOUR_JUPITER_API_KEY",
  },
);
if (!quoteResponse) {
  throw new Error("Failed to get Jupiter quote");
}

const swapInstructionResponse = await getJupiterSwapInstruction(
  wallet.publicKey,
  quoteResponse,
  {
    jupiterApiUrl: "https://api.jup.ag",
    jupiterApiKey: "YOUR_JUPITER_API_KEY",
  },
);

const inputMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const zapOutTx = await zap.zapOutThroughJupiter({
  user: wallet.publicKey,
  inputMint,
  outputMint,
  inputTokenProgram,
  outputTokenProgram,
  jupiterSwapResponse: swapInstructionResponse,
  maxSwapAmount: new BN(1000000000),
  percentageToZapOut: 100,
});
```

#### Notes

- This function is used to zap out through Jupiter Aggregator v6.
- The flow is as such:
  - Get quote response from Jupiter API
  - Get swap instruction from Jupiter API using quote response
  - Get token programs for input and output mints
  - Build the zap out instructions using the swap instruction
  - Build and send a v0 transaction with the returned lookup tables

---

### zapOutThroughDammV2

Executes a zap out operation through DAMM v2 pool.

#### Function

```typescript
async zapOutThroughDammV2(params: ZapOutThroughDammV2Params): Promise<ZapInstructionsResponse>
```

#### Parameters

```typescript
interface ZapOutThroughDammV2Params {
  user: PublicKey;
  poolAddress: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  amountIn: BN;
  minimumSwapAmountOut: BN;
  maxSwapAmount: BN;
  percentageToZapOut: number;
}
```

#### Returns

A `ZapInstructionsResponse`: the ordered instructions and an empty `addressLookupTableAccounts`. See [Building Transactions](#building-transactions).

#### Example

```typescript
const inputMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const outputMint = new PublicKey("So11111111111111111111111111111111111111112");

const zapOutTx = await zap.zapOutThroughDlmm({
  user: wallet.publicKey,
  poolAddress: new PublicKey("CGPxT5d1uf9a8cKVJuZaJAU76t2EfLGbTmRbfvLLZp5j"),
  inputMint,
  outputMint,
  inputTokenProgram,
  outputTokenProgram,
  amountIn: new BN(1000000000),
  minimumSwapAmountOut: new BN(0),
  maxSwapAmount: new BN(1000000000),
  percentageToZapOut: 100,
});
```

#### Notes

- This function is used to zap out through DAMM v2 pool.
- The flow is as such:
  - Get token programs for input mint
  - Build the zap out instructions
  - Build and send a transaction from them

---

### zapOutThroughDlmm

Executes a zap out operation through DLMM.

#### Function

```typescript
async zapOutThroughDlmm(params: ZapOutThroughDlmmParams): Promise<ZapInstructionsResponse>
```

#### Parameters

```typescript
interface ZapOutThroughDlmmParams {
  user: PublicKey;
  lbPairAddress: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  amountIn: BN;
  minimumSwapAmountOut: BN;
  maxSwapAmount: BN;
  percentageToZapOut: number;
}
```

#### Returns

A `ZapInstructionsResponse`: the ordered instructions and an empty `addressLookupTableAccounts`. See [Building Transactions](#building-transactions).

#### Example

```typescript
const inputMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const outputMint = new PublicKey("So11111111111111111111111111111111111111112");

const zapOutTx = await zap.zapOutThroughDlmm({
  user: wallet.publicKey,
  lbPairAddress: new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"),
  inputMint,
  outputMint,
  inputTokenProgram,
  outputTokenProgram,
  amountIn: new BN(1000000000),
  minimumSwapAmountOut: new BN(0),
  maxSwapAmount: new BN(1000000000),
  percentageToZapOut: 100,
});
```

#### Notes

- This function is used to zap out through DLMM.
- The flow is as such:
  - Get token programs for input mint
  - Build the zap out instructions
  - Build and send a transaction from them

---

## Helper Functions

### getTokenProgramFromMint

Get token program from mint.

#### Function

```typescript
async getTokenProgramFromMint(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey>
```

#### Parameters

```typescript
interface GetTokenProgramFromMintParams {
  connection: Connection;
  mint: PublicKey;
}
```

#### Returns

A token program.

#### Example

```typescript
const tokenProgram = await getTokenProgramFromMint(connection, inputMint);
```

#### Notes

- This function is used to get token program from mint.

---

### getJupiterQuote

Get Jupiter quote from Jupiter API.

#### Function

```typescript
async getJupiterQuote(
  params: GetJupiterQuoteParams,
  config: ZapConfig = {}
): Promise<JupiterQuoteResponse | null>
```

#### Parameters

```typescript
type GetJupiterQuoteParams = {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: BN;
  user: PublicKey; // Wallet the swap is built for. Sent as `taker` under v2, unused under v1.
  queryParams?: Record<string, string | number | boolean>; // Any other Jupiter query parameter, such as slippageBps or maxAccounts
};

type ZapConfig = {
  jupiterApiUrl?: string; // Default: "https://api.jup.ag"
  jupiterApiKey?: string; // Default: ""
  jupiterApiVersion?: JupiterApiVersion; // Default: JupiterApiVersion.V2
};
```

#### Returns

A Jupiter quote response, or `null` when the request fails.

- v2 (default): the `GET /swap/v2/build` response (`JupiterBuildResponse`), which contains the quote fields and the swap instructions built for `user`.
- v1: the `GET /swap/v1/quote` response. (deprecated)

#### Example

```typescript
const quoteResponse = await getJupiterQuote(
  {
    inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
    outputMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    amount: new BN(1000000000),
    user: wallet.publicKey,
    queryParams: { maxAccounts: 40, slippageBps: 50 },
  },
  {
    jupiterApiUrl: "https://api.jup.ag",
    jupiterApiKey: "YOUR_JUPITER_API_KEY",
  },
);
```

#### Notes

- This function is used to get Jupiter quote from Jupiter API.
- Any issues with the api you can check out [Jupiter's Build API Documentation](https://developers.jup.ag/docs/swap/build)
- `queryParams` is forwarded to Jupiter as-is, and nothing else is sent, so Jupiter uses its own default for every parameter not given. Check Jupiter's docs for the parameters each API version accepts. `queryParams` cannot override `inputMint`, `outputMint`, `amount` or `taker`.
- With a low `maxAccounts` (examples use `40` or `50`), the route is **not** the same as a Jupiter UI quote.
- `slippageBps` only covers move within the quoted route. It does **not** mean `outAmount` is a fair market vs input. Validate output / impact / simulated balances before signing. See [Jupiter customer support](https://developers.jup.ag/docs/resources/support#customer-support).
- The zap-in helpers call this helper with their slippage argument as `slippageBps`, plus the Jupiter query parameters in `jupiterQuoteOptions`, which can override it. When `jupiterQuoteOptions` is omitted, they send only `slippageBps`.

---

### getJupiterSwapInstruction

Get Jupiter swap instruction for a quote.

#### Function

```typescript
async getJupiterSwapInstruction(
  userPublicKey: PublicKey,
  quoteResponse: JupiterQuoteResponse,
  config: ZapConfig = {}
): Promise<JupiterSwapInstructions>
```

#### Parameters

```typescript
interface GetJupiterSwapInstructionParams {
  userPublicKey: PublicKey;
  quoteResponse: JupiterQuoteResponse; // From getJupiterQuote
  config?: ZapConfig; // Optional config object containing jupiterApiUrl, jupiterApiKey and jupiterApiVersion
}
```

#### Returns

The swap instructions (`swapInstruction`, `setupInstructions`, `cleanupInstruction`, `addressesByLookupTableAddress`, ...).

- v2 (default): `quoteResponse` must come from `getJupiterQuote` under v2 for the same `userPublicKey`, and it is returned as is without another request, so the executed swap is the quoted one. Otherwise it throws.
- v1: `POST /swap/v1/swap-instructions`.

#### Example

```typescript
const quoteResponse = await getJupiterQuote(
  {
    inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
    outputMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    amount: new BN(1000000000),
    user: wallet.publicKey,
    queryParams: { maxAccounts: 40, slippageBps: 50 },
  },
  {
    jupiterApiUrl: "https://api.jup.ag",
    jupiterApiKey: "YOUR_JUPITER_API_KEY",
  },
);
if (!quoteResponse) {
  throw new Error("Failed to get Jupiter quote");
}

const swapInstructionResponse = await getJupiterSwapInstruction(
  wallet.publicKey,
  quoteResponse,
  {
    jupiterApiUrl: "https://api.jup.ag",
    jupiterApiKey: "YOUR_JUPITER_API_KEY",
  },
);
```

#### Notes

- This function is used to get Jupiter swap instruction from Jupiter API.
- Any issues with the api you can check out [Jupiter's Build API Documentation](https://developers.jup.ag/docs/swap/build)
