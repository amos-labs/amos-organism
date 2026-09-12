import { norm, datasetDigest } from "./_shared.js";

// Family: async-code reasoning. N independent async tasks run CONCURRENTLY via Promise.all; the
// wall-clock time is the MAX individual duration (not the sum, which is the sequential await-loop
// time). The model must read the per-task durations and report the concurrent total in ms.
// Seeded distinct (durations vary; seed 0 fixed). Strict bare-integer answer.
export function asyncCodeFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  const n = 3 + (s % 3); // 3..5 tasks
  const durations = Array.from({ length: n }, (_, k) => 40 + ((k * 37 + s * 53) % 260)); // ms, 40..299
  return asyncCodeFromDurations({ durations, id: `async-code-${String(s).padStart(3, "0")}`, seed: s });
}

// Shared native concurrency contract for authored development durations. Fresh tool closure and
// private read flag per invocation; the durations are not in the prompt.
export function asyncCodeFromDurations({ durations, id, seed = null }) {
  if (!Array.isArray(durations) || durations.length === 0 || durations.length > 1000) throw new TypeError("bounded nonempty durations required");
  for (const d of durations) if (!Number.isSafeInteger(d) || d < 0) throw new TypeError("durations must be non-negative safe integers");
  durations = durations.slice();
  if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new TypeError("fixture id required");
  const n = durations.length;
  const concurrentMs = Math.max(...durations); // Promise.all wall time = slowest task
  const sequentialMs = durations.reduce((sum, d) => sum + d, 0); // the await-in-loop trap answer
  const world = { readDurations: false };
  return {
    fixture: {
      id,
      synthetic: true, seed,
      datasetDigest: datasetDigest({ family: "async-code", durations }),
      prompt: `A function starts ${n} independent async tasks and awaits them together with Promise.all (they run concurrently, not one after another). Each task's duration in milliseconds is available from the tool. Report the total wall-clock time in ms for the concurrent run as a bare integer, no words.`,
    },
    tools: [
      { name: "get_task_durations", description: "Return the duration in ms of each of the concurrent tasks.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_a, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted"); world.readDurations = true; return { ok: true, durationsMs: durations.slice() }; } },
    ],
    verify: (execution) => {
      const answer = norm(execution?.answer);
      const isBareInteger = /^(?:0|[1-9][0-9]*)$/.test(answer);
      const got = isBareInteger ? Number(answer) : null;
      const correct = got === concurrentMs && world.readDurations;
      return { verdict: correct ? "pass" : "fail", family: "async-code", expected: concurrentMs, got, readDurations: world.readDurations,
        sequentialTrap: sequentialMs,
        reason: !world.readDurations ? "did not read the task durations" : (!isBareInteger ? "answer is not a bare integer" : (got === sequentialMs ? "summed durations (sequential) instead of the concurrent max" : (got !== concurrentMs ? "wrong concurrent wall time" : "ok"))) };
    },
  };
}
