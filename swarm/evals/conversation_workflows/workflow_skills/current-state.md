# Reconstruct current state before changing a plan

Build one row per stable entity ID. Fetch all inventory and event pages. Keep the highest sequence for each ID, irrespective of page order. A suggestion or cache entry is a lead to check against the authoritative record.

Write down the full ID set before filtering. For a replacement plan, compute the stop set by intersecting project, objective, eligible state and user exceptions. Compute retain as the full inventory minus stop. Check that every original ID occurs in exactly one set, including finished work and other projects. If stop is empty, apply the stated successor condition.

For a queue, classify the latest event first and apply site, urgency, exclusion and reopen rules afterward. Derive the reopened subset from the qualifying queue. On a correction, recompute both sets using the revised rules. Write once, then read the receipt to verify.
