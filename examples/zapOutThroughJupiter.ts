import {
  Connection,
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Zap } from "../src/zap";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { JupiterQuoteResponse, JupiterSwapInstructionResponse } from "../src";

async function main() {
  const connection = new Connection("https://api.mainnet-beta.solana.com");

  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(require("/Users/minhdo/.config/solana/id.json"))
  );
  console.log(`Using wallet: ${wallet.publicKey.toString()}`);

  const zap = new Zap(connection);

  const inputMint = new PublicKey(
    "So11111111111111111111111111111111111111112"
  );
  const outputMint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );


  const swapAmount = new BN(1000000);

  try {

    console.log("\n1. Getting quote from Jupiter API...");
    const quoteResponse = await getJupiterQuote(
      inputMint,
      outputMint,
      swapAmount
    );

    console.log("2. Getting swap instruction from Jupiter API...");
    const swapInstructionResponse = await getJupiterSwapInstruction(
      wallet.publicKey,
      quoteResponse
    );
    // console.log(swapInstructionResponse);
    const setupInstructions = swapInstructionResponse.setupInstructions.map(
      (item) =>
        new TransactionInstruction({
          keys: item.accounts.map((account) => {
            return {
              pubkey: new PublicKey(account.pubkey),
              isSigner: account.isSigner,
              isWritable: account.isWritable,
            };
          }),
          programId: new PublicKey(item.programId),
          data: Buffer.from(item.data, "base64"),
        })
    );
    const { blockhash } = await connection.getLatestBlockhash();

    // Get token programs for input and output mints
    console.log("3. Getting token programs...");
    const outputTokenProgram = await getTokenProgramFromMint(
      connection,
      outputMint
    );

    const inputTokenProgram = await getTokenProgramFromMint(
      connection,
      inputMint
    );

    const inputTokenAccount = getAssociatedTokenAddressSync(inputMint, wallet.publicKey, true, inputTokenProgram)

    const transaction = new Transaction();
    const warpIx = wrapSOLInstruction(
      wallet.publicKey,
      inputTokenAccount,
      BigInt(swapAmount.toString())
    );

    const zapOutTx = await zap.zapOutThroughJupiter({
      user: wallet.publicKey,
      inputMint,
      outputMint,
      inputTokenAccount,
      jupiterSwapResponse: swapInstructionResponse,
      outputTokenProgram: outputTokenProgram,
      inputTokenProgram: inputTokenProgram
    });

    transaction.add(...warpIx).add(zapOutTx);

    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    const simulate = await connection.simulateTransaction(transaction);
    console.log(simulate.value.logs);
    console.log(simulate.value.err);

    // const signature = await sendAndConfirmTransaction(
    //   connection,
    //   zapOutTx,
    //   [wallet],
    //   { commitment: "confirmed" }
    // );

    // console.log(`Zap out transaction sent: ${signature}`);
  } catch (error) {
    console.error(error);
  }
}

export const wrapSOLInstruction = (
  from: PublicKey,
  to: PublicKey,
  amount: bigint
): TransactionInstruction[] => {
  return [
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports: amount,
    }),
    new TransactionInstruction({
      keys: [
        {
          pubkey: to,
          isSigner: false,
          isWritable: true,
        },
      ],
      data: Buffer.from(new Uint8Array([17])),
      programId: TOKEN_PROGRAM_ID,
    }),
  ];
};

async function getTokenProgramFromMint(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  try {
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) {
      throw new Error(`Mint account not found: ${mint.toString()}`);
    }

    if (
      mintInfo.owner.equals(
        new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
      )
    ) {
      return new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    } else {
      return TOKEN_PROGRAM_ID;
    }
  } catch (error) {
    console.warn(
      `Failed to determine token program for ${mint.toString()}, defaulting to TOKEN_PROGRAM_ID:`,
      error
    );
    return TOKEN_PROGRAM_ID;
  }
}

async function getJupiterQuote(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN
): Promise<JupiterQuoteResponse> {
  const params = new URLSearchParams({
    inputMint: inputMint.toString(),
    outputMint: outputMint.toString(),
    amount: amount.toString(),
    slippageBps: "50",
  });

  const url = `https://lite-api.jup.ag/swap/v1/quote?${params.toString()}`;

  console.log(url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jupiter quote failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as JupiterQuoteResponse;

  return result;
}

async function getJupiterSwapInstruction(
  userPublicKey: PublicKey,
  quoteResponse: any
): Promise<JupiterSwapInstructionResponse> {
  const url = "https://lite-api.jup.ag/swap/v1/swap-instructions";

  const requestBody = {
    userPublicKey: userPublicKey.toString(),
    quoteResponse,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
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

main().catch(console.error);
