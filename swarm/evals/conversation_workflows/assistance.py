"""Compare skill cards and optional one-shot advice on synthetic workflow cases."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

import run
from delegation import PARENT
from corpus_challenges import account_switch, donation_close, training_packet
from worlds import FAMILIES

HERE = Path(__file__).resolve().parent
FAMILY_SET = {"missions","support","renewal","account_switch","donation_close","quote"}
SKILLS = (
    (r"mission|support queue", "current-state"),
    (r"renewal|donations?|neon gifts", "reconcile"),
    (r"invoice", "account-switch"),
)
BRIEF = {"goal":"User objective and constraints", "evidence":"Observed facts with any conflict",
         "tried":"Checks or actions already attempted", "question":"Single decision or next check needed"}
ASK = run.tool("ask_coach", "Get a single independent advisory opinion if evidence conflicts, verification failed, "
               "or the next step is unclear. Supply the short synthetic brief. The coach cannot use tools. "
               "You own the task and must check the advice.", {k:{"type":"string","description":v} for k,v in BRIEF.items()},list(BRIEF))
GUIDE = ("Advise the AMOS operator using the supplied synthetic brief only. In at most 100 words, give "
         "a likely explanation, one discriminating next check and what result changes your advice. "
         "Do not claim access, run tools, or perform the user's task.")
COACH_RULE = " You may ask_coach once per workflow after gathering evidence if the next decision is uncertain. You must verify the result yourself."


def select_skill(text):
    for pattern, name in SKILLS:
        if re.search(pattern, text, flags=re.I):
            return name
    return None


def coach_call(arm, brief):
    prompt = json.dumps(brief, ensure_ascii=False)
    if arm == "opus":
        command = [shutil.which("aws") or str(Path.home()/".local/bin/aws"), "bedrock-runtime", "converse",
                   "--profile", os.environ.get("AMOS_BENCH_AWS_PROFILE","amos-benchmark"), "--region","us-east-1",
                   "--model-id","us.anthropic.claude-opus-5-5","--system",json.dumps([{"text":GUIDE}]),
                   "--messages",json.dumps([{"role":"user","content":[{"text":prompt}]}]),
                   "--inference-config",'{"maxTokens":400}',"--output","json"]
        result = subprocess.run(command,capture_output=True,text=True,timeout=100,check=True)
        body=json.loads(result.stdout)
        return "".join(x.get("text","") for x in body["output"]["message"]["content"]),body["usage"]
    command=["codex","exec","--ignore-user-config","--ignore-rules","--ephemeral","--skip-git-repo-check",
             "-s","read-only","--disable","shell_tool","--disable","unified_exec","-c",'web_search="disabled"',
             "-c",'model_reasoning_effort="low"',"-m","gpt-6.2-sol","--json","-"]
    with tempfile.TemporaryDirectory() as empty:
        result=subprocess.run(command,cwd=empty,input=GUIDE+"\n"+prompt,capture_output=True,text=True,timeout=120,check=True)
    events=[json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    items=[e.get("item",{}) for e in events if e.get("type")=="item.completed"]
    if any(x.get("type") not in ("agent_message","reasoning","plan") for x in items):
        raise ValueError("Sol attempted a tool action")
    messages=[x["text"] for x in items if x.get("type")=="agent_message"]
    complete=next(e for e in events if e.get("type")=="turn.completed")
    return messages[-1],complete.get("usage",{})


class Assistance:
    def __init__(self,arm,skill,checkpoint=False):
        self.arm=arm
        self.checkpoint=checkpoint
        self.skill=skill
        self.card=(HERE/"workflow_skills"/(skill+".md")).read_text() if arm in ("skills","skills-no-system") and skill else ""
        self.requests=Counter()
        self.advice=[]
        self.coach_error=None

    def parent(self,url,token,model,messages,tools):
        phase=sum(m["role"]=="user" for m in messages)-1
        if self.requests[phase]>=run.MAX_CALLS:
            raise run.PhaseBudgetExhausted
        self.requests[phase]+=1
        if self.card:
            messages=[messages[0],{**messages[1],"content":messages[1]["content"]+"\n\nAvailable workflow skill:\n"+self.card},*messages[2:]]
        if self.arm == "skills-no-system":
            messages = [m for m in messages if m["role"] != "system"]
        if self.arm in ("opus","sol"):
            rule = COACH_RULE
            if self.checkpoint:
                rule += " This evaluation requires one consultation after reading evidence and before the first draft. Ask a concrete question about your proposed decision."
            messages=[{**messages[0],"content":messages[0]["content"]+rule},*messages[1:]]
        return run.model_request(url,token,model,messages,tools)

    def tools(self,case):
        return run.tools_for(case)+([ASK] if self.arm in ("opus","sol") else [])

    def world(self,case,commit):
        owner=self
        class World(run.World):
            def call(self,name,args,phase):
                if owner.checkpoint and phase==0 and name=="save_draft" and not owner.advice:
                    return {"error":"pre-write advice checkpoint pending"}
                if name!="ask_coach":
                    return super().call(name,args,phase)
                if owner.arm not in ("opus","sol") or owner.advice:
                    return {"error":"consultation unavailable"}
                if owner.requests[phase]>=run.MAX_CALLS-1:
                    return {"error":"insufficient phase budget for a consultation and follow-up"}
                if not isinstance(args,dict) or set(args)!=set(BRIEF) or not all(isinstance(x,str) and 0<len(x.strip())<=1800 for x in args.values()):
                    return {"error":"supply four short nonempty brief fields"}
                owner.requests[phase]+=1
                start=time.monotonic()
                try:
                    answer,usage=coach_call(owner.arm,args)
                    if not answer.strip():
                        raise ValueError("empty coach response")
                except (ValueError,OSError,subprocess.SubprocessError,KeyError,IndexError,StopIteration) as exc:
                    owner.coach_error=type(exc).__name__
                    raise ValueError("coach transport failure: "+owner.coach_error) from exc
                owner.advice.append({"phase":phase,"brief":args,"advice":answer,"usage":usage,"seconds":round(time.monotonic()-start,2)})
                return {"advice":answer}
        return World(case,commit)


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--arm",choices=["skills","skills-no-system","sol","opus","solo"],required=True)
    cli.add_argument("--checkpoint",action="store_true",help="Require one pre-write consultation in phase one.")
    cli.add_argument("--cases",type=Path,required=True)
    cli.add_argument("--output",type=Path,required=True)
    args=cli.parse_args()
    if args.checkpoint and args.arm not in ("sol","opus"):
        cli.error("a checkpoint requires a Coach")
    FAMILIES.update({f.__name__:f for f in (account_switch,donation_close,training_packet)})
    run.OUTPUT_LIMIT=4096
    url=os.environ["AMOS_BENCH_URL"]
    ep=urlsplit(url)
    if ep.scheme!="https" and not (ep.scheme=="http" and ep.hostname in ("localhost","127.0.0.1","::1")):
        cli.error("HTTPS or loopback required")
    with args.output.open("x") as out:
        for line in args.cases.read_text().splitlines():
            row=json.loads(line)
            family,seed,commit=row["family"],row["seed"],row["timeout_committed"]
            if family not in FAMILY_SET: continue
            skill=select_skill(run.make_case(family,seed).requests[0])
            a=Assistance(args.arm,skill,args.checkpoint)
            try:
                result=run.run_case(url,os.environ["AMOS_BENCH_API_KEY"],PARENT,family,seed,commit,
                                    world_factory=a.world,tool_factory=a.tools,request_fn=a.parent)
            except (OSError,ValueError,KeyError,IndexError) as exc:
                result={"family":family,"seed":seed,"invalid":str(exc)}
            result.update(arm=args.arm,checkpoint=args.checkpoint,skill=skill if a.card else None,advice=a.advice,requests=a.requests)
            out.write(json.dumps(result)+"\n");out.flush()
            print(args.arm,seed,family,result.get("passed",result.get("invalid")),len(a.advice),flush=True)

if __name__=="__main__":
    main()
