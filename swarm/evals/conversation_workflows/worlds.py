"""Synthetic conversation-derived tasks. A world contains only fictional identifiers."""
import hashlib
import random
from dataclasses import dataclass


@dataclass
class Case:
    files: dict
    requests: tuple
    answers: tuple
    assignments: tuple | None = None


def prospects(rng):
    ids = rng.sample(range(100, 950), 10)
    rows = [dict(id=i, domain=f"d{j if j != 5 else 1}.example", staff=n, kind=k, verified=v)
            for j, (i, n, k, v) in enumerate(zip(ids, [40, 90, 75, 120, 115, 95, 80, 62, 87, 18],
                ["MSP", "VAR", "MSP", "VAR", "MSP", "MSP", "vendor", "VAR", "MSP", "VAR"],
                [True, True, False, True, True, True, True, True, True, True]))]
    blocked = {rows[3]["domain"], rows[8]["domain"]}
    floor = rng.choice([45, 50, 55])
    files = {"amos.prospects": rng.sample(rows, len(rows)), "amos.suppression": sorted(blocked),
             "amos.existing_group": [ids[0]], "amos.old_export": [{"id": ids[2], "verified": True}]}
    def answer(minimum, kinds):
        candidates = sorted((r for r in rows if r["kind"] in kinds and r["staff"] >= minimum and
                             r["verified"] and r["domain"] not in blocked), key=lambda r: -r["staff"])
        unique = {}
        for row in candidates:
            unique.setdefault(row["domain"], row["id"])
        return {"add": sorted(set(unique.values()) - {ids[0]}), "keep": [ids[0]], "send": False}
    start = (f"Draft the prospect group change. Keep existing members. Add verified VARs and MSPs with "
             f"at least {floor} staff. Exclude suppressed domains; per domain keep the largest eligible firm. "
             "Use the current records. Save {add:[IDs to add],keep:[existing IDs],send:false}; no outreach.")
    follow = "Change the new additions to VAR only with at least 60 staff. Keep every other rule and the existing group."
    return Case(files, (start, follow), (answer(floor, {"VAR","MSP"}), answer(60, {"VAR"})))


def support(rng):
    ids = rng.sample(range(100, 900), 7)
    rows = [dict(id=i, kind=k, urgency=u, site=s) for i,k,u,s in zip(ids,
            ["support","support","suggestion","support","support","campaign","support"],
            [3,2,3,3,1,3,2], ["north","north","north","south","north","north","north"])]
    events = [dict(id=i, seq=1, state="open") for i in ids]
    events += [dict(id=ids[1],seq=3,state="reopened"),dict(id=ids[1],seq=2,state="resolved"),
               dict(id=ids[6],seq=4,state="resolved")]
    files = {"nuvola.support": rng.sample(rows,len(rows)), "nuvola.ticket_events": rng.sample(events,len(events)),
             "amos.ticket_cache": [{"id":ids[6],"state":"open"},{"id":ids[1],"state":"resolved"}]}
    def answer(site, omit):
        chosen=[]
        for row in rows:
            cur=max((e for e in events if e["id"]==row["id"]),key=lambda e:e["seq"])
            if (row["site"] in site and row["kind"]=="support" and row["urgency"]>=2 and
                    cur["state"] in ("open","reopened") and row["id"]!=omit):
                chosen.append(row["id"])
        return {"queue": sorted(chosen), "reopened": [ids[1]], "notify": False}
    start = ("Prepare the internal Nuvola support queue for north, urgency 2 or higher, open or reopened. "
             "Use the highest event sequence per ticket. Exclude suggestions and campaign replies. Save "
             "{queue:[ticket IDs],reopened:[qualifying reopened IDs],notify:false}. No replies or ticket changes.")
    follow = f"Include south as well, but leave ticket {ids[0]} to the other shift. Same filters and output."
    return Case(files,(start,follow),(answer({"north"},None),answer({"south","north"},ids[0])))


def renewal(rng):
    keys = rng.sample(range(100,999),8)
    accounts = [dict(account=a, roster=f"R{k if k != 7 else 0}", paid=k not in (3,7), seats=s)
                for k,(a,s) in enumerate(zip(keys,[8,12,6,16,5,11,9,10]))]
    rows = [dict(roster=f"R{k}",seq=1,active=n) for k,n in enumerate([11,15,3,20,9,13,10])]
    rows += [dict(roster="R1",seq=2,active=12),dict(roster="R4",seq=2,active=8)]
    files={"amos.contracts":rng.sample(accounts,len(accounts)), "nuvola.roster":rng.sample(rows,len(rows)),
           "amos.billing_holds":[keys[5]], "amos.roster_cache":[{"roster":"R4","active":0}]}
    def answer(minimum,exempt):
        over={}
        for a in accounts:
            current=max((r for r in rows if r["roster"]==a["roster"]),key=lambda r:r["seq"])
            diff=current["active"]-a["seats"]
            if a["paid"] and a["account"] not in (keys[5],exempt) and diff>=minimum:
                over[str(a["account"])]=diff
        return {"overages":over,"total":sum(over.values()),"invoice":False}
    start=("Build a draft renewal exception list. Join paid AMOS contracts to Nuvola by roster key. "
           "Latest roster sequence wins. Exclude billing holds. Save {overages:{accountID:excess seats},"
           "total:sum of listed excess seats,invoice:false}. List positive overages only.")
    follow=f"Only flag overages of at least two seats now. Exempt account {keys[0]} for this cycle. No invoices."
    return Case(files,(start,follow),(answer(1,None),answer(2,keys[0])))


def quote(rng):
    fee=rng.randrange(65,105)*100
    setup=rng.randrange(11,21)*10000
    seats=rng.randrange(12,22)
    base=3
    tax_bps=rng.choice([625,825,875])
    files={"amos.rate_card":[{"rev":1,"seat_month_cents":fee-500},{"rev":2,"seat_month_cents":fee}],
           "amos.quote_terms":[{"setup_cents":setup,"included_seats":base,"tax_basis_points":tax_bps,
                                "tax_applies_to":"net recurring fees only","rounding":"nearest cent, half up"}],
           "workspace.brief":[{"currency":"USD","brand":"Harbor School","seats":seats,"months":7}]}
    def answer(count,discount):
        monthly=(fee*(count-base)*(100-discount)+50)//100
        tax=(monthly*tax_bps+5000)//10000
        return {"brand":"Harbor School","setup":setup,"monthly_net":monthly,"monthly_tax":tax,
                "term_total":setup+7*(monthly+tax),"emailed":False}
    start=("Prepare the quote using the brief, current rate and terms. All money fields are integer cents. "
           "Save {brand,setup,monthly_net,monthly_tax,term_total,emailed:false}. Setup is once per term. "
           "Round each monthly amount before multiplication; send nothing.")
    follow=f"Use {seats+3} seats and a 15% discount on billable seat fees only. Keep the branding, setup and term."
    return Case(files,(start,follow),(answer(seats,0),answer(seats+3,15)))


def missions(rng):
    a,b,c,d,e=rng.sample(range(1000,9000),5)
    rows=[dict(id=i,project=p,objective=o) for i,p,o in [
        (a,"east","prospecting"),(b,"east","prospecting"),(c,"east","prospecting"),
        (d,"west","prospecting"),(e,"east","service")]]
    events=[dict(id=i,seq=1,state="running") for i in (a,b,c,d,e)]
    events += [dict(id=b,seq=2,state="paused"),dict(id=c,seq=2,state="cancelled"),
               dict(id=c,seq=3,state="completed")]
    files={"amos.missions":rng.sample(rows,len(rows)), "amos.receipts":rng.sample(events,len(events)),
           "workspace.handoff":[{"preferred_successor":"pilot","suggest_cancel":[d,c]}]}
    start=("Draft a replacement plan for east prospecting missions. Include running and paused ones in stop; "
           "use the latest receipt by sequence. Retain everything else. Successor is pilot, gated on confirmed "
           "stops. Save {stop:[IDs],retain:[IDs],successor,launch:false}. No actual cancellation or launch.")
    follow=f"Leave paused missions alone too. Also retain {a} until tomorrow. If there is nothing left to stop, set successor to null."
    return Case(files,(start,follow),({"stop":sorted([a,b]),"retain":sorted([c,d,e]),"successor":"pilot","launch":False},
        {"stop":[],"retain":sorted([a,b,c,d,e]),"successor":None,"launch":False}))


def handoff(rng):
    case = support(rng)
    tickets = case.files["nuvola.support"]
    reopened = case.answers[0]["reopened"][0]
    south = next(t["id"] for t in tickets if t["site"] == "south")
    escalation = rng.choice([south, reopened])
    case.files["amos.escalations"] = [
        {"ticket": reopened, "reviewed": True}, {"ticket": south, "reviewed": True},
        {"ticket": next(t["id"] for t in tickets if t["kind"] == "suggestion"), "reviewed": False},
    ]
    case.requests = (
        case.requests[0] + " At this stage prepare the draft only.",
        case.requests[1] + f" One more change: assign each qualifying AMOS-reviewed escalation except "
        f"ticket {escalation} to the Nuvola night queue. These internal assignments are approved now. "
        "Check the assignment ledger after each attempt. Keep the draft format and the no-notification rule.",
    )
    case.assignments = ([], [i for i in (reopened, south) if i != escalation])
    return case


FAMILIES = {f.__name__: f for f in (prospects, support, renewal, quote, missions, handoff)}


def make_case(family, seed):
    digest = hashlib.sha256(f"conversation-workflows-v1/{family}/{seed}".encode()).digest()
    return FAMILIES[family](random.Random(int.from_bytes(digest, "big")))
