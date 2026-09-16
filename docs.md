# Zap SDK: Function Documentation

## Table of Contents

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

## Zap Functions

### zapOut

Executes a generic zap out operation with custom parameters.

#### Function

```typescript
async zapOut(params: ZapOutParams): Promise<Transaction>
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

A transaction that can be signed and sent to the network.

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
async zapOutThroughJupiter(params: ZapOutThroughJupiterParams): Promise<Transaction>
```

#### Parameters

```typescript
interface ZapOutThroughJupiterParams {
  user: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  jupiterSwapResponse: Pick<JupiterSwapInstructions, "swapInstruction">; // v2 build response or v1 swap-instructions response (deprecated)
  maxSwapAmount: BN;
  percentageToZapOut: number;
}
```

#### Returns

A transaction that can be signed and sent to the network.

#### Example

```typescript
const quoteResponse = await getJupiterQuote(
  {
    inputMint,
    outputMint,
    amount: swapAmount,
    user: wallet.publicKey,
    maxAccounts: 40,
    slippageBps: 50,
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
  - Build zap transaction using the swap instruction
  - Send zap transaction

---

### zapOutThroughDammV2

Executes a zap out operation through DAMM v2 pool.

#### Function

```typescript
async zapOutThroughDammV2(params: ZapOutThroughDammV2Params): Promise<Transaction>
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

A transaction that can be signed and sent to the network.

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
  - Build zap transaction
  - Send zap transaction

---

### zapOutThroughDlmm

Executes a zap out operation through DLMM.

#### Function

```typescript
async zapOutThroughDlmm(params: ZapOutThroughDlmmParams): Promise<Transaction>
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

A transaction that can be signed and sent to the network.

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
  - Build zap transaction
  - Send zap transaction

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
  maxAccounts: number;
  slippageBps: number;
  dynamicSlippage?: boolean; // Default: false
  onlyDirectRoutes?: boolean; // Default: true
  restrictIntermediateTokens?: boolean; // Default: true
  forJitoBundle?: boolean; // Default: true
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
    maxAccounts: 40,
    slippageBps: 50,
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

- v2 (default): when `quoteResponse` came from `getJupiterQuote` under v2 for the same `userPublicKey`, it is returned as is without another request. Otherwise one `GET /swap/v2/build` request is made.
- v1: `POST /swap/v1/swap-instructions`.

#### Example

```typescript
const quoteResponse = await getJupiterQuote(
  {
    inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
    outputMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    amount: new BN(1000000000),
    user: wallet.publicKey,
    maxAccounts: 40,
    slippageBps: 50,
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
