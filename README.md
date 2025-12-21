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

All Jupiter-related functions (`getJupiterQuote`, `getJupiterSwapInstruction`, and estimate functions) support custom API configuration.

### Getting Your Jupiter API Key

As of January 31st 2026, Jupiter requires an API key for all api request to https://api.jup.ag/. Obtain your API key at the [Jupiter Portal](https://portal.jup.ag/)

For detailed setup instructions, see [Jupiter's Setup Guide](https://dev.jup.ag/portal/setup).

### API Parameters

All Jupiter functions accept optional `jupiterApiUrl` and `jupiterApiKey` parameters:

- `jupiterApiUrl` (optional): The Jupiter API endpoint. Default: `"https://api.jup.ag"`
- `jupiterApiKey` (optional): Your Jupiter API key. Default: `""` (empty string)

**Note**: While the API key parameter is optional in the function signature, Jupiter requires an API key for all requests. Using the default empty string may result in API errors.

## Initialization

```typescript
import { Connection } from "@solana/web3.js";
import { Zap } from "@meteora-ag/zap-sdk";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const jupiterApiUrl = "https://api.jup.ag";
const jupiterApiKey = "YOUR_API_KEY_HERE";

const zap = new Zap(connection, jupiterApiUrl, jupiterApiKey);
```

## Usage

Refer to the [docs](./docs.md) for how to use the functions.

### Program Address

- Mainnet-beta: zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz
- Devnet: zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz
