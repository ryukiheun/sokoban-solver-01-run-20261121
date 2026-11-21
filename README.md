# sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ryukiheun/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ryukiheun/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Under the room-decomposition assumption, push-optimal Sokoban solver: it decomposes each level into its corridor and rooms, solves every room with push-space A* (admissible assignment heuristic, safe deadlock pruning), and stitches the room plans together with walking moves. Node 22, standard library only, no network, no clock, no randomness — two runs write identical bytes.

Practice score: **1,000,000** (every instance solved in P* pushes: i001 13, i002 16, i003 29, i004 47, i005 60; house baseline plain-astar 1.0.0 scores 200,000). Also 1,000,000 on 8 freshly drawn generator sets (40/40 instances at P*). Whole practice set runs in ~0.6 s.

## Run it

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<out> node main.ts
```

Then score with the kit scorer:

```sh
MAKEFUN_OUTPUT_DIR=<out> MAKEFUN_REFERENCE_DIR=<kit>/practice/reference MAKEFUN_SCORES_DIR=<scores> node <kit>/program/scorer/score.ts
```

See DESIGN.md for the algorithm, the constants, the admissibility and deadlock-pruning proofs, the edge-case list, and the verification numbers.

---

<sub>Entered on [make.fun](https://make.fun/?ref=r5cs55h2&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
