export function convertAccountTypeToNumber(accountType: object): number {
  if (JSON.stringify(accountType) === JSON.stringify({ transferHookX: {} })) {
    return 0;
  }

  if (JSON.stringify(accountType) === JSON.stringify({ transferHookY: {} })) {
    return 1;
  }

  if (
    JSON.stringify(accountType) === JSON.stringify({ transferHookReward: {} })
  ) {
    return 2;
  }

  throw new Error(`Unknown account type: ${JSON.stringify(accountType)}`);
}
