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
  outputTokenProgram
);

const payloadData = createDammV2SwapPayload(amountIn, minimumSwapAmountOut);

const transaction = await client.zap.zapOut({
  userTokenInAccount: new PublicKey(
    "userTokenInAccount1234567890abcdefghijklmnopqrstuvwxyz"
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
  jupiterSwapResponse: JupiterSwapInstructionResponse;
  maxSwapAmount: BN;
  percentageToZapOut: number;
}
```

#### Returns

A transaction that can be signed and sent to the network.

#### Example

```typescript
const quoteResponse = await getJupiterQuote(
  inputMint,
  outputMint,
  swapAmount,
  40,
  50,
  true,
  true,
  true,
  "https://lite-api.jup.ag"
);

const swapInstructionResponse = await getJupiterSwapInstruction(
  wallet.publicKey,
  quoteResponse
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
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN,
  maxAccounts: number,
  slippageBps: number,
  onlyDirectRoutes: boolean,
  restrictIntermediateTokens: boolean,
  apiUrl: string = "https://lite-api.jup.ag",
  apiKey?: string
): Promise<JupiterQuoteResponse>
```

#### Parameters

```typescript
interface GetJupiterQuoteParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: BN;
  maxAccounts: number;
  slippageBps: number;
  onlyDirectRoutes: boolean;
  restrictIntermediateTokens: boolean;
  apiUrl: string = "https://lite-api.jup.ag";
  apiKey?: string;
}
```

#### Returns

A Jupiter quote response.

#### Example

```typescript
const quoteResponse = await getJupiterQuote(
  new PublicKey("So11111111111111111111111111111111111111112"),
  new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  new BN(1000000000),
  40,
  50,
  true,
  true,
  true,
  "https://lite-api.jup.ag"
);
```

#### Notes

- This function is used to get Jupiter quote from Jupiter API.
- Any issues with the api you can check out [Jupiter's Quote API Documentation](https://dev.jup.ag/docs/swap-api/get-quote)

---

### getJupiterSwapInstruction

Get Jupiter swap instruction from Jupiter API.

#### Function

```typescript
async getJupiterSwapInstruction(
  userPublicKey: PublicKey,
  quoteResponse: JupiterQuoteResponse,
  apiUrl: string = "https://lite-api.jup.ag",
  apiKey?: string
): Promise<JupiterSwapInstructionResponse>
```

#### Parameters

```typescript
interface GetJupiterSwapInstructionParams {
  inputMint: PublicKey;
  quoteResponse: JupiterQuoteResponse;
  apiUrl: string = "https://lite-api.jup.ag";
  apiKey?: string;
}
```

#### Returns

A Jupiter swap instruction response.

#### Example

```typescript
const quoteResponse = await getJupiterQuote(
  new PublicKey("So11111111111111111111111111111111111111112"),
  new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  new BN(1000000000),
  40,
  50,
  true,
  true,
  true,
  "https://lite-api.jup.ag"
);

const swapInstructionResponse = await getJupiterSwapInstruction(
  wallet.publicKey,
  quoteResponse
  apiUrl: "https://lite-api.jup.ag",
);
```

#### Notes

- This function is used to get Jupiter swap instruction from Jupiter API.
- Any issues with the api you can check out [Jupiter's Swap Instruction API Documentation](https://dev.jup.ag/docs/swap-api/build-swap-transaction#build-your-own-transaction-with-instructions)
