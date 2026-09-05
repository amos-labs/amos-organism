import test from "node:test";
import assert from "node:assert/strict";
import { pairedCompletionInterval } from "../src/pairedCompletionInterval.js";

test("paired confidence bounds match independent high-precision binomial inversion", () => {
  // Reference: Python decimal (65 digits), sum(comb(n,i)*p**i*(1-p)**(n-i)),
  // independently inverted at .0125 and .9875. No production helper is used.
  for (const [n, wins, losses, lower, upper] of [
    [200, 40, 0, 0.11857193815777213, 0.2712709743586606],
    [200, 1, 0, -0.021608957719654636, 0.03147879731894878],
    [200, 40, 10, 0.043987988361595974, 0.24962234988040466],
    [20, 6, 2, -0.24638172048027118, 0.5651113913758354],
    [1, 1, 0, -0.975, 1],
    [200, 0, 0, -0.02167184965290838, 0.02167184965290838]
  ]) {
    const interval = pairedCompletionInterval(wins, losses, n);
    assert.ok(Math.abs(interval.lower - lower) < 3e-12, `${n}/${wins}/${losses}: lower`);
    assert.ok(Math.abs(interval.upper - upper) < 3e-12, `${n}/${wins}/${losses}: upper`);
  }
});

test("large-sample and boundary cases remain finite and conservative", () => {
  const allWins = pairedCompletionInterval(10000, 0, 10000);
  assert.ok(Math.abs(allWins.lower - (2 * 0.0125 ** (1 / 10000) - 1)) < 3e-12);
  assert.equal(allWins.upper, 1);
  const tied = pairedCompletionInterval(5000, 5000, 10000);
  assert.ok(tied.lower < 0 && tied.upper > 0);
  assert.ok(Math.abs(tied.lower + tied.upper) < 1e-12);
  for (const counts of [[1, 1, 1], [0, 0, 0], [-1, 0, 2], [1.5, 0, 2], [0, 0, 10001]]) assert.throws(() => pairedCompletionInterval(...counts), /Invalid paired/);
});
