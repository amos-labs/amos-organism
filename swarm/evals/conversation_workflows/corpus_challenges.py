"""Fresh structural variants inferred from primary and archived AMOS conversations."""
from donation_close import donation_close
from run import main
from worlds import Case, FAMILIES


def account_switch(rng):
    first, second, other = rng.sample(["Larch", "Reed", "Birch", "Elm", "Ash"], 3)
    ids = rng.sample(range(100, 900), 7)
    rows = [{"id": i, "company": company, "state": state, "cents": cents}
            for i, company, state, cents in zip(ids, [first, second, second, first, second, other, second],
                ["open", "open", "paid", "paid", "open", "open", "open"],
                rng.sample(range(25_000, 800_000, 125), len(ids)))]
    tokens = rng.sample(range(1000, 8000), 3)
    grants = [{"company": first, "operation": "invoice.read", "rev": 3, "allowed": True},
              {"company": second, "operation": "invoice.read", "rev": 2, "allowed": True},
              {"company": second, "operation": "mail.send", "rev": 8, "allowed": False},
              {"company": second, "operation": "mail.send", "rev": 7, "allowed": True},
              {"company": first, "operation": "mail.send", "rev": 5, "allowed": True}]
    paid = {ids[4]}
    files = {"amos.invoice_index": rng.sample(rows,len(rows)),
             "amos.payment_receipts": [{"invoice": ids[4], "posted": True}, {"invoice": ids[1], "posted": False}],
             "amos.grants": rng.sample(grants,len(grants)),
             "amos.connections": [{"company": c, "id": t, "connected": True} for c,t in zip((first,second,other),tokens)],
             "workspace.previous_summary": [{"company": second, "mail_send": True, "as_of_grant_revision": 7}]}

    def answer(company, connection, mail):
        outstanding = [r for r in rows if r["company"]==company and r["state"]=="open" and r["id"] not in paid]
        return {"company": company, "connection":connection,"open":sorted(r["id"] for r in outstanding),
                "balance_cents":sum(r["cents"] for r in outstanding),"mail_capability":mail,
                "next":"draft_follow_up" if mail else "request_mail_grant","sent":False}
    request=(f"At {first}, draft a customer follow-up brief about open invoices. Check posted receipts, the "
             "company connection and highest grant revision for each operation. Save "
             "{company,connection:connection ID,open:[invoice IDs],balance_cents,mail_capability:boolean,"
             "next:'draft_follow_up' if mail.send is granted or 'request_mail_grant' otherwise,sent:false}. "
             "A connected integration alone does not establish the current mail grant.")
    follow=(f"Actually use {second} for the entire brief. I'd like a test email eventually. For now, just check "
            "the capability, report what would be required, and save the revised brief. Do not send.")
    return Case(files,(request,follow),(answer(first,tokens[0],True),answer(second,tokens[1],False)))


def training_packet(rng):
    page = rng.sample(range(2,90),8)
    topics = ["intake","routing","review","approvals"]
    audience = rng.choice(["operators","supervisors"])
    rows = [{"page":p, "topic":t, "revision":rev, "audience":a, "status":s}
            for p,t,rev,a,s in zip(page, [*topics,"intake","routing","review","approvals"],
                 [2,1,3,2,3,3,4,4],
                 ["all","all","all","all","all",audience,"all","all"],
                 ["final","final","final","final","final","final","draft","withdrawn"])]
    files = {"workspace.source_pages":rng.sample(rows,len(rows)),
             "amos.brand": [{"version":1,"brand":"Firstlight"},{"version":2,"brand":"Brightfield"}],
             "workspace.agenda": [{"order":i,"topic":t} for i,t in enumerate(topics,1)]}
    rng.shuffle(files["workspace.agenda"])
    def outline(who, need):
        pages={}
        for t in need:
            ok=[r for r in rows if r["topic"]==t and r["status"]=="final" and r["audience"] in ("all",who)]
            pages[t]=max(ok,key=lambda r:r["revision"])["page"]
        return {"brand":"Brightfield","audience":who,"source_pages":pages,
                "first_topic":need[0],"last_topic":need[-1],"format":"pdf","published":False}
    start=(f"Prepare a source manifest for a branded training PDF for {audience}. Use all agenda topics "
           "in agenda order. Choose the highest revision with status final eligible for that audience; "
           "all is eligible for everyone. Save {brand,audience,source_pages:{topic:page},first_topic,"
           "last_topic,format:'pdf',published:false}. Do not publish. This is the manifest only.")
    other="operators" if audience=="supervisors" else "supervisors"
    follow=f"Switch to {other}, move approvals first and omit review. Keep the other topics in their relative order."
    return Case(files,(start,follow),(outline(audience,topics),outline(other,["approvals","intake","routing"])))


if __name__ == "__main__":
    FAMILIES.update({f.__name__: f for f in (account_switch, training_packet, donation_close)})
    main()
