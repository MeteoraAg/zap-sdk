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

## [1.1.0] - 2025-12-04

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

## [1.0.4] - 2025-08-14

### Added

- added `dynamicSlippage` parameter to `getJupiterQuote` function
