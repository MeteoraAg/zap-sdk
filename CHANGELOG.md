# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

### Breaking Changes

## [2.0.0] - [PR #33](https://github.com/MeteoraAg/zap-sdk/pull/33)

### Added

- Added `jupiterApiVersion` in `ZapConfig`, using the new enum `JupiterApiVersion`, to choose the Jupiter Swap API version.
- Added the optional `jupiterQuoteOptions` field in `GetZapInDammV2DirectPoolParams`, `GetZapInDammV2IndirectPoolParams`, `GetJupAndDammV2QuotesParams`, `EstimateDlmmDirectSwapParams`, `EstimateDlmmIndirectSwapParams` and `EstimateDlmmRebalanceSwapParams` to set the Jupiter quote options. Omitted options keep the values the SDK used before.
- Added helpers `toAddressLookupTableAccounts`, `fetchAddressLookupTableAccounts`, `getJupiterAddressLookupTableAccounts` and `mergeAddressLookupTableAccounts` for the lookup tables of Jupiter swaps, and `filterOutComputeBudgetInstructions`.
- Added helpers `getJupiterInstructionLayout`, `isJupiterBuildResponse` and `isJupiterSwapInstructionForUser`.

### Changed

- `zapOutThroughJupiter` accepts the optional `addressesByLookupTableAddress` (v2) and `addressLookupTableAddresses` (v1) fields on `jupiterSwapResponse` and returns those lookup tables.
- `zapOutThroughJupiter` accepts `route_v2` and `shared_accounts_route_v2` swap instructions, and throws for a Jupiter instruction it does not support.

### Deprecated

- Deprecated `JupiterApiVersion.V1` in favour of `JupiterApiVersion.V2`. V1 will be removed in a future major version.
- Deprecated the type `JupiterSwapInstructionResponse` in favour of `JupiterSwapInstructions` and `JupiterBuildResponse`.
- Deprecated `AMOUNT_IN_JUP_V6_REVERSE_OFFSET` in favour of `getJupiterInstructionLayout`.

### Removed

- Removed types `ZapInDammV2Response` and `ZapInDlmmResponse`. Use `ZapInstructionsResponse`.

### Breaking Changes

- `buildZapInDammV2Transaction`, `buildZapInDlmmTransaction`, `rebalanceDlmmPosition`, `zapOut`, `zapOutThroughJupiter`, `zapOutThroughDammV2` and `zapOutThroughDlmm` return `ZapInstructionsResponse`, which holds `instructions` in execution order and the `addressLookupTableAccounts` they use. They previously returned legacy `Transaction` objects. `rebalanceDlmmPosition` still returns `estimation`.
- The returned instructions contain no compute budget instructions, so the caller sets the compute unit limit. Previously the transactions carried compute unit limits, including 600,000 units on the `rebalanceDlmmPosition` zap-in transaction.
- `getZapInDammV2DirectPoolParams`, `getZapInDammV2IndirectPoolParams`, `getZapInDlmmDirectParams` and `getZapInDlmmIndirectParams` return `swapInstructions` and `addressLookupTableAccounts` instead of `swapTransactions`.
- `buildJupiterSwapTransaction` takes a `connection` as its first argument and returns `instruction` and `addressLookupTableAccounts` instead of `transaction`.
- The SDK uses Jupiter API v2 (`GET /swap/v2/build`) by default. Previously it used `GET /swap/v1/quote` and `POST /swap/v1/swap-instructions`. Set `jupiterApiVersion` to `JupiterApiVersion.V1` in `ZapConfig` to keep the v1 calls.
- `getJupiterQuote` takes one `GetJupiterQuoteParams` object with a required `user` field. It previously took positional arguments.
- `getJupAndDammV2Quotes` takes one `GetJupAndDammV2QuotesParams` object with a required `user` field. It previously took positional arguments.
- `EstimateDlmmDirectSwapParams`, `EstimateDlmmIndirectSwapParams` and `EstimateDlmmRebalanceSwapParams` require `user`, the wallet the Jupiter swap is built for.
- `getJupiterSwapInstruction` returns `JupiterSwapInstructions` instead of `JupiterSwapInstructionResponse`. Under v2 it makes no request and returns the instructions in the quote, so the quote must come from `getJupiterQuote` for the same user. Previously it always called `POST /swap/v1/swap-instructions`.
- `buildJupiterSwapTransaction` throws when the supplied `jupiterQuoteResponse` has an `inAmount` different from `amount`, or carries swap instructions built for another wallet. Previously it used the supplied quote without a check.
- The fields of `JupiterQuoteResponse` that only v1 returns are optional.
- The SDK depends on `@anchor-lang/core` instead of `@coral-xyz/anchor`, so `ZapProgram` and `Zap.zapProgram` are a `Program` from `@anchor-lang/core`.

## [1.3.2] - [PR #27](https://github.com/MeteoraAg/zap-sdk/pull/32)

- Add `forJitoBundle` in `getJupiterQuote` to exclude AMMs that explicitly block Jito bundles

## [1.3.1] - [PR #27](https://github.com/MeteoraAg/zap-sdk/pull/31)

### Changed

- Support DLMM 0.12.0 by marking `bin_array_bitmap_extension` as writable and bumping `@meteora-ag/dlmm` to `^1.9.8` for updated swap quote math (collect fee mode + limit order).

## [1.3.0] - [PR #27](https://github.com/MeteoraAg/zap-sdk/pull/30)

### Added

- Support Zap-In to damm-V2 Compounding Pool Fee Mode.
- Support Zap-In to single-sided damm-v2 pool. A single-sided pool is a pool that fully contains only one token of the pool pair, either fully token A (`sqrt_price` at `sqrt_min_price`) or fully token B (`sqrt_price` at `sqrt_max_price`).

### Fixed

- Rebalance DLMM position with 1 bin. Reference: https://github.com/MeteoraAg/dlmm-sdk/pull/286

## [1.2.0] - [PR #27](https://github.com/MeteoraAg/zap-sdk/pull/27)

### Added

- Jupiter API Setup section in README with instructions for obtaining API keys and configuring the SDK

### Changed

- Replace `lite-api.jup.ag` with `api.jup.ag` as the default Jupiter API endpoint
- Add optional `config.jupiterApiUrl` and `config.jupiterApiKey` parameters to `Zap` class constructor and all Jupiter-related helper functions (`getJupiterQuote`, `getJupiterSwapInstruction`, `buildJupiterSwapTransaction`, `getJupAndDammV2Quotes`, `estimateDlmmIndirectSwap`, `estimateDlmmDirectSwap`, `estimateDlmmRebalanceSwap`) for explicit API configuration

## [1.1.2] - [PR #26](https://github.com/MeteoraAg/zap-sdk/pull/26)

### Fixed

- Remove unecessary WrapSOL instruction in `rebalanceDlmmPosition` since we already filter out the instruction to close the WSOL account, the SOL will be kept in WSOL form until the end of rebalancing. This unecessary instruction causes the transaction to fail if user has less SOL balance than the calculated SOL after swap.

## [1.1.1] - [PR #24](https://github.com/MeteoraAg/zap-sdk/pull/24)

### Fixed

- Properly handle network errors in `getJupiterQuote` and `getJupiterSwapInstruction`
- Reuse estimate quote in `buildJupiterSwapTransaction` instead of fetching new one where possible, which is all dlmm zap in

## [1.1.0] - [PR #18](https://github.com/MeteoraAg/zap-sdk/pull/18)

### Added

- `getZapInDammV2DirectPoolParams` function. It returns parameters for building a DAMM V2 zap-in transaction through direct route, where the input token matches one of the pool tokens.
- `getZapInDammV2IndirectPoolParams` function. It returns parameters for building a DAMM V2 zap-in transaction through indirect route, where the input token doesn't match either pool token.
- `buildZapInDammV2Transaction` function. It builds the DAMM V2 zap-in transaction by swapping an input token into token a and token b based on the pool ratio and depositing them into the pool.
- `getZapInDlmmDirectParams` function. It returns parameters for building a DLMM zap-in transaction through direct route, where the input token matches one of the pool tokens.
- `getZapInDlmmIndirectParams` function. It returns parameters for building a DLMM zap-in transaction through indirect route, where the input token doesn't match either pool token.
- `buildZapInDlmmTransaction` function. It builds the DLMM zap-in transaction with swap and add liquidity, supporting both balanced (50:50) and single-sided deposits based on configuration.
- `rebalanceDlmmPosition` function. It rebalances an existing DLMM position by withdrawing liquidity, swapping tokens into a balanced ratio, and depositing liquidity back into the position based on the strategy.
- `estimateDlmmDirectSwap` function. It calculates the swap amount for direct route zap-in to achieve balanced token amounts for the position.
- `estimateDlmmIndirectSwap` function. It calculates the swap amounts for indirect route zap-in to achieve balanced token amounts for the position.
- `estimateDlmmRebalanceSwap` function. It calculates the swap amount for position rebalancing to achieve balanced token amounts.

## [1.0.4] - [PR #14](https://github.com/MeteoraAg/zap-sdk/pull/14)

### Added

- added `dynamicSlippage` parameter to `getJupiterQuote` function
