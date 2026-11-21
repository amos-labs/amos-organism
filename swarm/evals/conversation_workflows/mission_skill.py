"""Read-only mission preview for the synthetic AMOS tool server."""
import run


PREVIEW = run.tool(
    "preview_mission_filter",
    "Read the complete AMOS mission inventory and latest receipts. Preview matching IDs and the entire "
    "remaining set for a project, objective, eligible states and explicit exceptions. Read only. "
    "Use it again if the user's criteria change.",
    {"project":{"type":"string"},"objective":{"type":"string"},
     "states":{"type":"array","items":{"type":"string"}},
     "exclude_ids":{"type":"array","items":{"type":"integer"}}},
    ["project","objective","states","exclude_ids"])


def read_rows(read, resource):
    cursor=0
    rows=[]
    while cursor is not None:
        page=read(resource,cursor)
        if "error" in page:
            raise ValueError(page["error"])
        rows.extend(page["rows"])
        next_cursor=page["next_cursor"]
        if next_cursor is not None and (type(next_cursor) is not int or next_cursor<=cursor):
            raise ValueError("non-advancing source cursor")
        cursor=next_cursor
    return rows


def preview(read, args):
    if not isinstance(args,dict) or set(args)!={"project","objective","states","exclude_ids"}:
        raise ValueError("supply project, objective, states, and exclude_ids")
    if not all(isinstance(args[k],str) and args[k].strip() for k in ("project","objective")):
        raise ValueError("project and objective must be nonempty")
    if not isinstance(args["states"],list) or not all(isinstance(s,str) for s in args["states"]):
        raise ValueError("states must be a list of strings")
    if not isinstance(args["exclude_ids"],list) or not all(type(i) is int for i in args["exclude_ids"]):
        raise ValueError("exclude_ids must be integer IDs")
    inventory=read_rows(read,"missions")
    events=read_rows(read,"receipts")
    latest={}
    for e in events:
        key=e["id"]
        if key not in latest or e["seq"]>latest[key][0]:
            latest[key]=(e["seq"],{e["state"]})
        elif e["seq"]==latest[key][0]:
            latest[key][1].add(e["state"])
    matched=[]
    other=[]
    unresolved=[]
    seen=set()
    for row in inventory:
        key=row["id"]
        if key in seen:
            raise ValueError("duplicate mission in inventory")
        seen.add(key)
        if row["project"]!=args["project"] or row["objective"]!=args["objective"] or key in args["exclude_ids"]:
            other.append(key)
        elif key not in latest or len(latest[key][1])!=1:
            unresolved.append(key)
        elif latest[key][1].intersection(args["states"]):
            matched.append(key)
        else:
            other.append(key)
    return {"matched_ids":sorted(matched),"other_ids":sorted(other),"unresolved_ids":sorted(unresolved)}


class PreviewWorld(run.World):
    def call(self,name,args,phase):
        if name!="preview_mission_filter":
            return super().call(name,args,phase)
        def read(resource,cursor):
            return self.call("amos_read",{"resource":resource,"cursor":cursor},phase)
        try:
            return preview(read,args)
        except (KeyError,TypeError,ValueError) as error:
            return {"error":str(error)}


def main():
    import argparse
    import hashlib
    import json
    import os
    from pathlib import Path
    from urllib.parse import urlsplit

    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--variant",choices=["preview","combined"],default="preview")
    args=parser.parse_args()
    url=os.environ["AMOS_BENCH_URL"]
    endpoint=urlsplit(url)
    if endpoint.scheme!="https" and not (endpoint.scheme=="http" and endpoint.hostname in ("localhost","127.0.0.1","::1")):
        parser.error("HTTPS or loopback required")
    token=os.environ.get("AMOS_BENCH_API_KEY","")
    run.OUTPUT_LIMIT=4096
    variant=args.variant
    fresh=("mission-skill-fresh-a","mission-skill-fresh-b") if variant=="preview" else ("replacement-unseen-c","replacement-unseen-d")
    schedule=[("baseline-20261121-a",[variant]),("baseline-20261121-b",[variant]),
              (fresh[0],["solo",variant]),(fresh[1],[variant,"solo"])]
    with args.output.open("x") as out:
        for seed,arms in schedule:
            committed=hashlib.sha256(f"{seed}/missions/commit".encode()).digest()[0]%2==0
            for arm in arms:
                options={}
                if arm=="preview":
                    options={"world_factory":PreviewWorld,"tool_factory":lambda c:[*run.tools_for(c),PREVIEW]}
                if arm=="combined":
                    from replacement_skill import replacement_case
                    result=replacement_case(url,token,seed,committed)
                else:
                    result=run.run_case(url,token,"qwen3.8-27b","missions",seed,committed,**options)
                result["arm"]=arm
                out.write(json.dumps(result)+"\n")
                out.flush()


if __name__=="__main__":
    main()
