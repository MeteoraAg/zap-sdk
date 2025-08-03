import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { JupiterQuoteResponse, JupiterSwapInstructionResponse } from "../types";

export async function getJupiterQuote(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN,
  maxAccounts: number,
  slippageBps: number,
  dynamicSlippage: boolean,
  onlyDirectRoutes: boolean,
  restrictIntermediateTokens: boolean,
  apiUrl: string = "https://lite-api.jup.ag",
  apiKey?: string
): Promise<JupiterQuoteResponse> {
  const params = new URLSearchParams({
    inputMint: inputMint.toString(),
    outputMint: outputMint.toString(),
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
    maxAccounts: maxAccounts.toString(),
    onlyDirectRoutes: onlyDirectRoutes.toString(),
    restrictIntermediateTokens: restrictIntermediateTokens.toString(),
    dynamicSlippage: dynamicSlippage.toString(),
  });

  const url = `${apiUrl}/swap/v1/quote?${params.toString()}`;

  console.log(url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jupiter quote failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as JupiterQuoteResponse;

  return result;
}

export async function getJupiterSwapInstruction(
  userPublicKey: PublicKey,
  quoteResponse: any,
  apiUrl: string = "https://lite-api.jup.ag",
  apiKey?: string
): Promise<JupiterSwapInstructionResponse> {
  const url = `${apiUrl}/swap/v1/swap-instructions`;

  const requestBody = {
    userPublicKey: userPublicKey.toString(),
    quoteResponse,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Jupiter swap instruction failed (${response.status}): ${errorText}`
    );
  }

  const result = (await response.json()) as JupiterSwapInstructionResponse;

  return result;
}
