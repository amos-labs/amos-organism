export interface ValueOfComputationInput {
  readonly basis: "vested";
  readonly currentVerifiedQuality: number;
  readonly requiredQualityFloor: number;
  readonly expectedVestedQualityGain: number;
  readonly expectedUncertaintyReduction: number;
  readonly tokenCost: number;
  readonly delayCost: number;
  readonly regressionRisk: number;
  readonly remainingEnergy: number;
  readonly stalledWindows: number;
  readonly pendingHostVerification: boolean;
  readonly authorityConstraintsSatisfied: boolean;
}

export interface ComputationDecision {
  readonly action: "continue" | "verify" | "challenge" | "stop";
  readonly reason: string;
  readonly netValue: number;
}

/** A stopping controller that consumes vested evidence, never provisional activity. */
export function valueOfComputation(input: ValueOfComputationInput): ComputationDecision {
  if (input.basis !== "vested") {
    throw new Error("Value-of-computation must be based on vested outcomes");
  }
  assertProbability(input.currentVerifiedQuality, "currentVerifiedQuality");
  assertProbability(input.requiredQualityFloor, "requiredQualityFloor");
  assertProbability(input.regressionRisk, "regressionRisk");
  assertBoundedDelta(input.expectedVestedQualityGain, "expectedVestedQualityGain");
  assertBoundedDelta(input.expectedUncertaintyReduction, "expectedUncertaintyReduction");
  assertNonNegative(input.tokenCost, "tokenCost");
  assertNonNegative(input.delayCost, "delayCost");
  assertNonNegative(input.remainingEnergy, "remainingEnergy");
  if (!Number.isInteger(input.stalledWindows) || input.stalledWindows < 0) {
    throw new RangeError("stalledWindows must be a non-negative integer");
  }

  if (!input.authorityConstraintsSatisfied) {
    return { action: "stop", reason: "A host authority constraint failed", netValue: -Infinity };
  }
  if (input.pendingHostVerification) {
    return { action: "verify", reason: "A candidate outcome needs independent verification", netValue: 0 };
  }
  if (input.remainingEnergy <= 0) {
    return { action: "stop", reason: "The mission has no compute rights remaining", netValue: -Infinity };
  }

  const netValue = input.expectedVestedQualityGain +
    (0.25 * input.expectedUncertaintyReduction) -
    input.tokenCost -
    input.delayCost -
    input.regressionRisk;

  if (
    input.currentVerifiedQuality < input.requiredQualityFloor &&
    input.expectedVestedQualityGain > 0
  ) {
    return {
      action: "continue",
      reason: "Verified quality is below the floor and further work has positive expected gain",
      netValue,
    };
  }
  if (input.stalledWindows >= 2 && input.expectedVestedQualityGain <= 0) {
    return {
      action: "challenge",
      reason: "Vested quality is flat; change procedure instead of extending the same lease",
      netValue,
    };
  }
  if (netValue <= 0) {
    return {
      action: "stop",
      reason: "Expected vested improvement no longer exceeds compute, delay, and regression cost",
      netValue,
    };
  }
  return {
    action: "continue",
    reason: "Expected vested improvement exceeds its marginal cost",
    netValue,
  };
}

function assertProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be between zero and one`);
  }
}

function assertBoundedDelta(value: number, label: string): void {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new RangeError(`${label} must be between -1 and 1`);
  }
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
}
