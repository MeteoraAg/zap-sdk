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
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { lamports } from "@solana/kit";
import { BN } from "@anchor-lang/core";

import { getAccount, signAndSendTransaction, toAddress } from "./svm";

export const TOKEN_DECIMALS = 9;
const RAW_AMOUNT = BigInt(1_000_000_000) * BigInt(10 ** TOKEN_DECIMALS);

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

  const account = getAccount(svm, ataKey);
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
  const account = getAccount(svm, tokenAccount);
  if (!account?.data) {
    return new BN(0);
  }
  return new BN(AccountLayout.decode(account.data).amount.toString());
}

export function getTokenProgram(svm: LiteSVM, tokenMint: PublicKey): PublicKey {
  return getAccount(svm, tokenMint)!.owner;
}

// LiteSVM starts without the wrapped SOL mint, so write it in the layout the token program expects.
export function createNativeMint(svm: LiteSVM): void {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: BigInt(0),
      decimals: 9,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  svm.setAccount({
    address: toAddress(NATIVE_MINT),
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
    programAddress: toAddress(TOKEN_PROGRAM_ID),
    space: BigInt(MINT_SIZE),
  });
}

export function wrapSol(svm: LiteSVM, owner: Keypair, amount: bigint): void {
  const wrapSolAccount = getOrCreateAta(
    svm,
    owner,
    NATIVE_MINT,
    owner.publicKey,
    TOKEN_PROGRAM_ID,
  );
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: wrapSolAccount,
      lamports: amount,
    }),
    createSyncNativeInstruction(wrapSolAccount),
  );
  signAndSendTransaction(svm, transaction, [owner]);
}
