"""Synthetic month-end reconciliation based on routed finance and CRM operations."""
from worlds import Case


def donation_close(rng):
    ids = rng.sample(range(1000, 9900), 7)
    spring, fall = rng.sample(["Cedar", "Linden", "Maple", "Sumac"], 2)
    amounts = rng.sample(range(1250, 42000, 125), len(ids))
    gifts = [
        {"gift": gift, "campaign": campaign, "period": month, "state": state, "cents": cents}
        for gift, campaign, month, state, cents in zip(
            ids, [spring, spring, spring, spring, spring, fall, fall],
            [4, 4, 4, 4, 3, 4, 4],
            ["settled", "settled", "pledged", "refunded", "settled", "settled", "settled"], amounts)
    ]
    # The duplicate CRM export row is the same gift. Two distinct posted splits
    # for that gift are both legitimate ledger amounts.
    half = amounts[0] // 2
    shortfall = rng.choice([25, 50, 100, 250, 500])
    journal = [
        (0, 4, "posted", half), (0, 4, "posted", amounts[0] - half),
        (1, 4, "draft", amounts[1]), (1, 5, "posted", amounts[1]),
        (5, 4, "posted", amounts[5] - shortfall), (6, 4, "posted", amounts[6]),
    ]
    ledger = [{"gift": ids[index], "period": month, "state": state, "cents": cents}
              for index, month, state, cents in journal]
    source = gifts + [gifts[0].copy()]
    files = {"amos.neon_gifts": rng.sample(source, len(source)),
             "amos.quickbooks_entries": rng.sample(ledger, len(ledger))}
    start = (f"Draft an April close for the {spring} campaign. Use April's settled Neon gifts, counting "
             "each gift ID once. Match each gift against the sum of its posted April QuickBooks entries, "
             "including split entries. Save {campaign,gift_cents,posted_cents,unmatched:[gift IDs],"
             "difference_cents} where difference is gifts less posted, and unmatched includes missing "
             "or unequal amounts. Leave both source systems untouched.")
    follow = (f"Actually the board wants {fall} instead. Rebuild the April figures and exception list "
              "for that campaign. Keep the same cutoff, format and draft-only scope.")
    first = {"campaign": spring, "gift_cents": amounts[0] + amounts[1],
             "posted_cents": amounts[0], "unmatched": [ids[1]], "difference_cents": amounts[1]}
    second = {"campaign": fall, "gift_cents": amounts[5] + amounts[6],
              "posted_cents": amounts[5] + amounts[6] - shortfall, "unmatched": [ids[5]], "difference_cents": shortfall}
    return Case(files, (start, follow), (first, second))
