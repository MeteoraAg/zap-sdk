# Meteora Zap SDK

A Typescript SDK for interacting with the Zap program on Meteora.

## Overview

This SDK provides a set of tools and methods to interact with the Zap Program on Meteora. It enables developers to easily zap out of their positions on different AMMs on Solana.

## Installation

```bash
npm install @meteora-ag/zap-sdk
# or
pnpm install @meteora-ag/zap-sdk
# or
yarn add @meteora-ag/zap-sdk
```

## Jupiter API Setup

All Jupiter-related functions (`getJupiterQuote`, `getJupiterSwapInstruction`, `getJupAndDammV2Quotes`, and the DLMM estimate functions) support custom API configuration.

### API Version

The SDK uses Jupiter Swap API v2 (`GET /swap/v2/build`) by default. v1 api support is deprecated in this SDK.

### Getting Your Jupiter API Key

As of January 31st 2026, Jupiter requires an API key for all api request to https://api.jup.ag/. Obtain your API key at the [Jupiter Portal](https://portal.jup.ag/)

For detailed setup instructions, see [Jupiter's Setup Guide](https://dev.jup.ag/portal/setup).

### API Parameters

All Jupiter functions accept an optional `config: ZapConfig`:

- `jupiterApiUrl` (optional): The Jupiter API endpoint. Default: `"https://api.jup.ag"`
- `jupiterApiKey` (optional): Your Jupiter API key. Default: `""` (empty string)
- `jupiterApiVersion` (optional): `JupiterApiVersion.V2` (default) or `JupiterApiVersion.V1` (deprecated)

**Note**: While the API key parameter is optional in the function signature, Jupiter requires an API key for all requests. Using the default empty string may result in API errors.

## Initialization

```typescript
import { Connection } from "@solana/web3.js";
import { Zap } from "@meteora-ag/zap-sdk";

const connection = new Connection("https://api.mainnet-beta.solana.com");

const zap = new Zap(connection, {
  jupiterApiUrl: "https://api.jup.ag",
  jupiterApiKey: "YOUR_API_KEY_HERE",
  // jupiterApiVersion: JupiterApiVersion.V1, // deprecated, defaults to V2 if unset
});
```

## Usage

Refer to the [docs](./docs.md) for how to use the functions.

### Program Address

- Mainnet-beta: zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz
- Devnet: zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz

## License

This SDK is released under the [MIT License](./LICENSE).

The on-chain Zap program is licensed separately and is not covered by this MIT license.
