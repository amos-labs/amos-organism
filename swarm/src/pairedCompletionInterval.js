export const PAIRED_COMPLETION_INTERVAL_METHOD = "paired-bonferroni-clopper-pearson";

/** A conservative 95% interval for P(candidate-only pass) - P(base-only pass).
 * Each discordant cell gets a 97.5% exact binomial interval. Bonferroni gives
 * simultaneous coverage of at least 95%, without assuming the cells independent.
 * The sampling unit is one independent task pair, including concordant pairs.
 */
export function pairedCompletionInterval(wins, losses, pairs) {
  if (![wins, losses, pairs].every(Number.isSafeInteger) || pairs < 1 || pairs > 10000 || wins < 0 || losses < 0 || wins + losses > pairs) {
    throw Error("Invalid paired completion counts");
  }
  const win = binomialInterval(wins, pairs), loss = binomialInterval(losses, pairs);
  return {
    method: PAIRED_COMPLETION_INTERVAL_METHOD, confidenceLevel: 0.95,
    lower: Math.max(-1, win.lower - loss.upper),
    upper: Math.min(1, win.upper - loss.lower)
  };
}

function binomialInterval(successes, trials) {
  // Two marginal intervals, two tails each: 0.05 / 4 per tail.
  const tail = 0.0125;
  return {
    lower: successes === 0 ? 0 : Math.max(0, invertCdf(successes - 1, trials, 1 - tail) - 1e-12),
    upper: successes === trials ? 1 : Math.min(1, invertCdf(successes, trials, tail) + 1e-12)
  };
}

function invertCdf(k, n, target) {
  let lower = 0, upper = 1;
  for (let i = 0; i < 60; i++) {
    const middle = (lower + upper) / 2;
    if (binomialCdf(k, n, middle) > target) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

function binomialCdf(k, n, p) {
  // Sum relative to the mode. Starting at P(X=0) underflows for large n.
  const mode = Math.floor((n + 1) * p);
  let total = 1, below = mode <= k ? 1 : 0, weight = 1;
  for (let i = mode; i > 0; i--) {
    weight *= i * (1 - p) / ((n - i + 1) * p);
    total += weight;
    if (i - 1 <= k) below += weight;
  }
  weight = 1;
  for (let i = mode; i < n; i++) {
    weight *= (n - i) * p / ((i + 1) * (1 - p));
    total += weight;
    if (i + 1 <= k) below += weight;
  }
  return below / total;
}
