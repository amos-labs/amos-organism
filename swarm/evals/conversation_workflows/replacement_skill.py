"""Mission-replacement skill combining instructions with the read-only preview."""
from mission_skill import PREVIEW, PreviewWorld, run

GUIDE = """Mission replacement skill: evaluate the requested project, objective, latest states and user exceptions with preview_mission_replacement before each draft, including a changed request. Its stop and retain lists partition the entire inventory. Copy both lists intact into the draft, including other projects and finished missions in retain. If any IDs are unresolved, explain the missing evidence. Determine the successor and launch permission from the user's instructions, then save and verify the revision."""


class ReplacementWorld(PreviewWorld):
    def call(self, name, args, phase):
        if name != "preview_mission_replacement":
            return super().call(name, args, phase)
        result = super().call("preview_mission_filter", args, phase)
        if "error" in result:
            return result
        return {"stop": result["matched_ids"], "retain": result["other_ids"],
                "unresolved_ids": result["unresolved_ids"]}


def replacement_case(url, token, seed, commit):
    tool=run.tool("preview_mission_replacement",
                  "Compute complete stop and retain lists from the live inventory for a proposed replacement. "
                  "Keep IDs in exclude_ids. This is a read-only preview.",
                  PREVIEW["function"]["parameters"]["properties"], PREVIEW["function"]["parameters"]["required"])

    def request(url, token, model, messages, tools):
        user={**messages[1],"content":messages[1]["content"]+"\n\n"+GUIDE}
        return run.model_request(url,token,model,[messages[0],user,*messages[2:]],tools)

    return run.run_case(url,token,"qwen3.8-27b","missions",seed,commit,world_factory=ReplacementWorld,
                        tool_factory=lambda c:[*run.tools_for(c),tool],request_fn=request)
