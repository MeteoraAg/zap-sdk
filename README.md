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

## Initialization

```typescript
import { Connection } from "@solana/web3.js";
import { Zap } from "@meteora-ag/zap-sdk";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const zap = new Zap(connection);
```

## Usage

Refer to the [docs](./docs.md) for how to use the functions.

### Program Address

- Mainnet-beta: zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz
- Devnet: zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz
