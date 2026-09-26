# 12 — Ledger

Arena results worth keeping. `arena-results/` is git-ignored and cloud
containers are reclaimed, so this file is the record. Append a row for every
adopted change and every milestone measurement; never edit old rows. Protocol
and suites: [`11-roadmap.md`](11-roadmap.md) §11.5.

All rows use arena defaults unless noted: FFA solo, Impossible nations, 400
tribes, normal size, latency 1, rate limits on, 60-minute cap. `progress` is 1
for a win, else peak land ÷ 0.8. Δ is paired against the row named, with a
bootstrap 95% interval.

| Date       | Commit    | Entrant                                               | Games, seed                       | Wins | Progress | Peak land | Eliminated | Note                                                                                       |
| ---------- | --------- | ----------------------------------------------------- | --------------------------------- | ---- | -------- | --------- | ---------- | ------------------------------------------------------------------------------------------ |
| 2026-09-26 | `7b52b78` | `baseline`                                            | 4 random, `plan-check`            | 0    | 0.059    | 4.8%      | 2          | first run in the cloud container                                                           |
| 2026-09-26 | `7b52b78` | `idle`                                                | 4 random, `plan-check`            | 0    | 0.000    | 0%        | 4          |                                                                                            |
| 2026-09-26 | `7b52b78` | `baseline`                                            | 20 random, `plan-bench`, play-out | 0    | 0.089    | 7.1%      | 13         | a nation won all 40 played-out games (with `idle` too): median 22.9 min, range 10.2–57.8   |
| 2026-09-26 | `7b52b78` | `idle`                                                | 20 random, `plan-bench`, play-out | 0    | 0.000    | 0%        | 20         | eliminated at a median 2.9 min (both runs)                                                 |
| 2026-09-26 | `7b52b78` | `baseline:{"expandTrigger":0.25,"expandReserve":0.1}` | 20 random, `plan-bench`           | 0    | 0.117    | 9.3%      | 15         | Δ +0.028 [−0.013, 0.097] vs `baseline` above; better in 6 games, worse in 14. Not adopted  |
| 2026-09-26 | `7b52b78` | `baseline:{"expandTrigger":0.5,"expandReserve":0.42}` | 20 random, `plan-bench`           | 0    | 0.088    | 7.0%      | 12         | Δ −0.001 [−0.036, 0.034]: holding 42% home (peak regrowth) alone does nothing. Not adopted |

Reproduce:

```bash
npm run arena -- --agent baseline --agent idle --games 4 --seed plan-check
npm run arena -- --agent baseline --agent idle --games 20 --seed plan-bench --play-out
npm run arena -- --agent 'baseline:{"expandTrigger":0.25,"expandReserve":0.1}' \
  --agent 'baseline:{"expandTrigger":0.5,"expandReserve":0.42}' --games 20 --seed plan-bench
```

The same seed replays the same games, so the last run pairs with the second by
game ID (the agent's result does not depend on `--play-out`).
