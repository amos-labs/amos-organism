import json
import unittest

import run
from delegation import CHILD, PARENT, DELEGATE, Team
from worlds import make_case


def reply(text="", tool=None, arguments=None):
    msg = {"role": "assistant", "content": text}
    if tool:
        msg["tool_calls"] = [{"id": "test", "type": "function", "function": {
            "name": tool, "arguments": json.dumps(arguments or {})}}]
    return {"message": msg, "finish_reason": "tool_calls" if tool else "stop"}, {"completion_tokens": 2}


class DelegationTests(unittest.TestCase):
    def test_delegated_drafts_are_graded_by_the_native_verifier(self):
        case = make_case("support", "verify")
        requests = []
        for phase in range(2):
            requests.extend([
                (PARENT, reply(tool="delegate_agent", arguments={"agent":"nuvola_triage","task":"Prepare the requested draft."})),
                (CHILD, reply(tool="save_draft", arguments={"document":case.answers[phase],"revision":phase})),
                (CHILD, reply(tool="receipt")), (CHILD, reply("Draft verified.")), (PARENT, reply("Done.")),
            ])

        def infer(url, token, model, messages, tools):
            expected, response = requests.pop(0)
            self.assertEqual(model, expected)
            if model == CHILD:
                self.assertTrue(all(t["function"]["name"] not in ("amos_read","delegate_agent") for t in tools))
            return response

        team = Team(infer)
        result = run.run_case("", "", PARENT, "support", "verify", True, world_factory=team.make_world,
                              tool_factory=lambda c: run.tools_for(c)+[DELEGATE], request_fn=team.parent_request)
        self.assertTrue(result["passed"])
        self.assertFalse(requests)
        self.assertEqual([usage.total() for usage in team.requests], [5,5])

    def test_overlong_handoff_leaves_one_parent_call_and_scope_is_enforced(self):
        team = Team(lambda *args: reply(tool="amos_read", arguments={"resource":"forbidden"}))
        team.make_world(make_case("support","verify"), False)
        team.connection = ("", "")
        team.requests[0][PARENT] = 1
        outcome = team.delegate({"agent":"nuvola_triage","task":"Inspect support"}, 0)
        self.assertEqual(outcome["status"], "budget")
        self.assertEqual(team.remaining(0), 1)
        self.assertEqual(team.handoffs[0]["calls"], ["amos_read: tool outside specialist scope"]*10)
        team.ask(0, PARENT, [], [])
        with self.assertRaises(run.PhaseBudgetExhausted):
            team.ask(0, PARENT, [], [])


if __name__ == "__main__":
    unittest.main()
