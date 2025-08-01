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
import { deriveTokenLedgerAddress } from "../src/helpers/pda";
import { Zap } from "../src/zap";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

  const inputMintTokenLedgerAccount = deriveTokenLedgerAddress(inputMint);

  const swapAmount = new BN(1000000);

  try {
    await setupTokenLedger(
      connection,
      zap,
      wallet,
      inputMint,
      inputMintTokenLedgerAccount,
      swapAmount
    );

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

    // const swapInstructions = new TransactionInstruction({
    //   keys: swapInstructionResponse.swapInstruction.accounts.map((account) => {
    //     return {
    //       pubkey: new PublicKey(account.pubkey),
    //       isSigner: account.isSigner,
    //       isWritable: account.isWritable,
    //     };
    //   }),
    //   programId: new PublicKey(
    //     swapInstructionResponse.swapInstruction.programId
    //   ),
    //   data: Buffer.from(swapInstructionResponse.swapInstruction.data, "base64"),
    // });
    // const tx1 = new Transaction()
    //   .add(...setupInstructions)
    //   .add(swapInstructions);
    // tx1.recentBlockhash = blockhash;
    // tx1.feePayer = wallet.publicKey;
    // tx1.sign(wallet);

    // const sig = await connection.sendRawTransaction(tx1.serialize());
    // console.log(sig);

    //  const simulate1 = await connection.simulateTransaction(tx1);
    // console.log(simulate1.value.logs);
    // console.log(simulate1.value.err);

    // return;

    // const swapResponse: any = await (
    //   await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    //     method: "POST",
    //     headers: {
    //       "Content-Type": "application/json",
    //     },
    //     body: JSON.stringify({
    //       quoteResponse,
    //       userPublicKey: wallet.publicKey,

    //       dynamicComputeUnitLimit: true,
    //       dynamicSlippage: true,
    //       prioritizationFeeLamports: {
    //         priorityLevelWithMaxLamports: {
    //           maxLamports: 1000000,
    //           priorityLevel: "veryHigh",
    //         },
    //       },
    //     }),
    //   })
    // ).json();

    // const tx1 = VersionedTransaction.deserialize(
    //   Buffer.from(swapResponse.swapTransaction, "base64")
    // );
    // tx1.sign([wallet]);
    // const sig = await connection.sendRawTransaction(
    //   tx1.serialize()
    // );
    // console.log(sig);
    // const simulate1 = await connection.simulateTransaction(tx1);
    // console.log(simulate1.value.logs);
    // console.log(simulate1.value.err);

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

    const transaction = new Transaction();
    const warpIx = wrapSOLInstruction(
      wallet.publicKey,
      inputMintTokenLedgerAccount,
      BigInt(swapAmount.toString())
    );

    const zapOutTx = await zap.zapOutThroughJupiter({
      user: wallet.publicKey,
      inputMint,
      outputMint,
      inputTokenAccount: inputMintTokenLedgerAccount,
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

/**
 * Setup and fund token ledger if needed
 */
async function setupTokenLedger(
  connection: Connection,
  zap: Zap,
  wallet: Keypair,
  inputMint: PublicKey,
  inputTokenAccount: PublicKey,
  requiredAmount: BN
): Promise<void> {
  console.log("Checking token ledger account...");
  const tokenLedgerInfo = await connection.getAccountInfo(inputTokenAccount);

  if (!tokenLedgerInfo) {
    console.log("Token ledger not found, initializing...");
    const inputTokenProgram = await getTokenProgramFromMint(
      connection,
      inputMint
    );
    const initTx = await zap.initializeTokenLedger(
      wallet.publicKey,
      inputMint,
      inputTokenProgram
    );

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    initTx.recentBlockhash = blockhash;
    initTx.feePayer = wallet.publicKey;

    const initSignature = await sendAndConfirmTransaction(
      connection,
      initTx,
      [wallet],
      { commitment: "confirmed" }
    );

    console.log(`Token ledger initialized: ${initSignature}`);
  } else {
    console.log("Token ledger already exists");
  }

  const tokenLedgerBalance = await connection.getBalance(inputTokenAccount);
  console.log(`Token ledger balance: ${tokenLedgerBalance} lamports`);

  if (
    tokenLedgerBalance === 0 ||
    new BN(tokenLedgerBalance).lt(requiredAmount)
  ) {
    console.log(
      `Funding token ledger with ${requiredAmount.toString()} lamports...`
    );

    const fundTx = new Transaction();
    fundTx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: inputTokenAccount,
        lamports: requiredAmount.toNumber(),
      })
    );

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    fundTx.recentBlockhash = blockhash;
    fundTx.feePayer = wallet.publicKey;

    const fundSignature = await sendAndConfirmTransaction(
      connection,
      fundTx,
      [wallet],
      { commitment: "confirmed" }
    );

    console.log(`Token ledger funded: ${fundSignature}`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const updatedBalance = await connection.getBalance(inputTokenAccount);
    console.log(`Updated balance: ${updatedBalance} lamports`);
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
