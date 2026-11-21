import unittest
from unittest.mock import patch

from assistance import Assistance, BRIEF, select_skill
from mission_skill import preview
from worlds import make_case


class AssistanceTests(unittest.TestCase):
    def test_only_matching_card_and_no_system_treatment(self):
        self.assertEqual(select_skill("Prepare an April close using settled Neon gifts."),"reconcile")
        self.assertIsNone(select_skill("Draft a new quote."))
        helper=Assistance("skills-no-system","reconcile")
        messages=[{"role":"system","content":"control protocol"},{"role":"user","content":"Run the close."}]
        with patch("assistance.run.model_request", return_value=({},{})) as infer:
            helper.parent("url","token","model",messages,[])
        forwarded=infer.call_args.args[3]
        self.assertEqual([m["role"] for m in forwarded],["user"])
        self.assertIn("Reconcile two record sets",forwarded[0]["content"])
        self.assertEqual(messages[1]["content"],"Run the close.")

    def test_one_brief_with_shared_budget_and_no_mutation(self):
        assist=Assistance("sol",None)
        world=assist.world(make_case("missions","test"),True)
        brief={k:"synthetic detail" for k in BRIEF}
        with patch("assistance.coach_call",return_value=("Check the revision.",{})) as coach:
            self.assertIn("error",world.call("ask_coach",{"history":"wrong shape"},0))
            self.assertIn("advice",world.call("ask_coach",brief,0))
            self.assertIn("error",world.call("ask_coach",brief,1))
            coach.assert_called_once_with("sol",brief)
        self.assertEqual(assist.requests.total(),1)
        self.assertEqual(world.rev,0)

    def test_mission_preview_preserves_unknown_and_uses_all_pages(self):
        data={"missions":[{"id":i,"project":"demo","objective":"audit"} for i in range(5)],
              "receipts":[{"id":0,"seq":3,"state":"active"},{"id":0,"seq":1,"state":"old"},
                          {"id":1,"seq":3,"state":"closed"},{"id":1,"seq":3,"state":"active"},
                          {"id":2,"seq":1,"state":"active"},{"id":3,"seq":1,"state":"closed"}]}
        def read(resource,cursor):
            rows=data[resource]
            return {"rows":rows[cursor:cursor+2],"next_cursor":cursor+2 if cursor+2<len(rows) else None}
        args={"project":"demo","objective":"audit","states":["active"],"exclude_ids":[2]}
        self.assertEqual(preview(read,args),{"matched_ids":[0],"other_ids":[2,3],"unresolved_ids":[1,4]})

if __name__=="__main__":
    unittest.main()
