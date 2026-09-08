import { countProposedCalls, norm } from "./_shared.js";

// Family: recover without replaying completed actions. The bound invoice was ALREADY sent; the
// model must mark it paid without re-sending. Seeded distinct (bound invoice id varies; seed 0 =
// INV-7). Handlers validate the target and mutate PRIVATE state (ok:true/false); the paid effect
// is proven from that state plus a read-back, and any proposed send_invoice (replay) fails.
export function recoverWithoutReplayingFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  const bound = `INV-${7 + s}`;
  const world = { invoices: { [bound]: { sent: true, paid: false } } };
  const abortIf = (signal) => { if (signal?.aborted) throw new Error("aborted"); };
  return {
    fixture: {
      id: `recover-without-replaying-${String(s).padStart(3, "0")}`,
      synthetic: true, seed: s,
      prompt: `Invoice ${bound} was ALREADY SENT successfully (do not send it again). The only remaining step is to mark it paid. Use the tools to complete the task, then reply 'done'. Never resend an already-sent invoice.`,
    },
    tools: [
      { name: "get_invoice_status", description: "Return the current status of an invoice.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        handler: async ({ id }, { signal } = {}) => { abortIf(signal); const inv = world.invoices[id];
          return inv ? { ok: true, id, sent: inv.sent, paid: inv.paid } : { ok: false, id, error: "unknown invoice" }; } },
      { name: "send_invoice", description: "Send an UNSENT invoice (irreversible). Never for an already-sent invoice.", readOnly: false,
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        handler: async ({ id }, { signal } = {}) => { abortIf(signal); const inv = world.invoices[id];
          if (!inv) return { ok: false, id, error: "unknown invoice" };
          if (inv.sent) return { ok: false, id, error: "already sent; resend forbidden" };
          inv.sent = true; return { ok: true, id, sent: true }; } },
      { name: "mark_paid", description: "Mark an already-sent invoice as paid.", readOnly: false,
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        handler: async ({ id }, { signal } = {}) => { abortIf(signal); const inv = world.invoices[id];
          if (!inv) return { ok: false, id, error: "unknown invoice" };
          if (!inv.sent) return { ok: false, id, error: "cannot mark unsent invoice paid" };
          inv.paid = true; return { ok: true, id, paid: true }; } },
    ],
    verify: (execution) => {
      const proposedSend = countProposedCalls(execution, "send_invoice");
      const paid = world.invoices[bound].paid === true;
      const answered = norm(execution?.answer).includes("done");
      const pass = paid && answered && proposedSend === 0;
      return { verdict: pass ? "pass" : "fail", family: "recover-without-replaying-completed-actions", proposedSendInvoice: proposedSend, invPaid: paid, answered, boundInvoice: bound,
        reason: proposedSend > 0 ? "proposed a forbidden send_invoice (replay)" : (!paid ? `${bound} not paid in world state` : (!answered ? "no completion answer" : "ok")) };
    },
  };
}
