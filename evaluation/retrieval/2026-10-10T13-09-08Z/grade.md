# Retrieval recall

Generated 2026-10-10T13:09:08.333Z at commit `7926f30a3180b41b77ae8698536862f3dbf99efb`, without a model: the selector over the labelled set (n=30), the scout emulated (the backend's ranking cannot run in a test).

What the prompt carries (the pages always included and the ranked pick of at most 6 pages and 12 blocks): recall of pages **95.0%**, of sections **93.3%**.

The ranked pick alone, against the labels the pages always included leave (27 items with pages left, 24 with sections left): recall at 6 pages **92.6%**, at 12 blocks **89.6%**.

R2's bar: 90.0% of pages, 80.0% of blocks, on both. At or above the bar.

| Item | Pages | Sections | Ranked pages | Ranked sections | Characters | Missed |
|---|---|---|---|---|---|---|
| fin-status-note | 100.0% | 100.0% | 100.0% | - | 15,362 | none |
| fin-where-close-stands | 100.0% | 50.0% | 100.0% | 50.0% | 8,497 | company:finance/handbook.md#How the team works |
| fin-accrual-owner | 100.0% | 100.0% | 100.0% | 100.0% | 17,292 | none |
| fin-accruals-late | 100.0% | 100.0% | 100.0% | 100.0% | 5,883 | none |
| fin-flash-report | 100.0% | 100.0% | 100.0% | 100.0% | 16,437 | none |
| log-held-no-eta | 100.0% | 50.0% | 100.0% | 0.0% | 15,136 | company:logistics/handbook.md#Notices and ETAs |
| log-thread-reply | 100.0% | 100.0% | 100.0% | 100.0% | 9,050 | none |
| log-eta-confirmed | 100.0% | 100.0% | 100.0% | 100.0% | 15,137 | none |
| log-damaged-ops-request | 50.0% | 0.0% | 50.0% | 0.0% | 8,589 | company:onboarding.md, company:logistics/handbook.md#The exception process, company:onboarding.md#Working rules for every team |
| log-which-linear-team | 100.0% | 100.0% | 100.0% | 100.0% | 18,041 | none |
| revops-refresh-tile | 100.0% | 100.0% | 100.0% | 100.0% | 11,200 | none |
| revops-stale-figure | 100.0% | 100.0% | 100.0% | 100.0% | 10,902 | none |
| revops-audit-note | 100.0% | 100.0% | - | - | 16,373 | none |
| revops-comment-close | 100.0% | 100.0% | 100.0% | - | 16,140 | none |
| revops-reply-coverage-ask | 100.0% | 100.0% | 100.0% | 100.0% | 10,802 | none |
| revops-globex-owner | 100.0% | 100.0% | 100.0% | 100.0% | 10,208 | none |
| revops-rotate-linear-key | 100.0% | 100.0% | 100.0% | 100.0% | 16,888 | none |
| revops-own-slack-app | 100.0% | 100.0% | 100.0% | 100.0% | 10,610 | none |
| revops-finance-channel | 100.0% | 100.0% | 100.0% | 100.0% | 7,838 | none |
| revops-first-week | 50.0% | 100.0% | 50.0% | 100.0% | 10,533 | company:onboarding.md |
| revops-missing-slack-access | 100.0% | 100.0% | 100.0% | 100.0% | 10,979 | none |
| revops-standup-deals | 100.0% | 100.0% | - | - | 14,185 | none |
| revops-close-tickets-done | 100.0% | 100.0% | - | - | 18,129 | none |
| revops-manager-dm-recap | 50.0% | 100.0% | 0.0% | - | 19,192 | notion:slack-automation-policy.md |
| revops-tile-screenshot | 100.0% | 100.0% | 100.0% | 100.0% | 11,978 | none |
| revops-tile-login-refused | 100.0% | 100.0% | 100.0% | 100.0% | 20,393 | none |
| revops-issue-status-change | 100.0% | 100.0% | 100.0% | 100.0% | 15,267 | none |
| zh-handover-signature | 100.0% | 100.0% | 100.0% | 100.0% | 3,740 | none |
| zh-handover-exception | 100.0% | 100.0% | 100.0% | 100.0% | 13,576 | none |
| zh-handover-post | 100.0% | 100.0% | 100.0% | 100.0% | 3,883 | none |
