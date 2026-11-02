import { DEFAULT_JUPITER_API_URL } from "../src";

export const JUPITER_API_URL =
  process.env.JUPITER_API_URL || DEFAULT_JUPITER_API_URL;
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
export const RPC_URL =
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
