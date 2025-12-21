import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  JupiterInstruction,
  JupiterQuoteResponse,
  JupiterSwapInstructionResponse,
} from "../types";

export async function getJupiterQuote(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN,
  maxAccounts: number,
  slippageBps: number,
  dynamicSlippage: boolean = false,
  onlyDirectRoutes: boolean,
  restrictIntermediateTokens: boolean,
  jupiterApiUrl: string = "https://api.jup.ag",
  jupiterApiKey: string = ""
): Promise<JupiterQuoteResponse | null> {
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

  const url = `${jupiterApiUrl}/swap/v1/quote?${params.toString()}`;

  let response = null;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
    });

    if (!response.ok) {
      // const errorText = await response.text();
      // throw new Error(`Jupiter quote failed (${response.status}): ${errorText}`);
      return null;
    }
  } catch (error) {
    return null;
  }

  const result = (await response.json()) as JupiterQuoteResponse;

  return result;
}

export async function getJupiterSwapInstruction(
  userPublicKey: PublicKey,
  quoteResponse: any,
  jupiterApiUrl: string = "https://api.jup.ag",
  jupiterApiKey: string = ""
): Promise<JupiterSwapInstructionResponse> {
  const url = `${jupiterApiUrl}/swap/v1/swap-instructions`;

  const requestBody = {
    userPublicKey: userPublicKey.toString(),
    quoteResponse,
  };

  let response = null;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Jupiter swap instruction failed (${response.status}): ${errorText}`
      );
    }
  } catch (error) {
    throw new Error(`Jupiter swap instruction failed to fetch`);
  }

  const result = (await response.json()) as JupiterSwapInstructionResponse;

  return result;
}

export async function buildJupiterSwapTransaction(
  user: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN,
  maxAccounts: number,
  slippageBps: number,
  jupiterQuoteResponse?: JupiterQuoteResponse,
  jupiterApiUrl: string = "https://api.jup.ag",
  jupiterApiKey: string = ""
): Promise<{
  transaction: Transaction;
  quoteResponse: JupiterQuoteResponse;
}> {
  const quoteResponse =
    jupiterQuoteResponse ??
    (await getJupiterQuote(
      inputMint,
      outputMint,
      amount,
      maxAccounts,
      slippageBps,
      false,
      true,
      true,
      jupiterApiUrl,
      jupiterApiKey
    ));

  if (!quoteResponse) {
    throw new Error(
      `Failed to get Jupiter quote for swap from ${inputMint.toBase58()} to ${outputMint.toBase58()}`
    );
  }

  const swapInstructionResponse = await getJupiterSwapInstruction(
    user,
    quoteResponse,
    jupiterApiUrl,
    jupiterApiKey
  );
  const instruction = new TransactionInstruction({
    keys: swapInstructionResponse.swapInstruction.accounts.map((item) => {
      return {
        pubkey: new PublicKey(item.pubkey),
        isSigner: item.isSigner,
        isWritable: item.isWritable,
      };
    }),
    programId: new PublicKey(swapInstructionResponse.swapInstruction.programId),
    data: Buffer.from(swapInstructionResponse.swapInstruction.data, "base64"),
  });

  return { transaction: new Transaction().add(instruction), quoteResponse };
}
