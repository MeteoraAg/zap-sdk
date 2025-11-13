/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/zap.json`.
 */
export type Zap = {
  address: "TzaptpzVczx3Q3rwujjXdhx1HFBXLP7UApACiqWujtA";
  metadata: {
    name: "zap";
    version: "0.2.0";
    spec: "0.1.0";
    description: "Created with Anchor";
  };
  instructions: [
    {
      name: "closeLedgerAccount";
      discriminator: [189, 122, 172, 13, 122, 54, 54, 51];
      accounts: [
        {
          name: "ledger";
          writable: true;
        },
        {
          name: "owner";
          signer: true;
          relations: ["ledger"];
        },
        {
          name: "rentReceiver";
          writable: true;
          signer: true;
        }
      ];
      args: [];
    },
    {
      name: "initializeLedgerAccount";
      discriminator: [120, 69, 30, 74, 76, 242, 153, 162];
      accounts: [
        {
          name: "ledger";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [117, 115, 101, 114, 95, 108, 101, 100, 103, 101, 114];
              },
              {
                kind: "account";
                path: "owner";
              }
            ];
          };
        },
        {
          name: "owner";
          signer: true;
        },
        {
          name: "payer";
          writable: true;
          signer: true;
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        }
      ];
      args: [];
    },
    {
      name: "setLedgerBalance";
      discriminator: [131, 49, 240, 17, 228, 248, 156, 54];
      accounts: [
        {
          name: "ledger";
          writable: true;
        },
        {
          name: "owner";
          signer: true;
          relations: ["ledger"];
        }
      ];
      args: [
        {
          name: "amount";
          type: "u64";
        },
        {
          name: "isTokenA";
          type: "bool";
        }
      ];
    },
    {
      name: "updateLedgerBalanceAfterSwap";
      discriminator: [59, 206, 173, 232, 94, 57, 174, 202];
      accounts: [
        {
          name: "ledger";
          writable: true;
        },
        {
          name: "tokenAccount";
        },
        {
          name: "owner";
          signer: true;
          relations: ["ledger"];
        }
      ];
      args: [
        {
          name: "preSourceTokenBalance";
          type: "u64";
        },
        {
          name: "maxTransferAmount";
          type: "u64";
        },
        {
          name: "isTokenA";
          type: "bool";
        }
      ];
    },
    {
      name: "zapInDammV2";
      discriminator: [243, 243, 119, 52, 199, 44, 154, 186];
      accounts: [
        {
          name: "ledger";
          writable: true;
        },
        {
          name: "pool";
          writable: true;
        },
        {
          name: "poolAuthority";
        },
        {
          name: "position";
          writable: true;
        },
        {
          name: "tokenAAccount";
          writable: true;
        },
        {
          name: "tokenBAccount";
          writable: true;
        },
        {
          name: "tokenAVault";
          writable: true;
        },
        {
          name: "tokenBVault";
          writable: true;
        },
        {
          name: "tokenAMint";
        },
        {
          name: "tokenBMint";
        },
        {
          name: "positionNftAccount";
        },
        {
          name: "owner";
          docs: ["owner of position"];
          signer: true;
          relations: ["ledger"];
        },
        {
          name: "tokenAProgram";
        },
        {
          name: "tokenBProgram";
        },
        {
          name: "dammProgram";
          address: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
        },
        {
          name: "dammEventAuthority";
        }
      ];
      args: [
        {
          name: "preSqrtPrice";
          type: "u128";
        },
        {
          name: "maxSqrtPriceChangeBps";
          type: "u32";
        }
      ];
    },
    {
      name: "zapInDlmmForInitializedPosition";
      discriminator: [184, 71, 198, 231, 129, 110, 193, 67];
      accounts: [
        {
          name: "ledger";
          writable: true;
        },
        {
          name: "lbPair";
          docs: ["lb pair"];
          writable: true;
        },
        {
          name: "position";
          writable: true;
        },
        {
          name: "binArrayBitmapExtension";
          writable: true;
          optional: true;
        },
        {
          name: "userTokenX";
          writable: true;
        },
        {
          name: "userTokenY";
          writable: true;
        },
        {
          name: "reserveX";
          writable: true;
        },
        {
          name: "reserveY";
          writable: true;
        },
        {
          name: "tokenXMint";
        },
        {
          name: "tokenYMint";
        },
        {
          name: "dlmmProgram";
          address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
        },
        {
          name: "owner";
          docs: ["owner of position"];
          signer: true;
          relations: ["ledger"];
        },
        {
          name: "rentPayer";
          writable: true;
          signer: true;
        },
        {
          name: "tokenXProgram";
        },
        {
          name: "tokenYProgram";
        },
        {
          name: "memoProgram";
        },
        {
          name: "systemProgram";
        },
        {
          name: "dlmmEventAuthority";
        }
      ];
      args: [
        {
          name: "activeId";
          type: "i32";
        },
        {
          name: "minDeltaId";
          type: "i32";
        },
        {
          name: "maxDeltaId";
          type: "i32";
        },
        {
          name: "maxActiveBinSlippage";
          type: "u16";
        },
        {
          name: "favorXInActiveId";
          type: "bool";
        },
        {
          name: "strategy";
          type: {
            defined: {
              name: "strategyType";
            };
          };
        },
        {
          name: "remainingAccountsInfo";
          type: {
            defined: {
              name: "remainingAccountsInfo";
            };
          };
        }
      ];
    },
    {
      name: "zapInDlmmForUninitializedPosition";
      discriminator: [59, 220, 182, 27, 254, 253, 2, 232];
      accounts: [
        {
          name: "ledger";
          writable: true;
        },
        {
          name: "lbPair";
          docs: ["lb pair"];
          writable: true;
        },
        {
          name: "position";
          docs: [
            "user position",
            "Check it is different from owner to advoid user to pass owner address wrongly"
          ];
          writable: true;
          signer: true;
        },
        {
          name: "binArrayBitmapExtension";
          writable: true;
          optional: true;
        },
        {
          name: "userTokenX";
          writable: true;
        },
        {
          name: "userTokenY";
          writable: true;
        },
        {
          name: "reserveX";
          writable: true;
        },
        {
          name: "reserveY";
          writable: true;
        },
        {
          name: "tokenXMint";
        },
        {
          name: "tokenYMint";
        },
        {
          name: "dlmmProgram";
          address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
        },
        {
          name: "owner";
          docs: ["owner of position"];
          signer: true;
          relations: ["ledger"];
        },
        {
          name: "rentPayer";
          writable: true;
          signer: true;
        },
        {
          name: "tokenXProgram";
        },
        {
          name: "tokenYProgram";
        },
        {
          name: "memoProgram";
        },
        {
          name: "systemProgram";
        },
        {
          name: "dlmmEventAuthority";
        }
      ];
      args: [
        {
          name: "binDelta";
          type: "u8";
        },
        {
          name: "activeId";
          type: "i32";
        },
        {
          name: "maxActiveBinSlippage";
          type: "u16";
        },
        {
          name: "favorXInActiveId";
          type: "bool";
        },
        {
          name: "strategy";
          type: {
            defined: {
              name: "strategyType";
            };
          };
        },
        {
          name: "remainingAccountsInfo";
          type: {
            defined: {
              name: "remainingAccountsInfo";
            };
          };
        }
      ];
    },
    {
      name: "zapOut";
      discriminator: [155, 108, 185, 112, 104, 210, 161, 64];
      accounts: [
        {
          name: "userTokenInAccount";
          writable: true;
        },
        {
          name: "ammProgram";
        }
      ];
      args: [
        {
          name: "params";
          type: {
            defined: {
              name: "zapOutParameters";
            };
          };
        }
      ];
    }
  ];
  accounts: [
    {
      name: "lbPair";
      discriminator: [33, 11, 49, 98, 181, 101, 177, 13];
    },
    {
      name: "pool";
      discriminator: [241, 154, 109, 4, 17, 177, 109, 188];
    },
    {
      name: "userLedger";
      discriminator: [185, 84, 101, 128, 8, 6, 160, 83];
    }
  ];
  errors: [
    {
      code: 6000;
      name: "mathOverflow";
      msg: "Math operation overflow";
    },
    {
      code: 6001;
      name: "invalidOffset";
      msg: "Invalid offset";
    },
    {
      code: 6002;
      name: "invalidZapOutParameters";
      msg: "Invalid zapout parameters";
    },
    {
      code: 6003;
      name: "typeCastFailed";
      msg: "Type cast error";
    },
    {
      code: 6004;
      name: "ammIsNotSupported";
      msg: "Amm program is not supported";
    },
    {
      code: 6005;
      name: "invalidPosition";
      msg: "Position is not empty";
    },
    {
      code: 6006;
      name: "exceededSlippage";
      msg: "Exceeded slippage tolerance";
    }
  ];
  types: [
    {
      name: "accountsType";
      type: {
        kind: "enum";
        variants: [
          {
            name: "transferHookX";
          },
          {
            name: "transferHookY";
          },
          {
            name: "transferHookReward";
          },
          {
            name: "transferHookMultiReward";
            fields: ["u8"];
          }
        ];
      };
    },
    {
      name: "baseFeeStruct";
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "cliffFeeNumerator";
            type: "u64";
          },
          {
            name: "baseFeeMode";
            type: "u8";
          },
          {
            name: "padding0";
            type: {
              array: ["u8", 5];
            };
          },
          {
            name: "firstFactor";
            type: "u16";
          },
          {
            name: "secondFactor";
            type: {
              array: ["u8", 8];
            };
          },
          {
            name: "thirdFactor";
            type: "u64";
          },
          {
            name: "padding1";
            type: "u64";
          }
        ];
      };
    },
    {
      name: "dynamicFeeStruct";
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "initialized";
            type: "u8";
          },
          {
            name: "padding";
            type: {
              array: ["u8", 7];
            };
          },
          {
            name: "maxVolatilityAccumulator";
            type: "u32";
          },
          {
            name: "variableFeeControl";
            type: "u32";
          },
          {
            name: "binStep";
            type: "u16";
          },
          {
            name: "filterPeriod";
            type: "u16";
          },
          {
            name: "decayPeriod";
            type: "u16";
          },
          {
            name: "reductionFactor";
            type: "u16";
          },
          {
            name: "lastUpdateTimestamp";
            type: "u64";
          },
          {
            name: "binStepU128";
            type: "u128";
          },
          {
            name: "sqrtPriceReference";
            type: "u128";
          },
          {
            name: "volatilityAccumulator";
            type: "u128";
          },
          {
            name: "volatilityReference";
            type: "u128";
          }
        ];
      };
    },
    {
      name: "lbPair";
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "parameters";
            type: {
              defined: {
                name: "staticParameters";
              };
            };
          },
          {
            name: "vParameters";
            type: {
              defined: {
                name: "variableParameters";
              };
            };
          },
          {
            name: "bumpSeed";
            type: {
              array: ["u8", 1];
            };
          },
          {
            name: "binStepSeed";
            type: {
              array: ["u8", 2];
            };
          },
          {
            name: "pairType";
            type: "u8";
          },
          {
            name: "activeId";
            type: "i32";
          },
          {
            name: "binStep";
            type: "u16";
          },
          {
            name: "status";
            type: "u8";
          },
          {
            name: "requireBaseFactorSeed";
            type: "u8";
          },
          {
            name: "baseFactorSeed";
            type: {
              array: ["u8", 2];
            };
          },
          {
            name: "activationType";
            type: "u8";
          },
          {
            name: "creatorPoolOnOffControl";
            type: "u8";
          },
          {
            name: "tokenXMint";
            type: "pubkey";
          },
          {
            name: "tokenYMint";
            type: "pubkey";
          },
          {
            name: "reserveX";
            type: "pubkey";
          },
          {
            name: "reserveY";
            type: "pubkey";
          },
          {
            name: "protocolFee";
            type: {
              defined: {
                name: "protocolFee";
              };
            };
          },
          {
            name: "padding1";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "rewardInfos";
            type: {
              array: [
                {
                  defined: {
                    name: "dlmm::dlmm::types::RewardInfo";
                  };
                },
                2
              ];
            };
          },
          {
            name: "oracle";
            type: "pubkey";
          },
          {
            name: "binArrayBitmap";
            type: {
              array: ["u64", 16];
            };
          },
          {
            name: "lastUpdatedAt";
            type: "i64";
          },
          {
            name: "padding2";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "preActivationSwapAddress";
            type: "pubkey";
          },
          {
            name: "baseKey";
            type: "pubkey";
          },
          {
            name: "activationPoint";
            type: "u64";
          },
          {
            name: "preActivationDuration";
            type: "u64";
          },
          {
            name: "padding3";
            type: {
              array: ["u8", 8];
            };
          },
          {
            name: "padding4";
            type: "u64";
          },
          {
            name: "creator";
            type: "pubkey";
          },
          {
            name: "tokenMintXProgramFlag";
            type: "u8";
          },
          {
            name: "tokenMintYProgramFlag";
            type: "u8";
          },
          {
            name: "reserved";
            type: {
              array: ["u8", 22];
            };
          }
        ];
      };
    },
    {
      name: "pool";
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "poolFees";
            docs: ["Pool fee"];
            type: {
              defined: {
                name: "poolFeesStruct";
              };
            };
          },
          {
            name: "tokenAMint";
            docs: ["token a mint"];
            type: "pubkey";
          },
          {
            name: "tokenBMint";
            docs: ["token b mint"];
            type: "pubkey";
          },
          {
            name: "tokenAVault";
            docs: ["token a vault"];
            type: "pubkey";
          },
          {
            name: "tokenBVault";
            docs: ["token b vault"];
            type: "pubkey";
          },
          {
            name: "whitelistedVault";
            docs: [
              "Whitelisted vault to be able to buy pool before activation_point"
            ];
            type: "pubkey";
          },
          {
            name: "partner";
            docs: ["partner"];
            type: "pubkey";
          },
          {
            name: "liquidity";
            docs: ["liquidity share"];
            type: "u128";
          },
          {
            name: "padding";
            docs: [
              "padding, previous reserve amount, be careful to use that field"
            ];
            type: "u128";
          },
          {
            name: "protocolAFee";
            docs: ["protocol a fee"];
            type: "u64";
          },
          {
            name: "protocolBFee";
            docs: ["protocol b fee"];
            type: "u64";
          },
          {
            name: "partnerAFee";
            docs: ["partner a fee"];
            type: "u64";
          },
          {
            name: "partnerBFee";
            docs: ["partner b fee"];
            type: "u64";
          },
          {
            name: "sqrtMinPrice";
            docs: ["min price"];
            type: "u128";
          },
          {
            name: "sqrtMaxPrice";
            docs: ["max price"];
            type: "u128";
          },
          {
            name: "sqrtPrice";
            docs: ["current price"];
            type: "u128";
          },
          {
            name: "activationPoint";
            docs: ["Activation point, can be slot or timestamp"];
            type: "u64";
          },
          {
            name: "activationType";
            docs: ["Activation type, 0 means by slot, 1 means by timestamp"];
            type: "u8";
          },
          {
            name: "poolStatus";
            docs: ["pool status, 0: enable, 1 disable"];
            type: "u8";
          },
          {
            name: "tokenAFlag";
            docs: ["token a flag"];
            type: "u8";
          },
          {
            name: "tokenBFlag";
            docs: ["token b flag"];
            type: "u8";
          },
          {
            name: "collectFeeMode";
            docs: [
              "0 is collect fee in both token, 1 only collect fee in token a, 2 only collect fee in token b"
            ];
            type: "u8";
          },
          {
            name: "poolType";
            docs: ["pool type"];
            type: "u8";
          },
          {
            name: "version";
            docs: [
              "pool version, 0: max_fee is still capped at 50%, 1: max_fee is capped at 99%"
            ];
            type: "u8";
          },
          {
            name: "padding0";
            docs: ["padding"];
            type: "u8";
          },
          {
            name: "feeAPerLiquidity";
            docs: ["cumulative"];
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "feeBPerLiquidity";
            docs: ["cumulative"];
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "permanentLockLiquidity";
            type: "u128";
          },
          {
            name: "metrics";
            docs: ["metrics"];
            type: {
              defined: {
                name: "poolMetrics";
              };
            };
          },
          {
            name: "creator";
            docs: ["pool creator"];
            type: "pubkey";
          },
          {
            name: "padding1";
            docs: ["Padding for further use"];
            type: {
              array: ["u64", 6];
            };
          },
          {
            name: "rewardInfos";
            docs: ["Farming reward information"];
            type: {
              array: [
                {
                  defined: {
                    name: "cp_amm::state::pool::RewardInfo";
                  };
                },
                2
              ];
            };
          }
        ];
      };
    },
    {
      name: "poolFeesStruct";
      docs: [
        "Information regarding fee charges",
        "trading_fee = amount * trade_fee_numerator / denominator",
        "protocol_fee = trading_fee * protocol_fee_percentage / 100",
        "referral_fee = protocol_fee * referral_percentage / 100",
        "partner_fee = (protocol_fee - referral_fee) * partner_fee_percentage / denominator"
      ];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "baseFee";
            docs: [
              "Trade fees are extra token amounts that are held inside the token",
              "accounts during a trade, making the value of liquidity tokens rise.",
              "Trade fee numerator"
            ];
            type: {
              defined: {
                name: "baseFeeStruct";
              };
            };
          },
          {
            name: "protocolFeePercent";
            docs: [
              "Protocol trading fees are extra token amounts that are held inside the token",
              "accounts during a trade, with the equivalent in pool tokens minted to",
              "the protocol of the program.",
              "Protocol trade fee numerator"
            ];
            type: "u8";
          },
          {
            name: "partnerFeePercent";
            docs: ["partner fee"];
            type: "u8";
          },
          {
            name: "referralFeePercent";
            docs: ["referral fee"];
            type: "u8";
          },
          {
            name: "padding0";
            docs: ["padding"];
            type: {
              array: ["u8", 5];
            };
          },
          {
            name: "dynamicFee";
            docs: ["dynamic fee"];
            type: {
              defined: {
                name: "dynamicFeeStruct";
              };
            };
          },
          {
            name: "padding1";
            docs: ["padding"];
            type: {
              array: ["u64", 2];
            };
          }
        ];
      };
    },
    {
      name: "poolMetrics";
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "totalLpAFee";
            type: "u128";
          },
          {
            name: "totalLpBFee";
            type: "u128";
          },
          {
            name: "totalProtocolAFee";
            type: "u64";
          },
          {
            name: "totalProtocolBFee";
            type: "u64";
          },
          {
            name: "totalPartnerAFee";
            type: "u64";
          },
          {
            name: "totalPartnerBFee";
            type: "u64";
          },
          {
            name: "totalPosition";
            type: "u64";
          },
          {
            name: "padding";
            type: "u64";
          }
        ];
      };
    },
    {
      name: "protocolFee";
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "amountX";
            type: "u64";
          },
          {
            name: "amountY";
            type: "u64";
          }
        ];
      };
    },
    {
      name: "remainingAccountsInfo";
      type: {
        kind: "struct";
        fields: [
          {
            name: "slices";
            type: {
              vec: {
                defined: {
                  name: "remainingAccountsSlice";
                };
              };
            };
          }
        ];
      };
    },
    {
      name: "remainingAccountsSlice";
      type: {
        kind: "struct";
        fields: [
          {
            name: "accountsType";
            type: {
              defined: {
                name: "accountsType";
              };
            };
          },
          {
            name: "length";
            type: "u8";
          }
        ];
      };
    },
    {
      name: "staticParameters";
      docs: ["Parameter that set by the protocol"];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "baseFactor";
            type: "u16";
          },
          {
            name: "filterPeriod";
            type: "u16";
          },
          {
            name: "decayPeriod";
            type: "u16";
          },
          {
            name: "reductionFactor";
            type: "u16";
          },
          {
            name: "variableFeeControl";
            type: "u32";
          },
          {
            name: "maxVolatilityAccumulator";
            type: "u32";
          },
          {
            name: "minBinId";
            type: "i32";
          },
          {
            name: "maxBinId";
            type: "i32";
          },
          {
            name: "protocolShare";
            type: "u16";
          },
          {
            name: "baseFeePowerFactor";
            type: "u8";
          },
          {
            name: "padding";
            type: {
              array: ["u8", 5];
            };
          }
        ];
      };
    },
    {
      name: "strategyType";
      type: {
        kind: "enum";
        variants: [
          {
            name: "spot";
          },
          {
            name: "curve";
          },
          {
            name: "bidAsk";
          }
        ];
      };
    },
    {
      name: "userLedger";
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "owner";
            type: "pubkey";
          },
          {
            name: "amountA";
            type: "u64";
          },
          {
            name: "amountB";
            type: "u64";
          }
        ];
      };
    },
    {
      name: "variableParameters";
      docs: ["Parameters that changes based on dynamic of the market"];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "volatilityAccumulator";
            type: "u32";
          },
          {
            name: "volatilityReference";
            type: "u32";
          },
          {
            name: "indexReference";
            type: "i32";
          },
          {
            name: "padding";
            type: {
              array: ["u8", 4];
            };
          },
          {
            name: "lastUpdateTimestamp";
            type: "i64";
          },
          {
            name: "padding1";
            type: {
              array: ["u8", 8];
            };
          }
        ];
      };
    },
    {
      name: "zapOutParameters";
      type: {
        kind: "struct";
        fields: [
          {
            name: "percentage";
            type: "u8";
          },
          {
            name: "offsetAmountIn";
            type: "u16";
          },
          {
            name: "preUserTokenBalance";
            type: "u64";
          },
          {
            name: "maxSwapAmount";
            type: "u64";
          },
          {
            name: "payloadData";
            type: "bytes";
          }
        ];
      };
    },
    {
      name: "cp_amm::state::pool::RewardInfo";
      docs: ["Stores the state relevant for tracking liquidity mining rewards"];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "initialized";
            docs: ["Indicates if the reward has been initialized"];
            type: "u8";
          },
          {
            name: "rewardTokenFlag";
            docs: ["reward token flag"];
            type: "u8";
          },
          {
            name: "padding0";
            docs: ["padding"];
            type: {
              array: ["u8", 6];
            };
          },
          {
            name: "padding1";
            docs: ["Padding to ensure `reward_rate: u128` is 16-byte aligned"];
            type: {
              array: ["u8", 8];
            };
          },
          {
            name: "mint";
            docs: ["Reward token mint."];
            type: "pubkey";
          },
          {
            name: "vault";
            docs: ["Reward vault token account."];
            type: "pubkey";
          },
          {
            name: "funder";
            docs: ["Authority account that allows to fund rewards"];
            type: "pubkey";
          },
          {
            name: "rewardDuration";
            docs: ["reward duration"];
            type: "u64";
          },
          {
            name: "rewardDurationEnd";
            docs: ["reward duration end"];
            type: "u64";
          },
          {
            name: "rewardRate";
            docs: ["reward rate"];
            type: "u128";
          },
          {
            name: "rewardPerTokenStored";
            docs: ["Reward per token stored"];
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "lastUpdateTime";
            docs: ["The last time reward states were updated."];
            type: "u64";
          },
          {
            name: "cumulativeSecondsWithEmptyLiquidityReward";
            docs: [
              "Accumulated seconds when the farm distributed rewards but the bin was empty.",
              "These rewards will be carried over to the next reward time window."
            ];
            type: "u64";
          }
        ];
      };
    },
    {
      name: "dlmm::dlmm::types::RewardInfo";
      docs: ["Stores the state relevant for tracking liquidity mining rewards"];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "mint";
            type: "pubkey";
          },
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "funder";
            type: "pubkey";
          },
          {
            name: "rewardDuration";
            type: "u64";
          },
          {
            name: "rewardDurationEnd";
            type: "u64";
          },
          {
            name: "rewardRate";
            type: "u128";
          },
          {
            name: "lastUpdateTime";
            type: "u64";
          },
          {
            name: "cumulativeSecondsWithEmptyLiquidityReward";
            type: "u64";
          }
        ];
      };
    }
  ];
  constants: [
    {
      name: "dammV2";
      type: "pubkey";
      value: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
    },
    {
      name: "dammV2SwapDisc";
      type: {
        array: ["u8", 8];
      };
      value: "[248, 198, 158, 145, 225, 117, 135, 200]";
    },
    {
      name: "dlmmSwap2Disc";
      type: {
        array: ["u8", 8];
      };
      value: "[65, 75, 63, 76, 235, 91, 91, 136]";
    },
    {
      name: "jupV6";
      type: "pubkey";
      value: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
    },
    {
      name: "jupV6RouteDisc";
      type: {
        array: ["u8", 8];
      };
      value: "[229, 23, 203, 151, 122, 227, 173, 42]";
    },
    {
      name: "jupV6SharedAccountRouteDisc";
      type: {
        array: ["u8", 8];
      };
      value: "[193, 32, 155, 51, 65, 214, 156, 129]";
    },
    {
      name: "maxBasisPoint";
      type: "u16";
      value: "10000";
    },
    {
      name: "userLedgerPrefix";
      type: "bytes";
      value: "[117, 115, 101, 114, 95, 108, 101, 100, 103, 101, 114]";
    }
  ];
};
