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
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
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
