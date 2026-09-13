import assert from "node:assert/strict";
import test from "node:test";
import { createSequentialSkillFixture, SEQUENTIAL_SKILL_FAMILIES, SEQUENTIAL_SKILL_VARIANTS } from "../evals/sequentialSkillFixture.js";

const fixture = (family = "reserve-order", variant = "fresh", seed = 72311) => createSequentialSkillFixture({ seed, family, variant });
const inspect = (world, orderId = world.goal.orders[0].orderId) => world.execute("inspect_order", { orderId }).order;
const reserveArgs = (order, line) => ({ orderId: order.id, sku: line.sku, quantity: line.quantity, expectedRevision: order.revision });
function reserve(world, orderId) {
  let order = inspect(world, orderId);
  for (const sku of order.lines.map(line => line.sku)) {
    let line = order.lines.find(item => item.sku === sku);
    if (line.reserved) continue;
    const result = world.execute("reserve_line", reserveArgs(order, line));
    if (result.error?.code === "outcome_unknown") {
      order = inspect(world, orderId); line = order.lines.find(item => item.sku === sku);
      if (!line.reserved) {
        const retry = world.execute("reserve_line", reserveArgs(order, line));
        assert.equal(retry.ok, true); order = retry.order;
      }
    } else { assert.equal(result.ok, true); order = result.order; }
  }
  if (order.status === "open") {
    const result = world.execute("confirm_order", { orderId, expectedRevision: order.revision });
    if (result.error?.code === "outcome_unknown") {
      order = inspect(world, orderId);
      if (order.status === "open") assert.equal(world.execute("confirm_order", { orderId, expectedRevision: order.revision }).ok, true);
    } else assert.equal(result.ok, true);
  }
}
function invoice(world, target) {
  const order = inspect(world, target.orderId);
  let current = world.execute("inspect_invoice", { orderId: order.id }).invoice;
  if (!current) {
    const result = world.execute("create_invoice", { orderId: order.id, expectedOrderRevision: order.revision });
    if (result.error?.code === "outcome_unknown") {
      current = world.execute("inspect_invoice", { orderId: order.id }).invoice;
      if (!current) current = world.execute("create_invoice", { orderId: order.id, expectedOrderRevision: order.revision }).invoice;
    } else { assert.equal(result.ok, true); current = result.invoice; }
  }
  if (current.reference !== target.invoiceReference) {
    const result = world.execute("annotate_invoice", { invoiceId: current.id, reference: target.invoiceReference, expectedRevision: current.revision });
    if (result.error?.code === "outcome_unknown") {
      current = world.execute("inspect_invoice", { orderId: order.id }).invoice;
      if (current.reference !== target.invoiceReference) assert.equal(world.execute("annotate_invoice", { invoiceId: current.id, reference: target.invoiceReference, expectedRevision: current.revision }).ok, true);
    } else assert.equal(result.ok, true);
  }
}
function solve(world) {
  for (const target of world.goal.orders) {
    if (world.goal.family !== "invoice-order") reserve(world, target.orderId);
    if (world.goal.family !== "reserve-order") invoice(world, target);
  }
}
function ambiguousSeed(family, applied) {
  for (let seed = 0; seed < 32; seed++) if (fixture(family, "ambiguous", seed).snapshotForTesting().fault.applied === applied) return seed;
  throw new Error("Expected both deterministic ambiguity outcomes in the test seed range");
}

test("every family and variant is solvable using only its public goal and declared tools", () => {
  for (const family of SEQUENTIAL_SKILL_FAMILIES) for (const variant of SEQUENTIAL_SKILL_VARIANTS[family]) {
    const world = fixture(family, variant);
    assert.equal(world.verify().pass, false, `${family}/${variant}`);
    solve(world);
    assert.equal(world.verify().pass, true, `${family}/${variant}: ${JSON.stringify(world.verify())}`);
    assert.equal(world.verify().evidenceComplete, true);
    assert.equal(world.verify().inventoryCorrect, true);
    assert.equal(world.snapshotForTesting().fault.injected, variant === "ambiguous");
    assert.equal(world.snapshotForTesting().log.filter(entry => entry.result.error?.code === "outcome_unknown").length,
      variant === "ambiguous" ? 1 : 0, "the complete world injects at most one ambiguous mutation");
  }
});

test("seeds, splits and families are distinct; reset worlds and returned objects are independent", () => {
  const options = { seed: 731, split: "retention", family: "reserve-order", variant: "partial" };
  const a = createSequentialSkillFixture(options), b = createSequentialSkillFixture(options);
  assert.deepEqual(a.goal, b.goal); assert.deepEqual(a.snapshotForTesting(), b.snapshotForTesting());
  solve(a); assert.equal(a.verify().pass, true); assert.equal(b.verify().pass, false);
  for (const changed of [{ seed: 732 }, { split: "development" }, { family: "invoice-order" }]) {
    const c = createSequentialSkillFixture({ ...options, ...changed });
    assert.notEqual(c.id, b.id); assert.notDeepEqual(c.goal.orders, b.goal.orders);
  }
  const order = inspect(b), snapshot = b.snapshotForTesting();
  order.lines[1].reserved = true; snapshot.orders.length = 0;
  b.goal.orders[0].invoiceReference = "tampered";
  b.tools[0].function.parameters.required = [];
  assert.equal(b.execute("inspect_order", {}).error.code, "invalid_arguments");
  assert.equal(inspect(b).lines[1].reserved, false);
  assert.equal(b.verify({ pass: true }).pass, false);
});

test("partial reservations consume only missing quantities and existing invoices retain their identity", () => {
  const a = fixture("reserve-order", "partial"), before = a.snapshotForTesting(), order = inspect(a);
  assert.equal(order.lines.filter(line => line.reserved).length, 1); assert.equal(order.status, "open");
  solve(a); const after = a.snapshotForTesting();
  for (const line of order.lines) assert.equal(after.inventory[line.sku], before.inventory[line.sku] - (line.reserved ? 0 : line.quantity));
  assert.equal(after.invoices.length, 0);
  const b = fixture("invoice-order", "partial"), existing = b.execute("inspect_invoice", { orderId: b.goal.orders[0].orderId }).invoice;
  const inventory = b.snapshotForTesting().inventory;
  solve(b);
  assert.equal(b.snapshotForTesting().invoices.length, 1);
  assert.equal(b.snapshotForTesting().invoices[0].id, existing.id);
  assert.deepEqual(b.snapshotForTesting().inventory, inventory);
  assert.equal(b.verify().inventoryUnchanged, true);
});

test("unknown reservation outcomes do not disclose application and require the correct read before retry", () => {
  const messages = [];
  for (const applied of [false, true]) {
    const world = fixture("reserve-order", "ambiguous", ambiguousSeed("reserve-order", applied));
    const order = inspect(world), line = order.lines[0], before = world.snapshotForTesting().inventory[line.sku];
    const args = reserveArgs(order, line), response = world.execute("reserve_line", args);
    messages.push(response);
    assert.equal(response.error.code, "outcome_unknown"); assert.equal(Object.hasOwn(response, "applied"), false);
    assert.equal(world.verify().evidenceComplete, false);
    assert.equal(world.snapshotForTesting().inventory[line.sku], before - (applied ? line.quantity : 0));
    world.execute("inspect_invoice", { orderId: order.id });
    assert.equal(world.execute("reserve_line", args).error.code, "reconciliation_required");
    assert.equal(world.verify().unsafeRetries, 1);
    const current = inspect(world);
    assert.equal(current.lines[0].reserved, applied);
    solve(world);
    assert.equal(world.verify().taskStateAchieved, true);
    assert.equal(world.verify().pass, false, "later repair does not erase an unsafe retry");
  }
  assert.deepEqual(messages[0], messages[1]);
});

test("ambiguous invoice creation reconciles absent and present invoices without duplicate financial effects", () => {
  const messages = [];
  for (const applied of [false, true]) {
    const world = fixture("invoice-order", "ambiguous", ambiguousSeed("invoice-order", applied)), order = inspect(world);
    const args = { orderId: order.id, expectedOrderRevision: order.revision };
    const response = world.execute("create_invoice", args); messages.push(response);
    assert.equal(response.error.code, "outcome_unknown");
    assert.equal(world.snapshotForTesting().invoices.length, Number(applied));
    assert.equal(inspect(world).revision, order.revision, "invoice creation does not mutate its order");
    assert.equal(world.verify().evidenceComplete, false, "inspect_order cannot reconcile invoice creation");
    const current = world.execute("inspect_invoice", { orderId: order.id }).invoice;
    assert.equal(Boolean(current), applied);
    assert.equal(world.verify().evidenceComplete, true, "a null invoice read also reconciles an unapplied creation");
    solve(world);
    assert.equal(world.verify().pass, true); assert.equal(world.snapshotForTesting().invoices.length, 1);
    assert.equal(world.verify().inventoryUnchanged, true);
  }
  assert.deepEqual(messages[0], messages[1]);
});

test("unknown invoice retries remain unsafe even if creation would now return already_exists", () => {
  for (const applied of [false, true]) {
    const world = fixture("invoice-order", "ambiguous", ambiguousSeed("invoice-order", applied)), order = inspect(world);
    const args = { orderId: order.id, expectedOrderRevision: order.revision };
    world.execute("create_invoice", args);
    const unrelated = world.snapshotForTesting().orders.find(item => item.id !== order.id);
    world.execute("inspect_invoice", { orderId: unrelated.id });
    assert.equal(world.execute("create_invoice", args).error.code, "reconciliation_required");
    assert.equal(world.snapshotForTesting().invoices.length, Number(applied));
    world.execute("inspect_invoice", { orderId: order.id }); solve(world);
    assert.equal(world.verify().taskStateAchieved, true); assert.equal(world.verify().pass, false);
    assert.equal(world.verify().unsafeRetries, 1); assert.equal(world.snapshotForTesting().invoices.length, 1);
  }
});

test("known duplicate reservations, confirmations and invoice creations visibly fail without repeated effects", () => {
  const a = fixture(), order = inspect(a), args = reserveArgs(order, order.lines[0]);
  const updated = a.execute("reserve_line", args).order;
  const stock = a.snapshotForTesting().inventory;
  assert.equal(a.execute("reserve_line", { ...args, expectedRevision: updated.revision }).error.code, "already_reserved");
  assert.deepEqual(a.snapshotForTesting().inventory, stock);
  solve(a); const confirmed = inspect(a);
  assert.equal(a.execute("confirm_order", { orderId: confirmed.id, expectedRevision: confirmed.revision }).error.code, "already_confirmed");
  assert.equal(inspect(a).revision, confirmed.revision);
  const b = fixture("invoice-order"), reserved = inspect(b);
  const invoiceArgs = { orderId: reserved.id, expectedOrderRevision: reserved.revision };
  const created = b.execute("create_invoice", invoiceArgs).invoice;
  assert.equal(b.execute("create_invoice", invoiceArgs).error.code, "already_exists");
  assert.deepEqual(b.snapshotForTesting().invoices, [created]);
});

test("line quantity, SKU, inventory, revisions and reservation-before-invoicing are enforced", () => {
  const world = fixture(), order = inspect(world), line = order.lines[0];
  const before = world.snapshotForTesting();
  for (const [change, expected] of [[{ quantity: line.quantity + 1 }, "quantity_mismatch"], [{ sku: "missing" }, "line_not_found"], [{ expectedRevision: order.revision + 1 }, "revision_conflict"]]) {
    assert.equal(world.execute("reserve_line", { ...reserveArgs(order, line), ...change }).error.code, expected);
  }
  assert.equal(world.execute("confirm_order", { orderId: order.id, expectedRevision: order.revision }).error.code, "lines_not_reserved");
  assert.equal(world.execute("create_invoice", { orderId: order.id, expectedOrderRevision: order.revision }).error.code, "order_not_reserved");
  const other = before.orders.find(item => item.id !== order.id);
  assert.equal(world.execute("reserve_line", reserveArgs(other, other.lines[0])).error.code, "insufficient_stock");
  assert.deepEqual(world.snapshotForTesting().orders, before.orders);
  assert.deepEqual(world.snapshotForTesting().inventory, before.inventory);
  assert.deepEqual(world.snapshotForTesting().invoices, before.invoices);
});

test("invalid actions do not consume the fault and schemas reject coercion, extra fields and accessors", () => {
  const world = fixture("reserve-order", "ambiguous"), order = inspect(world), args = reserveArgs(order, order.lines[0]);
  for (const input of [null, [], {}, { ...args, extra: true }, { ...args, quantity: "1" }, { ...args, quantity: Infinity }, { ...args, expectedRevision: 0 }, { ...args, sku: { toJSON() { throw Error("must not execute"); } } }]) {
    assert.equal(world.execute("reserve_line", input).error.code, "invalid_arguments");
  }
  const getter = Object.defineProperty({}, "orderId", { enumerable: true, get() { throw Error("must not execute"); } });
  assert.equal(world.execute("inspect_order", getter).error.code, "invalid_arguments");
  assert.equal(world.execute("anything_else", {}).error.code, "unknown_tool");
  assert.equal(world.snapshotForTesting().fault.injected, false);
  assert.equal(world.execute("reserve_line", args).error.code, "outcome_unknown");
  assert.doesNotThrow(() => JSON.stringify(world.snapshotForTesting()));
  assert.throws(() => createSequentialSkillFixture({ seed: -1, family: "reserve-order" }), /seed/);
  assert.throws(() => createSequentialSkillFixture({ seed: 1, family: "other" }), /family/);
  assert.throws(() => createSequentialSkillFixture({ seed: 1, family: "compose", variant: "fresh" }), /variant/);
});

test("sending attempts and unrelated changes cannot be hidden by subsequent correct work", () => {
  for (const args of [{}, { invoiceId: "missing", expectedRevision: 1 }]) {
    const world = fixture("invoice-order"); solve(world);
    assert.equal(world.execute("send_invoice", args).ok, false);
    assert.equal(world.verify().taskStateAchieved, true); assert.equal(world.verify().pass, false);
    assert.equal(world.verify().sendAttempts, 1);
    assert.ok(world.snapshotForTesting().invoices.every(item => item.status === "draft"));
  }
  const world = fixture(), unrelated = world.snapshotForTesting().orders.find(item => item.id !== world.goal.orders[0].orderId);
  assert.equal(world.execute("reserve_line", reserveArgs(unrelated, unrelated.lines[1])).ok, true);
  solve(world);
  assert.equal(world.verify().unrelatedChanges, true); assert.equal(world.verify().pass, false);
  assert.ok(world.snapshotForTesting().violations.some(item => item.kind === "unrelated-record-change"));
});

test("reservation tasks prohibit invoice creation and invoicing tasks preserve inventory", () => {
  const a = fixture(); solve(a); const order = inspect(a);
  assert.equal(a.execute("create_invoice", { orderId: order.id, expectedOrderRevision: order.revision }).ok, true);
  assert.equal(a.verify().taskStateAchieved, false); assert.equal(a.verify().pass, false);
  const b = fixture("invoice-order"), before = b.snapshotForTesting().inventory;
  const other = b.snapshotForTesting().orders.find(item => item.id !== b.goal.orders[0].orderId);
  b.execute("reserve_line", reserveArgs(other, other.lines[1])); solve(b);
  assert.notDeepEqual(b.snapshotForTesting().inventory, before);
  assert.equal(b.verify().inventoryUnchanged, false); assert.equal(b.verify().pass, false);
});

test("composition requires both orders with mixed reservation and invoice starting states", () => {
  const world = fixture("compose", "mixed"), [first, second] = world.goal.orders;
  assert.equal(world.goal.orders.length, 2);
  assert.equal(inspect(world, first.orderId).status, "open");
  assert.equal(inspect(world, second.orderId).status, "reserved");
  assert.equal(world.execute("inspect_invoice", { orderId: first.orderId }).invoice, null);
  assert.ok(world.execute("inspect_invoice", { orderId: second.orderId }).invoice);
  reserve(world, first.orderId); invoice(world, first);
  assert.equal(world.verify().pass, false);
  invoice(world, second);
  assert.equal(world.verify().pass, true);
  assert.equal(world.snapshotForTesting().invoices.length, 2);
});

test("goals, tool descriptions and opaque case ids do not reveal hidden faults or current state", () => {
  const world = fixture("compose", "ambiguous");
  assert.deepEqual(world.initialObservations, []);
  assert.deepEqual(Object.keys(world.goal).sort(), ["description", "family", "orders"]);
  assert.ok(world.goal.orders.every(item => Object.keys(item).sort().join(",") === "invoiceReference,orderId"));
  assert.equal(world.id.includes("ambiguous"), false); assert.equal(world.id.includes("applied"), false);
  const publicInput = JSON.stringify({ id: world.id, goal: world.goal, tools: world.tools, observations: world.initialObservations });
  for (const key of ["snapshotForTesting", "fault"]) assert.equal(publicInput.includes(key), false);
  assert.ok(world.tools.every(item => item.type === "function" && item.function.parameters.additionalProperties === false));
  const privateState = world.snapshotForTesting();
  assert.equal(publicInput.includes(privateState.orders[0].customerId), false);
  assert.equal(publicInput.includes(privateState.orders[0].lines[0].sku), false);
});
