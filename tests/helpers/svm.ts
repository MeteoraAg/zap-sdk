import {
  FailedTransactionMetadata,
  LiteSVM,
  TransactionMetadata,
} from "litesvm";
import {
  address,
  getTransactionDecoder,
  lamports,
  type Address,
  type Transaction as KitTransaction,
} from "@solana/kit";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import { expect } from "chai";

import ZapIDL from "../../src/idl/zap/idl.json";
import DammV2IDL from "../fixtures/damm_v2.json";
import JupiterIDL from "../fixtures/jupiter.json";
import DlmmIDL from "../fixtures/dlmm.json";

export interface SvmAccount {
  lamports: number;
  owner: PublicKey;
  data: Buffer;
  executable: boolean;
}

export function toAddress(pubkey: PublicKey): Address {
  return address(pubkey.toBase58());
}

// litesvm 1.x consumes @solana/kit transactions. The SDK builds web3.js transactions, so
// decode the wire bytes into the kit shape. Unsigned slots decode to `null` signatures.
export function toKitTransaction(
  transaction: Transaction | VersionedTransaction,
): KitTransaction {
  const wire =
    transaction instanceof VersionedTransaction
      ? transaction.serialize()
      : transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
  return getTransactionDecoder().decode(wire);
}

export function getAccount(svm: LiteSVM, pubkey: PublicKey): SvmAccount | null {
  const account = svm.getAccount(toAddress(pubkey));
  if (!account.exists) return null;
  return {
    lamports: Number(account.lamports),
    owner: new PublicKey(account.programAddress),
    data: Buffer.from(account.data),
    executable: account.executable,
  };
}

export function startSvm(): LiteSVM {
  const svm = new LiteSVM();

  svm.addProgramFromFile(address(ZapIDL.address), "tests/fixtures/zap.so");
  svm.addProgramFromFile(
    address(DammV2IDL.address),
    "tests/fixtures/damm_v2.so",
  );
  svm.addProgramFromFile(
    address(JupiterIDL.address),
    "tests/fixtures/jupiter.so",
  );
  svm.addProgramFromFile(address(DlmmIDL.address), "tests/fixtures/dlmm.so");

  return svm;
}

export function createLiteSvmConnection(svm: LiteSVM): Connection {
  const getAccountInfoResult = (pubkey: PublicKey) => getAccount(svm, pubkey);

  return {
    getAccountInfo: async (pubkey: PublicKey) => getAccountInfoResult(pubkey),
    getMultipleAccountsInfo: async (pubkeys: PublicKey[]) =>
      pubkeys.map(getAccountInfoResult),
    getMultipleAccountsInfoAndContext: async (pubkeys: PublicKey[]) => ({
      context: { slot: 0 },
      value: pubkeys.map(getAccountInfoResult),
    }),
    getAccountInfoAndContext: async (pubkey: PublicKey) => ({
      context: { slot: 0 },
      value: getAccountInfoResult(pubkey),
    }),
    getLatestBlockhash: async () => ({
      blockhash: svm.latestBlockhash(),
      lastValidBlockHeight: Number(svm.getClock().slot) + 150,
    }),
    // The DLMM SDK simulates unsigned transactions with `replaceRecentBlockhash` to size the
    // compute budget, so swap in a valid blockhash and skip signature checks for the simulation.
    simulateTransaction: async (transaction: VersionedTransaction) => {
      transaction.message.recentBlockhash = svm.latestBlockhash();
      svm.withSigverify(false);
      let result;
      try {
        result = svm.simulateTransaction(toKitTransaction(transaction));
      } finally {
        svm.withSigverify(true);
      }
      const meta = result.meta();
      return {
        context: { slot: 0 },
        value: {
          err:
            result instanceof FailedTransactionMetadata ? result.err() : null,
          logs: meta.logs(),
          unitsConsumed: Number(meta.computeUnitsConsumed()),
        },
      };
    },
    getTokenAccountBalance: async (pubkey: PublicKey) => {
      const account = getAccount(svm, pubkey);
      if (!account) throw new Error("Account not found");
      const decoded = AccountLayout.decode(account.data);
      return {
        context: { slot: 0 },
        value: {
          amount: decoded.amount.toString(),
          decimals: 0,
          uiAmount: null,
          uiAmountString: decoded.amount.toString(),
        },
      };
    },
  } as unknown as Connection;
}

export function generateKpAndFund(svm: LiteSVM): Keypair {
  const kp = Keypair.generate();
  svm.airdrop(
    toAddress(kp.publicKey),
    lamports(BigInt(100 * LAMPORTS_PER_SOL)),
  );
  return kp;
}

export function signAndSendTransaction(
  svm: LiteSVM,
  transaction: Transaction,
  signers: Keypair[],
): TransactionMetadata {
  transaction.recentBlockhash = svm.latestBlockhash();
  transaction.sign(...signers);

  const result = svm.sendTransaction(toKitTransaction(transaction));
  if (result instanceof FailedTransactionMetadata) {
    console.log(result.meta().logs());
  }
  expect(result).instanceOf(TransactionMetadata);
  return result as TransactionMetadata;
}

// Legacy transaction size limit in bytes.
const MAX_TRANSACTION_SIZE = 1232;

function fitsInTransaction(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  blockhash: string,
): boolean {
  const transaction = new Transaction({
    feePayer: payer,
    recentBlockhash: blockhash,
  }).add(...instructions);
  try {
    return (
      transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }).length <= MAX_TRANSACTION_SIZE
    );
  } catch {
    return false;
  }
}

// Packs `instructions` in order into as few legacy transactions as fit, the way a client would,
// and sends them one after another. The first signer pays; other signers sign only the
// transactions that need them. `computeUnitLimit`, when given, is set on every transaction.
export function sendInstructions(
  svm: LiteSVM,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  computeUnitLimit?: number,
): void {
  const payer = signers[0].publicKey;
  const blockhash = svm.latestBlockhash();
  const prefix = computeUnitLimit
    ? [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })]
    : [];
  const batches: TransactionInstruction[][] = [];
  for (const instruction of instructions) {
    const current = batches[batches.length - 1];
    if (
      current &&
      fitsInTransaction([...prefix, ...current, instruction], payer, blockhash)
    ) {
      current.push(instruction);
    } else {
      batches.push([instruction]);
    }
  }
  for (const batch of batches) {
    const batchSigners = signers.filter(
      (signer) =>
        signer.publicKey.equals(payer) ||
        batch.some((ix) =>
          ix.keys.some(
            (key) => key.isSigner && key.pubkey.equals(signer.publicKey),
          ),
        ),
    );
    signAndSendTransaction(
      svm,
      new Transaction({ feePayer: payer }).add(...prefix, ...batch),
      batchSigners,
    );
  }
}

function compileV0(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  blockhash: string,
  addressLookupTableAccounts: AddressLookupTableAccount[],
): VersionedTransaction | null {
  try {
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(addressLookupTableAccounts),
    );
    return transaction.serialize().length <= MAX_TRANSACTION_SIZE
      ? transaction
      : null;
  } catch {
    return null;
  }
}

// Same packing as `sendInstructions`, but compiles v0 transactions with the given lookup tables.
// Returns the transactions that were sent.
export function sendV0Instructions(
  svm: LiteSVM,
  instructions: TransactionInstruction[],
  addressLookupTableAccounts: AddressLookupTableAccount[],
  signers: Keypair[],
  computeUnitLimit?: number,
): VersionedTransaction[] {
  const payer = signers[0].publicKey;
  const blockhash = svm.latestBlockhash();
  const prefix = computeUnitLimit
    ? [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })]
    : [];
  const compile = (batch: TransactionInstruction[]) =>
    compileV0(
      [...prefix, ...batch],
      payer,
      blockhash,
      addressLookupTableAccounts,
    );
  const batches: TransactionInstruction[][] = [];
  for (const instruction of instructions) {
    const current = batches[batches.length - 1];
    if (current && compile([...current, instruction])) {
      current.push(instruction);
    } else {
      batches.push([instruction]);
    }
  }

  return batches.map((batch) => {
    const transaction = compile(batch);
    if (!transaction) {
      throw new Error("Instruction does not fit in a v0 transaction");
    }

    transaction.sign(
      signers.filter(
        (signer) =>
          signer.publicKey.equals(payer) ||
          batch.some((ix) =>
            ix.keys.some(
              (key) => key.isSigner && key.pubkey.equals(signer.publicKey),
            ),
          ),
      ),
    );
    const result = svm.sendTransaction(toKitTransaction(transaction));
    if (result instanceof FailedTransactionMetadata) {
      console.log(result.meta().logs());
    }
    expect(result).instanceOf(TransactionMetadata);
    return transaction;
  });
}
