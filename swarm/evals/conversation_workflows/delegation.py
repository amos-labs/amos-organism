"""Run the two-role delegation treatment on the November workflow baseline."""
import argparse
from collections import Counter
from hashlib import sha256
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit

import run
from corpus_challenges import account_switch, donation_close, training_packet
from worlds import FAMILIES

PARENT = "qwen3.8-27b"
CHILD = "inkling-2-mini"
ROLES = {
    "amos_ops": ("AMOS prospect group changes and mission replacement plans. Resolve eligibility, "
                 "suppression, or mission status from AMOS records and draft a verified change."),
    "nuvola_triage": ("Nuvola support queues and ticket handoffs. Reconstruct the latest ticket state, "
                      "apply coverage rules, and perform an internal assignment only when the user authorizes it."),
}
DELEGATE = run.tool(
    "delegate_agent",
    "Delegate one scoped task to a specialist. " + " ".join(f"{k}: {v}" for k, v in ROLES.items()) +
    " Each can read its own service and the workspace, access the shared draft and return a report. "
    "The parent owns cross-service integration. Work directly on other tasks.",
    {"agent": {"type": "string", "enum": list(ROLES)}, "task": {"type": "string"}}, ["agent", "task"])
ROUTING = (" You are the orchestrator. Use delegate_agent when its described expertise fits the user's work. "
           "You can also work directly. Handoffs share the 12-request phase budget with you. "
           "Use the specialist report and persisted evidence to finish the user's request.")


class Team:
    def __init__(self, infer=run.model_request):
        self.infer = infer
        self.requests = [Counter(), Counter()]
        self.tokens = Counter()
        self.handoffs = []
        self.trace = []
        self.connection = None
        self.world = None

    def make_world(self, case, commit):
        self.world = RoutedWorld(case, commit, self)
        return self.world

    def remaining(self, phase):
        return run.MAX_CALLS - self.requests[phase].total()

    def ask(self, phase, model, messages, tools):
        if self.remaining(phase) <= 0:
            raise run.PhaseBudgetExhausted
        self.requests[phase][model] += 1
        url, token = self.connection
        start = time.monotonic()
        choice, usage = self.infer(url, token, model, messages, tools)
        self.trace.append({"phase": phase, "model": model, "seconds": round(time.monotonic()-start, 3),
                           "finish": choice["finish_reason"]})
        return choice, usage

    def parent_request(self, url, token, model, messages, tools):
        self.connection = (url, token)
        phase = sum(m["role"] == "user" for m in messages) - 1
        system = {"role": "system", "content": messages[0]["content"] + ROUTING}
        return self.ask(phase, model, [system, *messages[1:]], tools)

    def delegate(self, args, phase):
        if not isinstance(args, dict) or not isinstance(args.get("agent"), str) or args["agent"] not in ROLES:
            return {"error": "unknown specialist"}
        role = args["agent"]
        task = args.get("task")
        if not isinstance(task, str) or not task.strip():
            return {"error": "task required"}
        event = {"phase": phase, "agent": role, "task": task, "calls": [], "status": "budget"}
        self.handoffs.append(event)
        case = self.world.case
        allowed = {"workspace_read", "save_draft", "receipt", "execute"}
        if role == "amos_ops":
            allowed.add("amos_read")
        else:
            allowed.update(["nuvola_read", "nuvola_assign", "nuvola_assignment_ledger"])
        tools = [t for t in run.tools_for(case) if t["function"]["name"] in allowed]
        system = (run.SYSTEM + " You are a specialist. " + ROLES[role] +
                  " Stay within your delegated part. For a previously edited draft read its current revision. "
                  "Return a short report of results, evidence, and any work still needed.")
        messages = [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(
            {"user_requests_to_date": list(case.requests[:phase+1]), "delegated_task": task})}]
        report = "Shared request budget reached. Check the persisted effects."
        # Keep a parent request available to integrate the report.
        while self.remaining(phase) > 1:
            choice, usage = self.ask(phase, CHILD, messages, tools)
            self.tokens.update({k: usage.get(k, 0) for k in ("prompt_tokens", "completion_tokens")})
            msg = choice["message"]
            messages.append({k:v for k,v in msg.items() if k in ("role","content","tool_calls","reasoning_content")})
            if choice["finish_reason"] == "length":
                event["status"] = "output_limit"
                report = "Specialist hit its output limit. Check persisted effects."
                break
            if not msg.get("tool_calls"):
                report = msg.get("content") or ""
                event["status"] = "completed"
                break
            for item in msg["tool_calls"]:
                f = item["function"]
                name = f["name"]
                if name not in allowed:
                    result = {"error": "tool outside specialist scope"}
                else:
                    try:
                        params = json.loads(f["arguments"])
                    except (TypeError, ValueError):
                        result = {"error": "invalid JSON arguments"}
                    else:
                        result = self.world.call(name, params, phase)
                event["calls"].append(name + (": " + str(result["error"]) if "error" in result else ""))
                messages.append({"role": "tool", "tool_call_id": item["id"], "content": json.dumps(result)})
        event["report"] = report
        return {"id": f"handoff-{len(self.handoffs)}", "agent": role, "status": event["status"], "report": report}


class RoutedWorld(run.World):
    def __init__(self, case, commit, team):
        super().__init__(case, commit)
        self.team = team

    def call(self, name, args, phase):
        if name == "delegate_agent":
            return self.team.delegate(args, phase)
        return super().call(name, args, phase)


def routed_case(url, token, family, seed, commit):
    team = Team()
    result = run.run_case(url, token, PARENT, family, seed, commit, world_factory=team.make_world,
                          tool_factory=lambda case: [*run.tools_for(case), DELEGATE], request_fn=team.parent_request)
    for k, v in team.tokens.items():
        result["usage"][k] += v
    result.update(handoffs=team.handoffs, requests=team.requests, inference=team.trace,
                  specialist=CHILD, max_tokens=run.OUTPUT_LIMIT, max_calls_per_phase=run.MAX_CALLS)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--arm", choices=("solo","routed"), default="routed")
    parser.add_argument("--cases", type=Path, required=True, help="Original workflow JSONL defining the paired worlds")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    endpoint = urlsplit(args.base_url)
    if endpoint.scheme != "https" and not (endpoint.scheme == "http" and endpoint.hostname in ("localhost","127.0.0.1","::1")):
        parser.error("HTTPS or loopback HTTP required")
    FAMILIES.update({f.__name__: f for f in (account_switch, training_packet, donation_close)})
    run.OUTPUT_LIMIT = 4096
    token = os.environ.get("AMOS_BENCH_API_KEY", "")
    with args.output.open("x") as out:
        for line in args.cases.read_text().splitlines():
            case = json.loads(line)
            family, seed, commit = case["family"], case["seed"], case["timeout_committed"]
            try:
                if args.arm == "routed":
                    result = routed_case(args.base_url, token, family, seed, commit)
                else:
                    result = run.run_case(args.base_url, token, PARENT, family, seed, commit)
            except (OSError, KeyError, IndexError, ValueError) as error:
                result = {"model": PARENT, "family": family, "seed": seed, "invalid": str(error)}
            result.update(arm=args.arm, max_tokens=run.OUTPUT_LIMIT, max_calls_per_phase=run.MAX_CALLS)
            result["core_runner_sha256"] = sha256(Path(run.__file__).read_bytes()).hexdigest()
            result["delegation_runner_sha256"] = sha256(Path(__file__).read_bytes()).hexdigest()
            out.write(json.dumps(result) + "\n")
            out.flush()
            print(seed, family, result.get("passed", result.get("invalid")), len(result.get("handoffs", [])), flush=True)
