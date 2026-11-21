# DESIGN — sokoban-solver-01

## Problem Statement

`sokoban-solver-01` solves Sokoban levels by room decomposition: a
level is one 1-cell-wide corridor plus 1–4 rooms, each joined to the
corridor by a single door cell. Each room is solved on its own with
push-space A*, and the room plans are stitched together with walking
moves along the corridor. The scored set is unpublished; the entry is
judged on the practice set (5 instances) and on a hidden set drawn by
the kit generator, so the design must be correct on the whole
generator distribution, not only on the 45 levels observed so far.

## Goals & Non-Goals

Goals:

- Solve every instance of the generator distribution in P* pushes
  (the push-optimal count), scoring 1,000,000 on the practice set.
- Be deterministic: no clock, no randomness, same input → same bytes.
- Answer every level within the 60 s budget, with an empty answer
  plus a stderr diagnostic — never a partial or illegal answer —
  when a level cannot be solved under the decomposition.
- Stay a single file (`main.ts`), standard library only, no network,
  under the 1 MiB entry limit.

Non-goals:

- No global-search fallback. A level that violates the decomposition
  premises is left unanswered and reported, not worked around.
- No heuristic strengthening (pattern databases, linear conflict):
  the observed levels gain nothing from it and admissibility would be
  at risk.
- No clock-based cutoff: budgets are counted in expanded states so
  determinism holds.
- No attempt to solve levels outside the generator's shape (open
  fields, multi-door rooms, corridor boxes). Those are out of scope
  for this entry.

## Alternatives Considered

- **Global push-space A\* over the whole level.** Rejected: the
  state space (up to 16 boxes on the hidden set) does not fit in the
  60 s budget, and the room decomposition already reaches P* on all
  45 observed levels.
- **Fallback chain (decomposition → global A\* → IDA\*).**
  Rejected for now: it would be ~200 lines including a Hungarian
  replacement for the factorial assignment heuristic, and there is no
  evidence a global search would finish a 16-box level in 60 s. The
  fallback is only worth revisiting if the generator contract is
  checked and a premise is found to fail.
- **PDB / linear-conflict heuristic.** Rejected: zero measured gain
  on the observed levels, and any strengthening risks breaking
  admissibility.
- **Clock-based cutoff.** Rejected: it breaks determinism (two runs
  could write different bytes).

## Risks & Mitigations

- **A decomposition premise fails on the hidden set** (e.g. a room
  with 5 boxes, a door on a goal, a player starting inside a room).
  Mitigation: every premise is checked at runtime and a violation
  makes the level unanswered with a stderr diagnostic instead of a
  wrong answer. There is no fallback; the residual risk is that
  instance scoring 0. See "Input premises" below.
- **A trap room exists on the hidden set.** Mitigation: the exit
  policy (see "Exit handling") visits a trap room last with its free
  plan, which is always at most as expensive as any exit plan.
- **A hard room exhausts the budget.** Mitigation: budgets are
  per-level (see "Budget isolation"), so one hard room cannot starve
  the levels after it; a withExit budget failure is retried once with
  the remaining level budget instead of being misclassified.
- **Row-wrapping pushes.** Mitigation: the three flat-arithmetic
  sites are guarded with a column check (see "Row-wrap rule").
- **The generator contract is unverified.** The kit generator was
  run as a black box with fabricated seeds; there is no citation for
  the premises, and the 8 generated sets are not a parameter-coverage
  argument. The first thing to check before adding a fallback is the
  generator contract.

## Proposed Architecture

Single file `main.ts` (Node 22, type stripping, no build step).
`parseLevel` → `solveLevel` (flood-fill decomposition, one
`solveRoom` push-space A* per room, trap handling) → assembly
(walk the corridor, step in, replay each room's pushes, walk out) →
`verify` (replay the finished move string) → write
`solution.txt`. All search budgets are counted in expanded states.

## I/O contract

- Environment: `MAKEFUN_INPUT_DIR` (default `/input`),
  `MAKEFUN_OUTPUT_DIR` (default `/output`).
- Instance ids are fixed: `i001`–`i005`, in that order.
- Input: `<input>/<id>/level.txt`, XSB text (see "Terms").
- Output: `<output>/<id>/solution.txt`, the player's moves as one
  string of `u`/`d`/`l`/`r` (whitespace ignored by the checker).
- Failure: an empty `solution.txt` plus a diagnostic on stderr.
  Never a partial answer.
- Runtime: Node 22 (`.ts` run by type stripping; 22.18+ runs it by
  default). Standard library only (`node:fs`, `node:path`). No
  network, no clock, no randomness.
- Limits: 60 s for the whole set; the entry must be under 1 MiB
  (`main.ts` is ~27 KB after the R1–R5 fix).

## Terms

- **P\***: the push-optimal count of a level — the minimum number of
  pushes in any solution. The scorer's key value; a solution in P*
  pushes scores 1,000 points per instance.
- **XSB**: the level text format. `#` wall, ` ` floor, `.` goal,
  `$` box, `*` box on a goal, `@` player, `+` player on a goal.
  Short rows are padded with walls; empty lines are dropped; `\r`
  is treated as floor (a CRLF input therefore widens the board by
  one column — a known latent nit, not fixed).
- **Corridor row**: the row holding `@`. Exactly one row.
- **Room**: a connected component of non-corridor floor cells.
- **Door cell**: a room cell next to a corridor-row floor cell.
  **Entry cell**: the corridor-row cell in the door's column
  (`corridorRow * w + door % w`). Door detection only accepts
  vertical neighbours, so the entry is a floor cell by construction.
- **Free plan**: a room plan from `solveRoom` with `requireExit`
  false — the player may end trapped inside the room.
- **Exit plan**: a room plan with `requireExit` true — after the
  last push the player must be able to walk to the entry cell.
- **Door order**: rooms are visited in ascending door-cell index,
  except a room marked `mustLast`, which is visited last.
- **Kit scorer**: `program/scorer/score.ts` plus
  `program/scorer/checker/check.mjs` — it replays the move string
  with flat index arithmetic and scores pushes against P*.
- **House baseline plain-astar 1.0.0**: the kit's reference solver,
  scoring 200,000 on practice (i001 only).
- **Generator**: `program/generator/draw.ts`, run as a black box.

## Input premises

These are assumptions about the generator's levels, observed on 45
levels — not verified contracts (no kit/generator citation exists).
Each is checked at runtime where a check is cheap; a violation makes
the level unanswered with a stderr diagnostic.

- P1. The corridor is exactly one row, holding `@`.
- P2. The player starts in the corridor row.
- P3. No box or goal lies on the corridor row.
- P4. Every box and goal belongs to some room.
- P5. Each room has exactly one door cell.
- P6. Each room has as many boxes as goals.
- P7. A door cell is not a goal.
- P8. Rooms do not touch the board edge (observed; not enforced).
- P9. The solver only considers plans in which no box leaves its
  room (push targets are room cells only); under that assumption
  the push-optimal count of a level is the sum of its rooms'
  optima.
- P10. In the tested levels each room has 3–4 boxes. The program
  enforces only doors == 1 and boxes == goals (see "Algorithm").

## Algorithm

1. **Parse** the XSB level. The corridor row is the row holding `@`.
   Flood-filling the floor outside that row gives the room components.
   `solveLevel` checks the corridor-row guard first (see "Corridor
   guard"), then, after the room loop, assignment completeness.
2. **Decompose.** Each component must have exactly one door cell (a
   room cell next to a corridor-row floor cell), and as many boxes as
   goals. In the tested levels each component has exactly one door
   cell, 3–4 boxes and as many goals. The program enforces only
   doors == 1 and boxes == goals. A component that fails this check
   makes the level unanswered (empty `solution.txt`, diagnostic on
   stderr) — it is reported, never silently worked around with a
   global search.
3. **Solve each room** with push-space A*: a state is the sorted box
   cells plus the player's reachable region (summarised by its
   smallest cell index). One push costs 1. The player may stand on
   room cells plus the single corridor cell next to the door (the
   entry cell) — that cell is needed to push a box sitting on the
   door away from the corridor. Boxes may never be pushed onto the
   entry cell.
4. **Stitch.** Rooms are visited in door order (rooms whose free plan
   traps the player go last, see "Exit handling"). Corridor walks use
   BFS avoiding boxes; between pushes the walk BFS is restricted to
   the room cells plus the entry cell. (The corridor walk itself uses
   the whole board as its domain, so it may cut across a room — that
   only shortens walks, never moves a box.) Every finished plan is
   replay-verified inside the program before it is written.

## Row-wrap rule

Flat index arithmetic wraps across row boundaries, so a neighbour
computed from an index must be checked against the row it came from.

> When a neighbour cell is computed from an index, always check
> that the row did not change. For a horizontal move, the column of
> the cell before the move and the column of the cell after it must
> differ by exactly 1. This check is needed in exactly three places:
> (1) `behind` in `solveRoom`, (2) `behind` in the assembly,
> (3) `next` and `beyond` in `verify()`. `walkPath`, `floodRegion`
> and the distance BFS already check the row, so they are not
> touched. Vertical moves need no such check.

## Constants (definition · unit · origin)

- `MAX_ROOM_EXPANSIONS = 100,000` — expanded states per
  `solveRoom` call. Worst observed per-room expansions on the tested
  sets: **1,591** (generated set 7). The cap is ~60× that headroom.
  A room that exceeds it returns a `budget` failure (see "Null
  causes"), never a partial plan.
- `MAX_TOTAL_EXPANSIONS = 200,000` — expanded states per level
  (reset in `main()` before each level; see "Budget isolation").
  Worst observed per-level total: **1,843** (generated set 4,
  i005); worst run total over 5 levels: **4,160** (generated set 1);
  practice per-level expansions: i001 30, i002 114, i003 31,
  i004 720, i005 1,588 (sum 2,483). The cap is ~100× the worst
  observed per-level total.
- Calibration (measured on /tmp instrumented copies, not in the
  shipped program): about **10,000 expansions per second**, so the
  caps bound the worst case at roughly 10 s per room and 20 s per
  level — inside the 60 s budget. The previous caps (500,000 /
  3,000,000) were lowered after this measurement: 3,000,000
  expansions would be ~300 s of wall time at the measured rate.
- `DIRS = u, d, l, r` — fixed neighbour order for BFS and push
  generation; the only tie-break input besides the A* key, so output
  is deterministic.
- A* tie-break: `(f = g + h, h, creation order)`. Smaller `h` first
  among equal `f` is a tie-break only; it does not affect optimality
  (optimality comes from `h` being admissible). Creation order makes
  the result independent of heap internals.

## Why the heuristic is admissible

`h` = minimum over all box→goal assignments of the sum of
box-ignoring shortest-path distances (distances precomputed by BFS
from each goal over room floor only; `n` boxes means `n!`
permutations — 6 for 3 boxes, 24 for 4, 120 for 5, 40,320 for 8 —
with no cap in code, so a room with many boxes makes the heuristic
itself expensive). One push moves exactly one box by one cell, so one
push can reduce this sum by at most 1, and a solved state has
`h = 0`. Hence `h` never exceeds the pushes still needed: A* with
this `h` returns a push-optimal room plan. `h = Infinity` (some box
cannot reach any goal) prunes the state, which is safe for the same
reason.

## Why each deadlock prune is safe

All rules prune only states from which no goal state is reachable,
under the room-decomposition assumption (P9).

- **Unreachable box** (`nearest[box] = -1`): the box's cell reaches
  no goal on the room floor, and under P9 the box never leaves the
  room — it can never land on a goal. (A room is a flood-fill
  component, so this rule is in practice unreachable; it is kept as
  a guard.)
- **Corner** (box on a non-goal cell with two perpendicular true
  walls): every push needs the player on a wall cell or a wall as the
  target, so the box can never move again. "True wall" means a board
  wall or off-board; corridor floor does **not** count, because the
  player can stand in the corridor to push a box off the door cell.
- **Wall run** (box against a true wall, on a maximal run of room
  cells against that wall, walled off at both ends, holding no goal):
  the box can only slide inside the run (moving away from the wall
  needs the player on the wall side) and no goal lies in the run. A
  run end is open — no prune — when the next cell is a room cell no
  longer against the wall, since the box could slide past the wall's
  end and away. "Walled off" also covers a run end at a corridor
  floor cell, a non-room cell, or a row change.
- **2×2 block** (four cells all walls or boxes, holding a box not on a
  goal): no box in the block can ever move — each of its pushes needs
  a free cell inside the block or the player inside it. If every box
  in the block is already on a goal, no prune. Only blocks whose
  top-left anchor is a room cell are checked; a block anchored
  outside a room is missed, which is safe (fewer prunes, never a
  wrong one).

## Exit handling

A room plan is normally accepted only if the player can still walk
out to the entry cell afterwards. If no exit plan exists, the free
plan is still used, but the room is visited last and the exit walk
is skipped.

The room plan exit rule is:

1. Compute the free plan first. If the player can reach the entry
   cell after it, use that plan.
2. If the free plan traps the player, the room is by default visited
   last with its free plan (`mustLast`). It is not re-solved.
3. With two or more trap rooms, the last slot is only one, so for
   each trap room also compute a requireExit plan and the difference
   d = (exit plan pushes) − (free plan pushes). The room with the
   largest difference takes the free-last slot; the other trap rooms
   use exit plans. Ties are broken by the smaller door-cell index
   (determinism). An exit plan is always at least as expensive as
   the free plan (F ≤ E), because every exit plan is also a feasible
   free plan — so visiting a trap room last with its free plan is
   never worse than using its exit plan.
4. A room whose requireExit search fails with "no exit plan exists"
   is a forced-last candidate. Two or more such rooms make the level
   unsolvable under this decomposition, so the level is unanswered.
5. A room whose requireExit search fails with "budget exhausted" is
   NOT classified as last. It is retried once with the remaining
   level budget, or recorded as a budget failure.

In the 45 levels tested (practice + 8 generated sets) the free plan
already allowed exit, so no room ever needed the last-place rule —
but the path is implemented and covered by synthetic trap levels
(see "Verification").

## Budget isolation

`totalExpansions` is reset to 0 for each level. The reset is in
`main()`'s level loop, immediately before the `solveLevel` call. It
is not reset per room. After the reset, `MAX_TOTAL_EXPANSIONS` is a
per-level cap. The per-room counter restarts on every `solveRoom`
call, so a free-plan search and a requireExit re-search each get a
fresh room budget but share the level budget.

The only dynamic reallocation is the withExit retry: when a
requireExit search fails on budget, it is retried once with the
remaining level budget (`MAX_TOTAL_EXPANSIONS − totalExpansions`,
only if that exceeds `MAX_ROOM_EXPANSIONS`). Free plans are never
retried with a larger budget. No clock-based cutoff is used anywhere:
budgets are counted in expanded states, so determinism holds.

Also fixed with the reset: the solved check in `solveRoom` now runs
before the budget check, and the budget comparison is `>=`, so a
goal state popped exactly on the budget boundary still counts, and
the caps allow exactly `roomBudget` / `MAX_TOTAL_EXPANSIONS`
expansions, not one more.

## Null causes

`solveRoom` returns a discriminated union — never a bare null — so
callers can tell a budget failure from a genuinely unsolvable room:

```ts
type RoomFailReason = "unsolvable" | "budget";
type RoomResult =
  | { ok: true; plan: RoomPlan }
  | { ok: false; reason: RoomFailReason };
```

(String union, not `enum`: Node 22 erasable syntax forbids `enum`.)

| Cause | `reason` | Meaning | Caller behaviour |
|---|---|---|---|
| Start heuristic is infinite | `"unsolvable"` | Some box cannot reach any goal | Free plan: level unanswered. withExit: forced-last candidate |
| Start state is deadlocked | `"unsolvable"` | No plan exists from the start state | Same as above |
| Expansion budget exhausted | `"budget"` | May succeed with more budget | Free plan: level unanswered. withExit: retry once with the remaining level budget; still budget → forced-last candidate (and the level is unanswered if there are two) |
| Heap exhausted | `"unsolvable"` | No plan exists in the room model | Same as the other `"unsolvable"` rows |

A free-plan failure makes the level unanswered regardless of cause.
Only a withExit failure is classified by cause.

## Corridor guard

Input premise: the player starts in the corridor row. The corridor
row is the row holding `@`. `solveLevel` checks, immediately after
fixing `corridorRow`, whether any box or goal lies on the corridor
row; if so, the level is unanswered (empty `solution.txt`, stderr
diagnostic). After the room loop it also checks assignment
completeness: the boxes and goals assigned to rooms must equal the
level's totals, which catches a player starting inside a room (the
corridor row then cuts rooms apart and leaves boxes unassigned).

No guard is added for the entry cell. The entry is the corridor-row
cell in the door's column, and door detection only accepts vertical
neighbours, so it is a floor cell by construction; a guard there
would be dead code.

## Edge cases (input condition → behaviour)

- Box already on a goal at start → the heuristic counts distance 0
  for it. The search may still move it if a solution needs that; in
  the tested levels the optimal plans never do.
- Box on the door cell at start → the room search starts the player
  on the entry cell, and the first push can push the box into the
  room from the corridor side.
- 3 boxes vs 4 boxes → same code path; permutations are 6 vs 24.
  (More boxes work too — see "Algorithm" — but the heuristic cost
  grows factorially.)
- Room with 0 boxes and 0 goals (empty pocket) → skipped, no plan.
- Room with boxes ≠ goals, or ≠ 1 door → level unanswered (empty
  answer), diagnostic on stderr.
- Room unsolved → level unanswered (empty answer), diagnostic on
  stderr, with the cause (`budget` vs `unsolvable`) in the log.
  Never a partial or illegal answer: every written plan is
  replay-verified first. Note `verify()` checks moves, wall/box
  collisions and that every box ends on a goal; it does not check
  that every goal holds a box, and it relies on the row-wrap rule
  above for horizontal moves.
- Player on a goal (`+`) or box on a goal (`*`) in the input → parsed
  like the checker does (same XSB rules: see "Terms").

## Verification (commit hash below)

- Practice set, kit scorer: **score 1,000,000**, passed 5/5.
  i001 13/13, i002 16/16, i003 29/29, i004 47/47, i005 60/60 pushes
  (pushes/P*). Runtime ~0.6 s for the whole set (60 s budget).
  Per-level expansions: i001 30, i002 114, i003 31, i004 720,
  i005 1,588.
- Generated sets: `program/generator/draw.ts` run as a black box with
  8 fabricated seeds (`sha256("sokoban-test-set-N-20261121")`,
  N = 1..8), solver + scorer on each: **1,000,000 on all 8 sets,
  40/40 instances at P*** (P* per set: 15/16/32/42/61, 16/16/30/46/57,
  12/14/29/50/60, 13/15/30/44/59, 12/17/28/49/59, 13/20/28/53/64,
  12/14/31/54/59, 15/14/29/48/62). No decomposition warning and no
  exit re-solve in any of the 40 levels. Worst per-room expansions
  1,591 (set 7); worst per-level total 1,843 (set 4, i005); worst
  run total 4,160 (set 1).
- Post-fix re-verification (R1–R5 applied): practice and all 8
  generated sets still score 1,000,000, with outputs byte-identical
  to the pre-fix runs (`diff -r` clean) and empty stderr. The fixes
  change nothing on the 45 observed levels, as expected — none of
  the five bugs fires there.
- Determinism: two runs on the practice input produce byte-identical
  outputs (`diff -r` clean). No clock, no randomness in the program
  (grep for `Date.now`, `performance.now`, `Math.random`: none).
- Baseline comparison: house baseline plain-astar 1.0.0 scores
  200,000 on practice (i001 only); this entry scores 1,000,000.
- Synthetic tests (all in `/tmp`, not in the entry):
  - Single shaft-trap room: free plan 4 pushes, used last; 4 pushes,
    checker 1,000 (P* 4). The pre-fix code also solved it but paid
    for an exit-plan search first.
  - Two shaft-trap rooms: level unanswered with an explicit "two
    rooms trap the player" diagnostic (pre-fix code collapsed in
    assembly instead).
  - Two-bridge trap room: pre-fix code used the exit plan (8
    pushes); fixed code uses free-last (4 pushes, optimal).
  - Row-wrap room (solvable only by a push whose `behind` cell
    wraps to the previous row): pre-fix code produced a 4-push plan
    the kit checker accepts (1,000 points — the checker replays with
    the same flat arithmetic); fixed code answers empty, which is
    correct real Sokoban.
  - Box on the corridor row: empty answer + "box or goal on
    corridor row" diagnostic.
  - Player starting inside a room: empty answer + "room with 5
    doors" diagnostic.
  - Budget isolation (caps lowered to 130 total in /tmp copies):
    pre-fix code solves i001 (30 expansions) then fails i002 (needs
    114; cumulative 144 > 130); fixed code solves both.
  - withExit budget retry (caps 50/1,000 in /tmp copies): the
    bridge room's first exit search fails on budget; the retry with
    the remaining 940 expansions succeeds after 54 expansions.
    Pre-fix code fails the level; fixed code solves it in 12 pushes.

## Fix instructions (R1–R5, applied)

The five real bugs from the review, where each fix lives in
`main.ts`, and what was deliberately not done.

- **R2 row wrapping** — `solveRoom` push generation (compute
  `behind` from the box's x/y with a bounds check, so a horizontal
  push's behind cell stays on the box's row), the assembly
  `behind` (row check + stderr + null), and `verify()` (`next` /
  `beyond` row checks). See "Row-wrap rule" for the exact rule and
  the three places. Do not touch `walkPath`, `floodRegion` or the
  distance BFS — they already check rows.
- **R3 budget isolation** — `totalExpansions = 0;` in `main()`
  immediately before `solveLevel(board)` (1 line); the solved check
  moved before the budget check and `>` → `>=` in `solveRoom`;
  caps lowered to `MAX_ROOM_EXPANSIONS = 100,000` /
  `MAX_TOTAL_EXPANSIONS = 200,000` (per level) after calibration.
  See "Budget isolation".
- **R5 corridor-row guard** — `solveLevel`: a guard right after
  `corridorRow` is fixed (box/goal on the corridor row → level
  unanswered + diagnostic), plus an assignment-completeness check
  after the room loop. No entry-cell guard (rejected finding X1).
- **R1 + R4, one bundle** — `solveRoom` returns `RoomResult`
  (`{ok:true, plan} | {ok:false, reason:"unsolvable"|"budget"}`,
  string union, no `enum`); the room loop collects trap candidates
  instead of calling `withExit` immediately; a single trap takes
  the last slot with its free plan; with two or more traps the last
  slot goes to the largest (exit − free) difference and the rest use
  exit plans; a `"budget"` withExit failure is retried once with the
  remaining level budget. See "Exit handling" and "Null causes".
- **Deliberately not done:** no entry-cell guard (rejected
  finding — it would be dead code); no global-search fallback; no
  heuristic strengthening (PDB / linear conflict); no clock-based
  cutoff; the heuristic admissibility proof and the four deadlock
  rules are untouched (they passed review). Nit items N1 (unsorted
  start boxes), N2 (CRLF `\r` → floor), N4/N23 (output writes
  outside try) were left out of scope.

## Commit

- Repo: `~/workspace/makefun/sokoban-solver-01-run-20261121`
- Code commit: `6f2c276e4a7a94c2778f5a91796c83fe5425bf33` — R1–R5 fix
  (`main.ts` + `DESIGN.md` + `README.md`).
- Docs-only follow-up: this commit — records the code-commit hash
  in `DESIGN.md`; code identical to `6f2c276`. Final head is this
  commit (`git log -1` shows its hash).
