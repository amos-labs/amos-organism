import { digest, immutable } from "./digest.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";

export interface ExactWorldFact {
  readonly key: string;
  readonly value: unknown;
  readonly valueDigest: string;
  readonly observedByReceiptId: string;
  readonly authority: "host";
}

export interface HrrAttentionCandidate {
  readonly key: string;
  readonly similarity: number;
  readonly channel: "identity" | "semantic";
  readonly authority: "none";
}

export type TransitionTarget =
  | "phase-advance"
  | "criterion-pass"
  | "criterion-fail"
  | "token-cost"
  | "failure-mode";

export interface TransitionPrediction {
  readonly id: string;
  readonly actionClass: string;
  readonly target: TransitionTarget;
  readonly predictedValue: string | number | boolean;
  readonly confidence: number;
  readonly modelVersion: string;
  readonly authority: "none";
}

/** Exact host state and lossy associative/model state stay physically distinct. */
export class SharedWorldState {
  readonly #gate: HostGate;
  readonly #facts = new Map<string, ExactWorldFact>();
  readonly #attention: HrrAttentionCandidate[] = [];
  readonly #predictions: TransitionPrediction[] = [];

  constructor(gate: HostGate) {
    this.#gate = gate;
  }

  observeExact(key: string, value: unknown, receipt: HostReceipt): ExactWorldFact {
    requireHostReceipt(
      this.#gate,
      receipt,
      ["artifact-harvested", "decision-recorded", "official-verification", "transition-observed"],
    );
    const fact = immutable({
      key,
      value,
      valueDigest: digest(value),
      observedByReceiptId: receipt.id,
      authority: "host" as const,
    });
    this.#facts.set(key, fact);
    return fact;
  }

  rememberAttention(candidate: HrrAttentionCandidate): HrrAttentionCandidate {
    if (candidate.authority !== "none") {
      throw new Error("HRR attention can never be authoritative evidence");
    }
    if (candidate.similarity < -1 || candidate.similarity > 1) {
      throw new RangeError("HRR similarity must be between -1 and 1");
    }
    const frozen = immutable(candidate);
    this.#attention.push(frozen);
    return frozen;
  }

  predictTransition(prediction: TransitionPrediction): TransitionPrediction {
    if (prediction.authority !== "none") {
      throw new Error("Transition predictions can never be authoritative evidence");
    }
    if (prediction.confidence < 0 || prediction.confidence > 1) {
      throw new RangeError("Prediction confidence must be between zero and one");
    }
    const frozen = immutable(prediction);
    this.#predictions.push(frozen);
    return frozen;
  }

  exact(key: string): ExactWorldFact | undefined {
    return this.#facts.get(key);
  }

  snapshot(): Readonly<{
    exact: readonly ExactWorldFact[];
    attention: readonly HrrAttentionCandidate[];
    predictions: readonly TransitionPrediction[];
  }> {
    return immutable({
      exact: [...this.#facts.values()],
      attention: this.#attention,
      predictions: this.#predictions,
    });
  }
}
