// sokoban-solver-01: push-optimal Sokoban solver by room decomposition.
//
// Idea (see DESIGN.md): every level is one 1-cell-wide corridor plus 1-4
// rooms, each joined to the corridor by a single door cell, with 3-4 boxes
// and as many goals per room. The solver only considers plans in which no
// box leaves its room (push targets are room cells only); under that
// assumption the push-optimal count of a level is the sum of its rooms'
// optima. Each room is therefore solved on its own with push-space A*
// (admissible assignment heuristic + safe deadlock pruning), and the room
// plans are stitched together with walking moves along the corridor.
//
// Determinism: no clock, no randomness. All budgets are counted in
// expanded states, so two runs on the same input write identical bytes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants. Meaning, unit and origin of each one are in DESIGN.md.
// ---------------------------------------------------------------------------

/** Step directions, in fixed order: up, down, left, right. */
const DIRS = [
  { dx: 0, dy: -1, ch: "u" },
  { dx: 0, dy: 1, ch: "d" },
  { dx: -1, dy: 0, ch: "l" },
  { dx: 1, dy: 0, ch: "r" },
];

/** Largest A* expansion budget for one room, in expanded states. */
const MAX_ROOM_EXPANSIONS = 100000;
/** Largest A* expansion budget for one level, in expanded states.
 * Reset to 0 in main() before each level (see R3). */
const MAX_TOTAL_EXPANSIONS = 200000;
/** Instance ids of one set, in order. */
const IDS = ["i001", "i002", "i003", "i004", "i005"];

let totalExpansions = 0;

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

interface Board {
  w: number;
  h: number;
  /** 1 = wall (includes cells past a short row), 0 = floor. */
  wall: Uint8Array;
  /** 1 = goal. */
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Board {
  const rows = text.split("\n").filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === "#") continue;
      wall[i] = 0;
      if (ch === "." || ch === "*" || ch === "+") goal[i] = 1;
      if (ch === "$" || ch === "*") boxes.push(i);
      if (ch === "@" || ch === "+") player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

/** True wall test for a board cell index: outside the board counts as wall. */
function isWall(b: Board, i: number): boolean {
  if (i < 0 || i >= b.w * b.h) return true;
  const x = i % b.w;
  if (x < 0 || x >= b.w) return true;
  return b.wall[i] === 1;
}

// ---------------------------------------------------------------------------
// Walking (BFS, deterministic neighbour order). Returns the move string
// from `from` to `to` avoiding walls and boxes, or null when unreachable.
// `allowed` restricts the walkable cells (null = every floor cell).
// ---------------------------------------------------------------------------

function walkPath(
  b: Board,
  from: number,
  to: number,
  boxSet: Uint8Array,
  allowed: Uint8Array | null,
): string | null {
  if (from === to) return "";
  const n = b.w * b.h;
  const prev = new Int32Array(n).fill(-2);
  const prevCh = new Array<string>(n).fill("");
  prev[from] = -1;
  const queue: number[] = [from];
  let head = 0;
  while (head < queue.length) {
    const c = queue[head++];
    for (const d of DIRS) {
      const nx = (c % b.w) + d.dx;
      const ny = Math.floor(c / b.w) + d.dy;
      if (nx < 0 || nx >= b.w || ny < 0 || ny >= b.h) continue;
      const nb = ny * b.w + nx;
      if (prev[nb] !== -2) continue;
      if (b.wall[nb] === 1 || boxSet[nb] === 1) continue;
      if (allowed !== null && allowed[nb] !== 1) continue;
      prev[nb] = c;
      prevCh[nb] = d.ch;
      if (nb === to) {
        const chars: string[] = [];
        let cur = nb;
        while (cur !== from) {
          chars.push(prevCh[cur]);
          cur = prev[cur];
        }
        chars.reverse();
        return chars.join("");
      }
      queue.push(nb);
    }
  }
  return null;
}

/** Flood fill from `start` over `stand` cells avoiding `boxSet`. */
function floodRegion(
  b: Board,
  start: number,
  boxSet: Uint8Array,
  stand: Uint8Array,
): { set: Uint8Array; min: number } {
  const set = new Uint8Array(b.w * b.h);
  const stack: number[] = [start];
  set[start] = 1;
  let min = start;
  while (stack.length > 0) {
    const c = stack.pop() as number;
    if (c < min) min = c;
    for (const d of DIRS) {
      const nx = (c % b.w) + d.dx;
      const ny = Math.floor(c / b.w) + d.dy;
      if (nx < 0 || nx >= b.w || ny < 0 || ny >= b.h) continue;
      const nb = ny * b.w + nx;
      if (set[nb] === 1 || stand[nb] !== 1 || boxSet[nb] === 1) continue;
      set[nb] = 1;
      stack.push(nb);
    }
  }
  return { set, min };
}

// ---------------------------------------------------------------------------
// Room solver: push-space A*.
// A state is (sorted box cells, player-reachable region). The region is
// summarised by its smallest cell index, so states that differ only in
// where the player stands inside one reachable region collapse to one.
// ---------------------------------------------------------------------------

interface RoomCtx {
  b: Board;
  /** Room floor cells (global indices). */
  cells: number[];
  /** 1 on room floor cells. */
  cellSet: Uint8Array;
  /** 1 on cells the player may stand on: room cells + the entry cell. */
  standSet: Uint8Array;
  /** The room cell touching the corridor. */
  door: number;
  /** The corridor cell next to the door. */
  entry: number;
  goals: number[];
  /** dist[g] = shortest-path distance (ignoring boxes) from goal g, -1 = unreachable. */
  dist: Int32Array[];
  /** Shortest distance from each cell to any goal, -1 when no goal is reachable. */
  nearest: Int32Array;
  goalSet: Uint8Array;
  perms: number[][];
}

interface Push {
  from: number;
  to: number;
}

interface RoomPlan {
  pushes: Push[];
  finalPlayer: number;
  finalBoxes: number[];
}

interface ANode {
  boxes: number[];
  player: number;
  parent: number;
  from: number;
  to: number;
  g: number;
  h: number;
  key: string;
}

function allPerms(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const rec = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      const t = a[k];
      a[k] = a[i];
      a[i] = t;
      rec(k + 1);
      a[i] = a[k];
      a[k] = t;
    }
  };
  rec(0);
  return out;
}

/** Build the room context: distances from every goal over room floor only. */
function makeRoomCtx(b: Board, cells: number[], door: number, entry: number): RoomCtx {
  const cellSet = new Uint8Array(b.w * b.h);
  for (const c of cells) cellSet[c] = 1;
  const standSet = new Uint8Array(b.w * b.h);
  for (const c of cells) standSet[c] = 1;
  standSet[entry] = 1;
  const goals = cells.filter((c) => b.goal[c] === 1);
  const goalSet = new Uint8Array(b.w * b.h);
  for (const g of goals) goalSet[g] = 1;
  const dist: Int32Array[] = goals.map((g) => {
    const d = new Int32Array(b.w * b.h).fill(-1);
    d[g] = 0;
    const q: number[] = [g];
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      for (const dd of DIRS) {
        const nx = (c % b.w) + dd.dx;
        const ny = Math.floor(c / b.w) + dd.dy;
        if (nx < 0 || nx >= b.w || ny < 0 || ny >= b.h) continue;
        const nb = ny * b.w + nx;
        if (d[nb] !== -1 || cellSet[nb] !== 1) continue;
        d[nb] = d[c] + 1;
        q.push(nb);
      }
    }
    return d;
  });
  const nearest = new Int32Array(b.w * b.h).fill(-1);
  for (const c of cells) {
    let best = -1;
    for (const d of dist) {
      if (d[c] !== -1 && (best === -1 || d[c] < best)) best = d[c];
    }
    nearest[c] = best;
  }
  return {
    b,
    cells,
    cellSet,
    standSet,
    door,
    entry,
    goals,
    dist,
    nearest,
    goalSet,
    perms: allPerms(goals.length),
  };
}

/**
 * Admissible heuristic: the minimum, over all box->goal assignments, of the
 * sum of box-ignoring shortest-path distances. Every push moves one box by
 * one cell, so one push can lower this sum by at most 1, and a solved state
 * has value 0: the heuristic never overestimates the pushes left.
 * Infinity when some box cannot reach any goal (then the state is dead).
 */
function heuristic(ctx: RoomCtx, boxes: number[], cache: Map<string, number>): number {
  const key = boxes.join(",");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let best = Infinity;
  for (const p of ctx.perms) {
    let s = 0;
    let ok = true;
    for (let i = 0; i < boxes.length; i++) {
      const d = ctx.dist[p[i]][boxes[i]];
      if (d === -1) {
        ok = false;
        break;
      }
      s += d;
    }
    if (ok && s < best) best = s;
  }
  cache.set(key, best);
  return best;
}

/**
 * Deadlock test. Every rule below is proven safe in DESIGN.md: it only
 * prunes states from which no goal state is reachable at all.
 */
function deadlocked(ctx: RoomCtx, boxes: number[], boxSet: Uint8Array): boolean {
  const b = ctx.b;
  for (const box of boxes) {
    if (ctx.goalSet[box] === 1) continue;
    if (ctx.nearest[box] === -1) return true;
    // Corner: two perpendicular true walls. The box can then never move:
    // every push needs the player on a wall cell or a wall as its target.
    const up = isWall(b, box - b.w);
    const down = isWall(b, box + b.w);
    const left = isWall(b, box - 1) || box % b.w === 0;
    const right = isWall(b, box + 1) || box % b.w === b.w - 1;
    if ((up || down) && (left || right)) return true;
    // Wall run: the box sits against a true wall, on a maximal run of room
    // cells against that same wall that is walled off at both ends and
    // holds no goal. It can only slide inside the run, never onto a goal.
    // (A run end is "open" when the next cell is a room cell no longer
    // against the wall: the box could slide past the wall's end and away.)
    const runDirs = [
      { wall: -b.w, step: 1 },
      { wall: b.w, step: 1 },
      { wall: -1, step: b.w },
      { wall: 1, step: b.w },
    ];
    for (const r of runDirs) {
      const wallHere =
        r.wall === -1
          ? box % b.w === 0 || isWall(b, box - 1)
          : r.wall === 1
            ? box % b.w === b.w - 1 || isWall(b, box + 1)
            : isWall(b, box + r.wall);
      if (!wallHere) continue;
      const against = (c: number): boolean => {
        if (r.step === 1) return r.wall < 0 ? isWall(b, c - b.w) : isWall(b, c + b.w);
        return r.wall < 0 ? c % b.w === 0 || isWall(b, c - 1) : c % b.w === b.w - 1 || isWall(b, c + 1);
      };
      // Walk the run one way; returns [walledEnd, sawGoal].
      const walkRun = (dirStep: number): [boolean, boolean] => {
        let cur = box;
        let sawGoal = ctx.goalSet[cur] === 1;
        for (;;) {
          const n = cur + dirStep;
          if (n < 0 || n >= b.w * b.h) return [true, sawGoal];
          if (r.step === 1 && Math.floor(n / b.w) !== Math.floor(cur / b.w)) return [true, sawGoal];
          if (ctx.cellSet[n] !== 1) return [true, sawGoal];
          if (!against(n)) return [false, sawGoal];
          cur = n;
          if (ctx.goalSet[cur] === 1) sawGoal = true;
        }
      };
      const [loWalled, loGoal] = walkRun(-r.step);
      const [hiWalled, hiGoal] = walkRun(r.step);
      if (loWalled && hiWalled && !loGoal && !hiGoal) return true;
    }
  }
  // 2x2 block: four cells that are all walls or boxes, holding a box that
  // is not on a goal. No box in such a block can ever move.
  for (const c of ctx.cells) {
    const x = c % b.w;
    const y = Math.floor(c / b.w);
    if (x + 1 >= b.w || y + 1 >= b.h) continue;
    const sq = [c, c + 1, c + b.w, c + b.w + 1];
    let blocked = 0;
    let badBox = false;
    for (const s of sq) {
      if (b.wall[s] === 1 || boxSet[s] === 1) blocked++;
      if (boxSet[s] === 1 && ctx.goalSet[s] !== 1) badBox = true;
    }
    if (blocked === 4 && badBox) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Push-space A* for one room.
// ---------------------------------------------------------------------------

function heapLess(nodes: ANode[], a: number, b: number): boolean {
  const na = nodes[a];
  const nb = nodes[b];
  const fa = na.g + na.h;
  const fb = nb.g + nb.h;
  if (fa !== fb) return fa < fb;
  if (na.h !== nb.h) return na.h < nb.h;
  return a < b; // creation order: deterministic tie-break
}

function heapPush(heap: number[], nodes: ANode[], idx: number): void {
  heap.push(idx);
  let i = heap.length - 1;
  while (i > 0) {
    const p = Math.floor((i - 1) / 2);
    if (!heapLess(nodes, heap[i], heap[p])) break;
    const t = heap[i];
    heap[i] = heap[p];
    heap[p] = t;
    i = p;
  }
}

function heapPop(heap: number[], nodes: ANode[]): number {
  const top = heap[0];
  const last = heap.pop() as number;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heapLess(nodes, heap[l], heap[m])) m = l;
      if (r < heap.length && heapLess(nodes, heap[r], heap[m])) m = r;
      if (m === i) break;
      const t = heap[i];
      heap[i] = heap[m];
      heap[m] = t;
      i = m;
    }
  }
  return top;
}

/** Why a room search failed. "budget" = expansion budget exhausted (a retry
 * with more budget may succeed); "unsolvable" = no plan exists in the room
 * model (heap exhausted, dead start state, or unreachable start). */
type RoomFailReason = "unsolvable" | "budget";
type RoomResult = { ok: true; plan: RoomPlan } | { ok: false; reason: RoomFailReason };

/**
 * Solve one room with push-space A*. The player starts on the door cell
 * (or on the entry cell when a box sits on the door). When `requireExit`
 * is set, a goal state only counts when the player can still walk out to
 * the entry cell. Returns `{ok:true, plan}` on success, or
 * `{ok:false, reason}` where `reason` is `"budget"` (expansion budget
 * exhausted — retrying with more budget may succeed) or `"unsolvable"`
 * (no plan exists in the room model). `roomBudget` caps this call's own
 * expansions (default MAX_ROOM_EXPANSIONS); the level total cap still
 * applies on top.
 */
function solveRoom(ctx: RoomCtx, startBoxes: number[], requireExit: boolean, roomBudget: number = MAX_ROOM_EXPANSIONS): RoomResult {
  const b = ctx.b;
  const startPlayer = startBoxes.includes(ctx.door) ? ctx.entry : ctx.door;
  const hCache = new Map<string, number>();
  const startH = heuristic(ctx, startBoxes, hCache);
  if (!Number.isFinite(startH)) return { ok: false, reason: "unsolvable" };
  const startBoxSet = new Uint8Array(b.w * b.h);
  for (const x of startBoxes) startBoxSet[x] = 1;
  if (deadlocked(ctx, startBoxes, startBoxSet)) return { ok: false, reason: "unsolvable" };
  const startRegion = floodRegion(b, startPlayer, startBoxSet, ctx.standSet);
  const nodes: ANode[] = [];
  const gBest = new Map<string, number>();
  const mkNode = (boxes: number[], player: number, parent: number, from: number, to: number, g: number, h: number, key: string): number => {
    nodes.push({ boxes, player, parent, from, to, g, h, key });
    return nodes.length - 1;
  };
  const startKey = startBoxes.join(",") + "|" + startRegion.min;
  const root = mkNode(startBoxes.slice(), startPlayer, -1, -1, -1, 0, startH, startKey);
  gBest.set(startKey, 0);
  const heap: number[] = [];
  heapPush(heap, nodes, root);
  let expansions = 0;
  while (heap.length > 0) {
    const idx = heapPop(heap, nodes);
    const node = nodes[idx];
    if (node.g !== gBest.get(node.key)) continue; // stale heap entry
    expansions++;
    totalExpansions++;
    const solved = node.boxes.every((x) => ctx.goalSet[x] === 1);
    if (solved) {
      if (!requireExit) return { ok: true, plan: finishPlan(nodes, idx) };
      const boxSet = new Uint8Array(b.w * b.h);
      for (const x of node.boxes) boxSet[x] = 1;
      const region = floodRegion(b, node.player, boxSet, ctx.standSet);
      if (region.set[ctx.entry] === 1) return { ok: true, plan: finishPlan(nodes, idx) };
      // Otherwise keep searching: pushing a box off its goal and back may
      // free the player's way out.
    }
    // Solved check first: a goal state popped on the budget boundary still
    // counts. `>=` so the caps allow exactly roomBudget / MAX_TOTAL
    // expansions, not one more.
    if (expansions >= roomBudget || totalExpansions >= MAX_TOTAL_EXPANSIONS) {
      return { ok: false, reason: "budget" };
    }
    const boxSet = new Uint8Array(b.w * b.h);
    for (const x of node.boxes) boxSet[x] = 1;
    const region = floodRegion(b, node.player, boxSet, ctx.standSet);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const box = node.boxes[bi];
      for (const d of DIRS) {
        const tx = (box % b.w) + d.dx;
        const ty = Math.floor(box / b.w) + d.dy;
        if (tx < 0 || tx >= b.w || ty < 0 || ty >= b.h) continue;
        const to = ty * b.w + tx;
        // The target must be a room cell, free of wall and box.
        if (ctx.cellSet[to] !== 1 || boxSet[to] === 1) continue;
        // Row check: a horizontal push's behind cell must stay on the box's
        // row (flat index arithmetic alone would wrap to the adjacent row).
        const bx = (box % b.w) - d.dx;
        const by = Math.floor(box / b.w) - d.dy;
        if (bx < 0 || bx >= b.w || by < 0 || by >= b.h) continue;
        const behind = by * b.w + bx;
        // The player must be able to stand behind the box.
        if (region.set[behind] !== 1) continue;
        const childBoxes = node.boxes.slice();
        childBoxes[bi] = to;
        childBoxes.sort((x, y) => x - y);
        const childBoxSet = new Uint8Array(b.w * b.h);
        for (const x of childBoxes) childBoxSet[x] = 1;
        if (deadlocked(ctx, childBoxes, childBoxSet)) continue;
        const h = heuristic(ctx, childBoxes, hCache);
        if (!Number.isFinite(h)) continue;
        const childRegion = floodRegion(b, box, childBoxSet, ctx.standSet);
        const key = childBoxes.join(",") + "|" + childRegion.min;
        const g = node.g + 1;
        const prev = gBest.get(key);
        if (prev !== undefined && prev <= g) continue;
        gBest.set(key, g);
        heapPush(heap, nodes, mkNode(childBoxes, box, idx, box, to, g, h, key));
      }
    }
  }
  return { ok: false, reason: "unsolvable" };
}

function finishPlan(nodes: ANode[], idx: number): RoomPlan {
  const pushes: Push[] = [];
  let cur = idx;
  while (nodes[cur].parent !== -1) {
    pushes.push({ from: nodes[cur].from, to: nodes[cur].to });
    cur = nodes[cur].parent;
  }
  pushes.reverse();
  return { pushes, finalPlayer: nodes[idx].player, finalBoxes: nodes[idx].boxes.slice() };
}

// ---------------------------------------------------------------------------
// Level assembly: decompose into rooms, solve each, stitch with walks.
// ---------------------------------------------------------------------------

interface RoomJob {
  ctx: RoomCtx;
  boxes: number[];
  /** True when this room is visited last: at most one job has mustLast set
   * (enforced by the trap handling in solveLevel). */
  mustLast: boolean;
  plan: RoomPlan;
}

function solveLevel(b: Board): string | null {
  const corridorRow = Math.floor(b.player / b.w);
  // Input guards (R5). The decomposition assumes the player starts in the
  // corridor row and no box or goal lies on it. A violation makes the level
  // unanswered with a diagnostic, never a silently wrong decomposition.
  // No guard is added for the entry cell: it is the corridor-row cell in
  // the door's column, and door detection only accepts vertical neighbours,
  // so it is a floor cell by construction.
  if (b.player < 0) {
    console.error("decomposition: level has no player");
    return null;
  }
  for (let x = 0; x < b.w; x++) {
    const c = corridorRow * b.w + x;
    if (b.boxes.includes(c) || b.goal[c] === 1) {
      console.error(`decomposition: box or goal on corridor row ${corridorRow}`);
      return null;
    }
  }
  let totalGoals = 0;
  for (let i = 0; i < b.w * b.h; i++) if (b.goal[i] === 1) totalGoals++;
  const seen = new Uint8Array(b.w * b.h);
  const jobs: RoomJob[] = [];
  const traps: { ctx: RoomCtx; boxes: number[]; free: RoomPlan }[] = [];
  let assignedBoxes = 0;
  let assignedGoals = 0;
  for (let i = 0; i < b.w * b.h; i++) {
    if (b.wall[i] === 1 || Math.floor(i / b.w) === corridorRow || seen[i] === 1) continue;
    // One room component: flood fill over non-corridor floor.
    const cells: number[] = [];
    const q: number[] = [i];
    seen[i] = 1;
    while (q.length > 0) {
      const c = q.pop() as number;
      cells.push(c);
      for (const d of DIRS) {
        const nx = (c % b.w) + d.dx;
        const ny = Math.floor(c / b.w) + d.dy;
        if (nx < 0 || nx >= b.w || ny < 0 || ny >= b.h) continue;
        const nb = ny * b.w + nx;
        if (b.wall[nb] === 1 || Math.floor(nb / b.w) === corridorRow || seen[nb] === 1) continue;
        seen[nb] = 1;
        q.push(nb);
      }
    }
    const boxes = cells.filter((c) => b.boxes.includes(c));
    const goals = cells.filter((c) => b.goal[c] === 1);
    if (boxes.length === 0 && goals.length === 0) continue; // empty pocket
    if (boxes.length !== goals.length) {
      console.error(`decomposition: room with ${boxes.length} boxes and ${goals.length} goals`);
      return null;
    }
    const doors = cells.filter((c) => {
      for (const d of DIRS) {
        const nx = (c % b.w) + d.dx;
        const ny = Math.floor(c / b.w) + d.dy;
        if (ny === corridorRow && nx >= 0 && nx < b.w && b.wall[ny * b.w + nx] === 0) return true;
      }
      return false;
    });
    if (doors.length !== 1) {
      console.error(`decomposition: room with ${doors.length} doors (expected 1)`);
      return null;
    }
    const door = doors[0];
    const entry = corridorRow * b.w + (door % b.w);
    const ctx = makeRoomCtx(b, cells, door, entry);
    assignedBoxes += boxes.length;
    assignedGoals += goals.length;
    const free = solveRoom(ctx, boxes, false);
    if (!free.ok) {
      console.error(`room at door ${door}: no free plan (${free.reason})`);
      return null;
    }
    const freeBoxSet = new Uint8Array(b.w * b.h);
    for (const x of free.plan.finalBoxes) freeBoxSet[x] = 1;
    const exitRegion = floodRegion(b, free.plan.finalPlayer, freeBoxSet, ctx.standSet);
    if (exitRegion.set[entry] === 1) {
      jobs.push({ ctx, boxes, mustLast: false, plan: free.plan });
    } else {
      // Trap room: the free plan strands the player inside. Do not pay for
      // an exit plan yet: a free plan is always at most as cheap as an exit
      // plan, so a trap room is visited last with its free plan (see below).
      traps.push({ ctx, boxes, free: free.plan });
    }
  }
  // Assignment completeness (R5): every box and goal must belong to a room.
  // This also catches a player starting inside a room: the corridor row
  // then cuts rooms apart and leaves boxes unassigned.
  if (assignedBoxes !== b.boxes.length || assignedGoals !== totalGoals) {
    console.error("decomposition: unassigned box/goal");
    return null;
  }
  // Trap rooms (R1): at most one room may be visited last, because after it
  // the player cannot leave to reach another room. One trap room takes the
  // last slot with its free plan. With two or more, the last slot goes to
  // the room whose exit plan costs the most extra pushes (largest
  // exit − free difference); the rest use exit plans. A room with no exit
  // plan at all is a forced-last candidate; two of those make the level
  // unsolvable under this decomposition.
  if (traps.length === 1) {
    jobs.push({ ctx: traps[0].ctx, boxes: traps[0].boxes, mustLast: true, plan: traps[0].free });
  } else if (traps.length >= 2) {
    const withExit: { trap: (typeof traps)[number]; plan: RoomPlan; extra: number }[] = [];
    let forced: (typeof traps)[number] | null = null;
    let forcedCount = 0;
    for (const trap of traps) {
      let ex = solveRoom(trap.ctx, trap.boxes, true);
      if (!ex.ok && ex.reason === "budget") {
        // One retry with the level budget that is left. A room that still
        // fails on budget is not misclassified as "no exit plan": it is a
        // forced-last candidate below, and the level is unanswered if
        // there are two of those.
        const remaining = MAX_TOTAL_EXPANSIONS - totalExpansions;
        if (remaining > MAX_ROOM_EXPANSIONS) {
          ex = solveRoom(trap.ctx, trap.boxes, true, remaining);
        }
      }
      if (ex.ok) {
        withExit.push({ trap, plan: ex.plan, extra: ex.plan.pushes.length - trap.free.pushes.length });
      } else {
        forcedCount++;
        forced = trap;
        console.error(`room at door ${trap.ctx.door}: no exit plan (${ex.reason})`);
      }
    }
    if (forcedCount >= 2) {
      console.error("assembly: two rooms trap the player with no exit plan");
      return null;
    }
    if (forced !== null) {
      jobs.push({ ctx: forced.ctx, boxes: forced.boxes, mustLast: true, plan: forced.free });
      for (const w of withExit) jobs.push({ ctx: w.trap.ctx, boxes: w.trap.boxes, mustLast: false, plan: w.plan });
    } else {
      // Largest extra first; ties go to the smaller door cell (deterministic).
      withExit.sort((a, z) => z.extra - a.extra || a.trap.ctx.door - z.trap.ctx.door);
      const last = withExit[0];
      jobs.push({ ctx: last.trap.ctx, boxes: last.trap.boxes, mustLast: true, plan: last.trap.free });
      for (const w of withExit.slice(1)) jobs.push({ ctx: w.trap.ctx, boxes: w.trap.boxes, mustLast: false, plan: w.plan });
    }
  }
  // Rooms that trap the player go last; the rest in door order. mustLast is
  // set on at most one job (enforced above).
  jobs.sort((a, z) => {
    if (a.mustLast !== z.mustLast) return a.mustLast ? 1 : -1;
    return a.ctx.door - z.ctx.door;
  });
  let moves = "";
  let player = b.player;
  const boxSet = new Uint8Array(b.w * b.h);
  for (const x of b.boxes) boxSet[x] = 1;
  for (const job of jobs) {
    const { ctx } = job;
    // Walk along the corridor to the entry cell.
    const toEntry = walkPath(b, player, ctx.entry, boxSet, null);
    if (toEntry === null) {
      console.error(`assembly: cannot reach entry ${ctx.entry}`);
      return null;
    }
    moves += toEntry;
    player = ctx.entry;
    // Step into the room, unless a box sits on the door.
    if (boxSet[ctx.door] === 0) {
      const d = DIRS.find((dd) => ctx.entry + dd.dy * b.w + dd.dx === ctx.door);
      if (d === undefined) return null;
      moves += d.ch;
      player = ctx.door;
    }
    // Run the room plan: walk to each push position, then push.
    for (const push of job.plan.pushes) {
      const dir = DIRS.find((dd) => push.from + dd.dy * b.w + dd.dx === push.to);
      if (dir === undefined) return null;
      const behind = push.from - (dir.dy * b.w + dir.dx);
      if (dir.dx !== 0 && Math.floor(behind / b.w) !== Math.floor(push.from / b.w)) {
        console.error(`assembly: push at ${push.from} wraps rows`);
        return null;
      }
      const walk = walkPath(b, player, behind, boxSet, ctx.standSet);
      if (walk === null) {
        console.error(`assembly: cannot reach push position ${behind}`);
        return null;
      }
      moves += walk;
      moves += dir.ch;
      boxSet[push.from] = 0;
      boxSet[push.to] = 1;
      player = push.from;
    }
    // Walk out, unless this room traps the player (solved last).
    if (!job.mustLast) {
      const out = walkPath(b, player, ctx.door, boxSet, ctx.standSet);
      if (out === null) {
        console.error(`assembly: cannot exit room at door ${ctx.door}`);
        return null;
      }
      moves += out;
      const d = DIRS.find((dd) => ctx.door + dd.dy * b.w + dd.dx === ctx.entry);
      if (d === undefined) return null;
      moves += d.ch;
      player = ctx.entry;
    }
  }
  return moves;
}

/** Replay the moves; true only when every box ends on a goal. */
function verify(b: Board, moves: string): boolean {
  const boxSet = new Uint8Array(b.w * b.h);
  for (const x of b.boxes) boxSet[x] = 1;
  let player = b.player;
  for (const ch of moves) {
    const d = DIRS.find((dd) => dd.ch === ch);
    if (d === undefined) return false;
    const next = player + d.dy * b.w + d.dx;
    if (d.dx !== 0 && Math.floor(next / b.w) !== Math.floor(player / b.w)) return false;
    if (next < 0 || next >= b.w * b.h || b.wall[next] === 1) return false;
    if (boxSet[next] === 1) {
      const beyond = next + d.dy * b.w + d.dx;
      if (d.dx !== 0 && Math.floor(beyond / b.w) !== Math.floor(next / b.w)) return false;
      if (beyond < 0 || beyond >= b.w * b.h || b.wall[beyond] === 1 || boxSet[beyond] === 1) return false;
      boxSet[next] = 0;
      boxSet[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < b.w * b.h; i++) {
    if (boxSet[i] === 1 && b.goal[i] !== 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  for (const id of IDS) {
    const outDir = join(outputDir, id);
    mkdirSync(outDir, { recursive: true });
    const levelPath = join(inputDir, id, "level.txt");
    let moves = "";
    if (existsSync(levelPath)) {
      try {
        const board = parseLevel(readFileSync(levelPath, "utf8"));
        // Per-level budget (R3): an earlier level's hard room must not
        // starve the levels after it.
        totalExpansions = 0;
        const solved = solveLevel(board);
        if (solved !== null && verify(board, solved)) {
          moves = solved;
        } else {
          console.error(`${id}: no verified solution, writing empty answer`);
        }
      } catch (e) {
        console.error(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.error(`${id}: level.txt missing`);
    }
    writeFileSync(join(outDir, "solution.txt"), moves, "utf8");
  }
}

main();
