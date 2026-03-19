import { LiteSVM } from "litesvm";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  AccountLayout,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";

import { signAndSendTransaction } from "./svm";

export const TOKEN_DECIMALS = 9;
export const RAW_AMOUNT = 1_000_000_000 * 10 ** TOKEN_DECIMALS;

export function createToken(
  svm: LiteSVM,
  payer: Keypair,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
): PublicKey {
  const mintKeypair = Keypair.generate();
  const rent = svm.getRent();
  const lamports = rent.minimumBalance(BigInt(MINT_SIZE));

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    space: MINT_SIZE,
    lamports: Number(lamports.toString()),
    programId: TOKEN_PROGRAM_ID,
  });

  const initializeMintIx = createInitializeMint2Instruction(
    mintKeypair.publicKey,
    TOKEN_DECIMALS,
    mintAuthority,
    freezeAuthority,
  );

  const transaction = new Transaction();
  transaction.add(createAccountIx, initializeMintIx);
  signAndSendTransaction(svm, transaction, [payer, mintKeypair]);

  return mintKeypair.publicKey;
}

export function mintToken(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  mintAuthority: Keypair,
  toWallet: PublicKey,
  tokenProgram = TOKEN_PROGRAM_ID,
) {
  const destination = getOrCreateAta(svm, payer, mint, toWallet, tokenProgram);

  const mintIx = createMintToInstruction(
    mint,
    destination,
    mintAuthority.publicKey,
    RAW_AMOUNT,
    [],
    tokenProgram,
  );

  const transaction = new Transaction();
  transaction.add(mintIx);
  signAndSendTransaction(svm, transaction, [payer, mintAuthority]);
}

export function getOrCreateAta(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  const ataKey = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);

  const account = svm.getAccount(ataKey);
  if (account === null) {
    const createAtaIx = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ataKey,
      owner,
      mint,
      tokenProgram,
    );
    const transaction = new Transaction();
    transaction.add(createAtaIx);
    signAndSendTransaction(svm, transaction, [payer]);
  }

  return ataKey;
}

export function getTokenBalance(svm: LiteSVM, tokenAccount: PublicKey): BN {
  const account = svm.getAccount(tokenAccount);
  if (!account?.data) {
    return new BN(0);
  }
  return new BN(AccountLayout.decode(account.data).amount.toString());
}

export function getTokenProgram(svm: LiteSVM, tokenMint: PublicKey): PublicKey {
  return svm.getAccount(tokenMint)!.owner;
}
