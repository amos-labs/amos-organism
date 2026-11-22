"""Exercise real grading, including both outcomes of a lost acknowledgment."""
import copy
import json
import unittest
from unittest.mock import patch

import run
from corpus_challenges import account_switch, training_packet
from donation_close import donation_close
from worlds import FAMILIES, make_case


def scripted_run(family, commit, mistake=None):
    seed = "verifier-only"
    case = make_case(family, seed)
    responses = []

    def call(name, args):
        responses.append({"role": "assistant", "content": None, "tool_calls": [
            {"id": f"call_{len(responses)}", "type": "function",
             "function": {"name": name, "arguments": json.dumps(args)}}]})

    for phase, answer in enumerate(case.answers):
        document = copy.deepcopy(answer)
        if mistake == "wrong-field" and phase == 0:
            document["unexpected"] = 1
        call("save_draft", {"revision": phase, "document": document})
        if phase == 1 and mistake == "blind-retry":
            call("save_draft", {"revision": phase, "document": document})
        if mistake != "skip-receipt":
            call("receipt", {})
        if phase == 1 and not commit:
            call("save_draft", {"revision": phase, "document": document})
            call("receipt", {})
        if phase == 1 and case.assignments and mistake != "skip-action":
            for ticket in case.assignments[phase]:
                call("nuvola_assign", {"ticket": ticket})
                call("nuvola_assignment_ledger", {})
                if commit:
                    call("nuvola_assign", {"ticket": ticket})
                    call("nuvola_assignment_ledger", {})
        if mistake == "send" and phase == 0:
            call("execute", {"action": "notify"})
        responses.append({"role": "assistant", "content": "Done."})

    def next_response(*args):
        message = responses.pop(0)
        return {"message": message, "finish_reason": "tool_calls" if "tool_calls" in message else "stop"}, {}

    with patch.object(run, "model_request", side_effect=next_response):
        return run.run_case("unused", "", "script", family, seed, commit)


class TestWorkflows(unittest.TestCase):
    def test_reference_solves_every_world_in_both_fault_modes(self):
        for family in FAMILIES:
            for committed in [True, False]:
                with self.subTest(family=family, committed=committed):
                    self.assertTrue(scripted_run(family, committed)["passed"])

    def test_grader_rejects_repaired_first_turn_or_unverified_writes(self):
        for mistake in ["wrong-field", "skip-receipt", "blind-retry", "send", "skip-action"]:
            with self.subTest(mistake=mistake):
                self.assertFalse(scripted_run("handoff", True, mistake)["passed"])

    def test_database_derived_reserve_worlds_are_solvable(self):
        reserve = {f.__name__: f for f in (account_switch, training_packet, donation_close)}
        with patch.dict(FAMILIES, reserve):
            for family in reserve:
                for committed in (True, False):
                    with self.subTest(family=family, committed=committed):
                        self.assertTrue(scripted_run(family, committed)["passed"])

    def test_order_is_irrelevant_but_types_and_duplicate_ids_matter(self):
        self.assertTrue(run.same({"ids": [1, 2]}, {"ids": [2, 1]}))
        self.assertFalse(run.same([1, 1, 2], [2, 1]))
        self.assertFalse(run.same({"notify": 0}, {"notify": False}))

    def test_generated_answers_match_independently_calculated_fixture(self):
        for seed in ["alpha", "beta", "gamma"]:
            case = make_case("quote", seed)
            terms, = case.files["amos.quote_terms"]
            brief, = case.files["workspace.brief"]
            rate = max(case.files["amos.rate_card"], key=lambda r:r["rev"])["seat_month_cents"]
            from decimal import Decimal, ROUND_HALF_UP
            for phase, discount in enumerate([Decimal(1), Decimal("0.85")]):
                seats = brief["seats"] + 3 * phase - terms["included_seats"]
                net = (rate * seats * discount).quantize(Decimal(1), ROUND_HALF_UP)
                tax = (net * terms["tax_basis_points"]/10000).quantize(Decimal(1), ROUND_HALF_UP)
                self.assertEqual(case.answers[phase]["term_total"], terms["setup_cents"] + brief["months"] * (net+tax))

    def test_donation_close_balances_against_each_source(self):
        with patch.dict(FAMILIES, {"donation_close": donation_close}):
            for seed in ("alpha", "beta", "gamma"):
                case = make_case("donation_close", seed)
                for expected in case.answers:
                    gifts = {row["gift"]: row["cents"] for row in case.files["amos.neon_gifts"]
                             if row["campaign"] == expected["campaign"] and row["state"] == "settled"
                             and row["period"] == 4}
                    balances = {gift: 0 for gift in gifts}
                    for entry in case.files["amos.quickbooks_entries"]:
                        if entry["gift"] in gifts and entry["period"] == 4 and entry["state"] == "posted":
                            balances[entry["gift"]] += entry["cents"]
                    self.assertEqual(expected["gift_cents"], sum(gifts.values()))
                    self.assertEqual(expected["posted_cents"], sum(balances.values()))
                    self.assertEqual(expected["difference_cents"], sum(gifts.values()) - sum(balances.values()))
                    self.assertEqual(set(expected["unmatched"]), {g for g in gifts if gifts[g] != balances[g]})

    def test_sources_are_paged_and_scoped(self):
        case=make_case("support","page-test")
        world=run.World(case,True)
        self.assertIn("error",world.call("amos_read",{"resource":"support"},0))
        cursor=0
        seen=[]
        while cursor is not None:
            page=world.call("nuvola_read",{"resource":"support","cursor":cursor},0)
            seen.extend(page["rows"])
            cursor=page["next_cursor"]
        self.assertEqual(seen,case.files["nuvola.support"])


if __name__ == "__main__":
    unittest.main()
