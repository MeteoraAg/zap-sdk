import {
  FailedTransactionMetadata,
  FeatureSet,
  LiteSVM,
  TransactionMetadata,
} from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
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
