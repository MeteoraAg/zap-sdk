import {
  FailedTransactionMetadata,
  FeatureSet,
  LiteSVM,
  TransactionMetadata,
} from "litesvm";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import { expect } from "chai";

import ZapIDL from "../../src/idl/zap/idl.json";
import DammV2IDL from "../fixtures/damm_v2.json";
import JupiterIDL from "../fixtures/jupiter.json";

export function startSvm(): LiteSVM {
  const svm = new LiteSVM().withFeatureSet(FeatureSet.allEnabled());

  svm.addProgramFromFile(
    new PublicKey(ZapIDL.address),
    "tests/fixtures/zap.so",
  );
  svm.addProgramFromFile(
    new PublicKey(DammV2IDL.address),
    "tests/fixtures/damm_v2.so",
  );
  svm.addProgramFromFile(
    new PublicKey(JupiterIDL.address),
    "tests/fixtures/jupiter.so",
  );

  return svm;
}

export function createLiteSvmConnection(svm: LiteSVM): Connection {
  const getAccountInfoResult = (pubkey: PublicKey) => {
    const account = svm.getAccount(pubkey);
    if (!account) return null;
    return {
      ...account,
      data: Buffer.from(account.data),
    };
  };

  return {
    getAccountInfo: async (pubkey: PublicKey) => getAccountInfoResult(pubkey),
    getAccountInfoAndContext: async (pubkey: PublicKey) => ({
      context: { slot: 0 },
      value: getAccountInfoResult(pubkey),
    }),
    getTokenAccountBalance: async (pubkey: PublicKey) => {
      const account = svm.getAccount(pubkey);
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
  svm.airdrop(kp.publicKey, BigInt(100 * LAMPORTS_PER_SOL));
  return kp;
}

export function signAndSendTransaction(
  svm: LiteSVM,
  transaction: Transaction,
  signers: Keypair[],
): TransactionMetadata {
  transaction.recentBlockhash = svm.latestBlockhash();
  transaction.sign(...signers);

  const result = svm.sendTransaction(transaction);
  if (result instanceof FailedTransactionMetadata) {
    console.log(result.meta().logs());
  }
  expect(result).instanceOf(TransactionMetadata);
  return result as TransactionMetadata;
}
