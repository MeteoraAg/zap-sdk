import { strict as assert } from "assert";
import BN from "bn.js";
import DLMM, {
  createProgram,
  deriveBinArray,
  deriveCustomizablePermissionlessLbPair,
  deriveOracle,
  deriveReserve,
  getBinArrayAccountMetasCoverage,
} from "@meteora-ag/dlmm";
import {
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { DLMM_PROGRAM_ID } from "../src/constants";
import { Zap } from "../src/zap";
import { createToken, mintToken, getTokenBalance } from "./helpers/token";
import {
  createLiteSvmConnection,
  generateKpAndFund,
  signAndSendTransaction,
  startSvm,
} from "./helpers/svm";

describe("DLMM zap-out bin-array direction", () => {
  for (const swapForY of [true, false]) {
    it(`executes ${swapForY ? "X to Y" : "Y to X"} across a bin-array boundary`, async () => {
      const svm = startSvm();
      svm.addProgramFromFile(DLMM_PROGRAM_ID, "tests/fixtures/dlmm.so");
      const admin = generateKpAndFund(svm);
      const user = generateKpAndFund(svm);
      const mintA = createToken(svm, admin, admin.publicKey, null);
      const mintB = createToken(svm, admin, admin.publicKey, null);
      const [tokenXMint, tokenYMint] = [mintA, mintB].sort((a, b) =>
        a.toBuffer().compare(b.toBuffer()),
      );
      for (const mint of [tokenXMint, tokenYMint]) {
        for (const owner of [admin, user])
          mintToken(svm, admin, mint, admin, owner.publicKey);
      }
      const connection = createLiteSvmConnection(svm);
      connection.getMultipleAccountsInfo = async (keys) =>
        Promise.all(keys.map((key) => connection.getAccountInfo(key)));
      connection.getMultipleAccountsInfoAndContext = async (keys) => ({
        context: { slot: Number(svm.getClock().slot) },
        value: await connection.getMultipleAccountsInfo(keys),
      });
      connection.getSlot = async () => Number(svm.getClock().slot);
      connection.getBlockTime = async () =>
        Number(svm.getClock().unixTimestamp);
      const program = createProgram(connection);
      const activeId = swapForY ? 70 : 69;
      const [lbPair] = deriveCustomizablePermissionlessLbPair(
        tokenXMint,
        tokenYMint,
        DLMM_PROGRAM_ID,
      );
      const [reserveX] = deriveReserve(tokenXMint, lbPair, DLMM_PROGRAM_ID);
      const [reserveY] = deriveReserve(tokenYMint, lbPair, DLMM_PROGRAM_ID);
      const [oracle] = deriveOracle(lbPair, DLMM_PROGRAM_ID);
      const init = await program.methods
        .initializeCustomizablePermissionlessLbPair({
          activeId,
          binStep: 10,
          baseFactor: 10000,
          activationType: 0,
          hasAlphaVault: false,
          activationPoint: null,
          creatorPoolOnOffControl: false,
          baseFeePowerFactor: 0,
          concreteFunctionType: 0,
          collectFeeMode: 0,
          padding: new Array(60).fill(0),
        })
        .accountsPartial({
          lbPair,
          binArrayBitmapExtension: null,
          tokenMintX: tokenXMint,
          tokenMintY: tokenYMint,
          reserveX,
          reserveY,
          oracle,
          userTokenX: getAssociatedTokenAddressSync(
            tokenXMint,
            admin.publicKey,
          ),
          userTokenY: getAssociatedTokenAddressSync(
            tokenYMint,
            admin.publicKey,
          ),
          funder: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      signAndSendTransaction(svm, init, [admin]);
      svm.warpToSlot(svm.getClock().slot + BigInt(1));
      for (const index of [0, 1]) {
        const [binArray] = deriveBinArray(
          lbPair,
          new BN(index),
          DLMM_PROGRAM_ID,
        );
        const tx = await program.methods
          .initializeBinArray(new BN(index))
          .accountsPartial({
            binArray,
            funder: admin.publicKey,
            lbPair,
            systemProgram: SystemProgram.programId,
          })
          .transaction();
        signAndSendTransaction(
          svm,
          new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }))
            .add(tx),
          [admin],
        );
      }
      const lowerBinId = 35,
        upperBinId = 104;
      const position = Keypair.generate();
      const initPosition = await program.methods
        .initializePosition(lowerBinId, 70)
        .accountsPartial({
          payer: admin.publicKey,
          position: position.publicKey,
          lbPair,
          owner: admin.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .transaction();
      const addLiquidity = await program.methods
        .addLiquidityByStrategy2(
          {
            amountX: new BN("100000000000000"),
            amountY: new BN("100000000000000"),
            activeId,
            maxActiveBinSlippage: 0,
            strategyParameters: {
              minBinId: lowerBinId,
              maxBinId: upperBinId,
              strategyType: { spotBalanced: {} },
              parameteres: new Array(64).fill(0),
            },
          },
          { slices: [] },
        )
        .accountsPartial({
          position: position.publicKey,
          lbPair,
          binArrayBitmapExtension: null,
          userTokenX: getAssociatedTokenAddressSync(
            tokenXMint,
            admin.publicKey,
          ),
          userTokenY: getAssociatedTokenAddressSync(
            tokenYMint,
            admin.publicKey,
          ),
          reserveX,
          reserveY,
          tokenXMint,
          tokenYMint,
          sender: admin.publicKey,
          tokenXProgram: TOKEN_PROGRAM_ID,
          tokenYProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(
          getBinArrayAccountMetasCoverage(
            new BN(lowerBinId),
            new BN(upperBinId),
            lbPair,
            DLMM_PROGRAM_ID,
          ),
        )
        .transaction();
      signAndSendTransaction(
        svm,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }))
          .add(initPosition)
          .add(addLiquidity),
        [admin, position],
      );

      const inputMint = swapForY ? tokenXMint : tokenYMint;
      const outputMint = swapForY ? tokenYMint : tokenXMint;
      const inputAccount = getAssociatedTokenAddressSync(
        inputMint,
        user.publicKey,
      );
      const outputAccount = getAssociatedTokenAddressSync(
        outputMint,
        user.publicKey,
      );
      const amountIn = new BN("10000000000000");
      const dlmm = await DLMM.create(connection, lbPair);
      const binArrays = await dlmm.getBinArrayForSwap(swapForY, 5);
      const quote = dlmm.swapQuote(amountIn, swapForY, new BN(100), binArrays);
      assert(
        quote.binArraysPubkey.length > 1,
        "the swap must cross an array boundary",
      );
      const zap = new Zap(connection);
      const transaction = await zap.zapOutThroughDlmm({
        user: user.publicKey,
        lbPairAddress: lbPair,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_PROGRAM_ID,
        amountIn,
        minimumSwapAmountOut: quote.minOutAmount,
        maxSwapAmount: amountIn,
        percentageToZapOut: 100,
      });
      const instruction = transaction.instructions.find((ix) =>
        ix.programId.equals(zap.zapProgram.programId),
      )!;
      const inputBefore = getTokenBalance(svm, inputAccount);
      const outputBefore = getTokenBalance(svm, outputAccount);
      // Simulate receiving tokens from an earlier withdrawal in the same transaction.
      const received = createMintToInstruction(
        inputMint,
        inputAccount,
        admin.publicKey,
        BigInt(amountIn.toString()),
      );
      signAndSendTransaction(
        svm,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }))
          .add(received)
          .add(transaction),
        [admin, user],
      );
      for (const key of quote.binArraysPubkey)
        assert(
          instruction.keys.some((meta) => meta.pubkey.equals(key)),
          "zap must forward every quoted bin array",
        );
      assert(getTokenBalance(svm, inputAccount).eq(inputBefore));
      assert(
        getTokenBalance(svm, outputAccount)
          .sub(outputBefore)
          .gte(quote.minOutAmount),
      );
    });
  }
});
