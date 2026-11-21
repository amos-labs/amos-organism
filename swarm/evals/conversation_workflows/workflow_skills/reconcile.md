# Reconcile two record sets

State the account or campaign, cutoff, eligibility rule, join key and units. Page through each source. Keep one latest authoritative record per versioned key. Distinguish duplicate export rows from legitimate separate ledger splits. Construct a short working table keyed by the entity the user wants to see in the output.

For an exception list, compute one residual per eligible entity. Include zero or missing matches in the working table so a missing payment or missing posting stays visible. Apply holds, thresholds, exceptions and status constraints before aggregating the requested totals. Check the reported discrepancy against the independent difference of totals. For follow-ups, recompute from source.
