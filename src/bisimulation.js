'use strict';

// 弱互模拟（weak bisimulation）核心：校验、解析、按轮次淘汰，
// 并为每项失败义务仅引用更早轮次已淘汰的状态对，支持自底向上复算。
//
// 弱转移约定（静默前缀后承接同动作，不吸收动作后的尾部 tau）：
//   s ==tau=>  p 当且仅当 s ==epsilon=> p
//   s ==a===>  p 当且仅当存在 u：s ==epsilon=> u 且 u --a--> p   （a 可观察）

const TAU = 'tau';
const MAX_STATES = 18;
const MAX_VISIBLE_ACTIONS = 4;
const TOKEN_RE = /^[!-~]+$/; // 非空白可见 ASCII

// ---------- 校验：一次收集全部问题 ----------

function validateSpec(spec, side) {
  const errors = [];
  const push = (code, field, message) => errors.push({ code, field, side, message });

  const states = Array.isArray(spec && spec.states) ? spec.states : [];
  const transitions = Array.isArray(spec && spec.transitions) ? spec.transitions : [];
  const initial = spec && typeof spec.initial === 'string' ? spec.initial : '';

  const seenNames = new Set();
  for (const raw of states) {
    const name = typeof raw === 'string' ? raw : raw && raw.name;
    if (typeof name !== 'string' || name.length === 0) {
      push('STATE_NAME_MISSING', 'states', '存在缺少名称的状态');
      continue;
    }
    if (!TOKEN_RE.test(name)) push('STATE_NAME_INVALID', 'states', `状态名必须为非空白可见 ASCII：${JSON.stringify(name)}`);
    if (seenNames.has(name)) push('STATE_DUPLICATE', 'states', `状态名重复：${name}`);
    seenNames.add(name);
  }
  if (states.length > MAX_STATES) {
    push('STATE_LIMIT', 'states', `状态数 ${states.length} 超出上限 ${MAX_STATES}`);
  }

  const visibleActions = new Set();
  const seenTids = new Set();
  for (const t of transitions) {
    if (!t || typeof t !== 'object') {
      push('TRANSITION_INVALID', 'transitions', '存在不是对象的迁移');
      continue;
    }
    const { id, from, action, to } = t;
    if (typeof id !== 'string' || id.length === 0) {
      push('TID_MISSING', 'transitions', '存在缺少唯一标识的迁移');
    } else if (!TOKEN_RE.test(id)) {
      push('TID_INVALID', 'transitions', `迁移标识必须为非空白可见 ASCII：${JSON.stringify(id)}`);
    } else if (seenTids.has(id)) {
      push('TID_DUPLICATE', 'transitions', `迁移标识重复：${id}`);
    } else {
      seenTids.add(id);
    }
    for (const key of ['from', 'to']) {
      const v = t[key];
      if (typeof v !== 'string' || v.length === 0) {
        push('ENDPOINT_MISSING', 'transitions', `迁移 ${id || '?'} 缺少 ${key} 端点`);
      } else if (!seenNames.has(v)) {
        push('ENDPOINT_UNKNOWN', 'transitions', `迁移 ${id || '?'} 的 ${key} 端点未声明：${v}`);
      }
    }
    if (typeof action !== 'string' || action.length === 0) {
      push('ACTION_MISSING', 'transitions', `迁移 ${id || '?'} 缺少动作`);
    } else if (action === TAU) {
      // 静默内部动作
    } else if (!TOKEN_RE.test(action)) {
      push('ACTION_INVALID', 'transitions', `迁移 ${id || '?'} 的动作必须为 tau 或非空白可见 ASCII：${JSON.stringify(action)}`);
    } else {
      visibleActions.add(action);
    }
  }
  if (visibleActions.size > MAX_VISIBLE_ACTIONS) {
    push('ACTION_LIMIT', 'actions', `可观察动作种类 ${visibleActions.size} 超出上限 ${MAX_VISIBLE_ACTIONS}`);
  }

  if (!initial) {
    push('INITIAL_MISSING', 'initial', '未设置初始状态');
  } else if (!seenNames.has(initial)) {
    push('INITIAL_UNKNOWN', 'initial', `初始状态未声明：${initial}`);
  }

  return errors;
}

// ---------- 规范化 ----------

function normalize(spec) {
  const names = spec.states.map((s) => (typeof s === 'string' ? s : s.name)).sort();
  const stateSet = new Set(names);
  const actions = new Set();
  const out = new Map(names.map((n) => [n, new Map()]));
  for (const t of spec.transitions) {
    if (!stateSet.has(t.from) || !stateSet.has(t.to) || typeof t.action !== 'string' || !t.action) continue;
    actions.add(t.action);
    if (!out.get(t.from).has(t.action)) out.get(t.from).set(t.action, new Set());
    out.get(t.from).get(t.action).add(t.to);
  }
  return { names, stateSet, actions, out, initial: spec.initial };
}

// ---------- 弱转移 ----------

function epsilonClosure(proc, src) {
  const seen = new Set([src]);
  const stack = [src];
  while (stack.length) {
    const u = stack.pop();
    const tauTargets = proc.out.get(u) && proc.out.get(u).get(TAU);
    if (tauTargets) {
      for (const v of tauTargets) {
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
  }
  return seen;
}

function weakTargets(proc, src, action) {
  const result = new Set();
  if (action === TAU) {
    for (const p of epsilonClosure(proc, src)) result.add(p);
    return result;
  }
  for (const u of epsilonClosure(proc, src)) {
    const ts = proc.out.get(u).get(action);
    if (ts) for (const p of ts) result.add(p);
  }
  return result;
}

// ---------- 按轮次淘汰 ----------
//
// R_0 为全部跨侧状态对；第 k 轮用上一轮存活集 R_{k-1} 检查每个存活对的
// 全部义务（对双方每个有弱转移的动作，挑战方每条弱转移都须由被挑战方
// 以静默前缀后承接同动作，且落点对仍存活）。无法履行义务的对在本轮淘汰。
// 因检查时 alive 尚未写入本轮淘汰，失败义务引用的落点对必然来自更早轮次。

function pairKey(a, b) {
  return `${a} ${b}`;
}
function splitKey(k) {
  const i = k.indexOf(' ');
  return [k.slice(0, i), k.slice(i + 1)];
}
function cmpPair(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}
function asAB(challenger, pk) {
  const [p, q] = splitKey(pk);
  // 统一以 [A 侧状态, B 侧状态] 展示
  return challenger === 'A' ? [p, q] : [q, p];
}

function sortedActions(A, B) {
  const actions = new Set([...A.actions, ...B.actions]);
  return [...actions].sort((x, y) => {
    if (x === TAU) return 1;
    if (y === TAU) return -1;
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function audit(specA, specB) {
  const errors = [...validateSpec(specA, 'A'), ...validateSpec(specB, 'B')];
  if (errors.length) {
    // 输入无效：一次显示所有问题并清除旧结论（无等价判定、无轮次）
    return { ok: false, equivalent: null, errors, rounds: [], eliminatedPairs: [], firstEliminated: null, initialPairs: [] };
  }

  const A = normalize(specA);
  const B = normalize(specB);
  const actionList = sortedActions(A, B);

  const allPairs = [];
  for (const x of A.names) for (const y of B.names) allPairs.push(pairKey(x, y));

  // 预计算每个状态对的全部义务（与轮次无关）：
  // 动作顺序固定；同一动作 A 方挑战排在 B 方挑战之前。
  const duties = new Map();
  for (const x of A.names) {
    for (const y of B.names) {
      const list = [];
      for (const action of actionList) {
        const aSrc = weakTargets(A, x, action);
        const bSrc = weakTargets(B, y, action);
        if (aSrc.size) list.push({ action, challenger: 'A', responder: 'B', sources: [...aSrc].sort() });
        if (bSrc.size) list.push({ action, challenger: 'B', responder: 'A', sources: [...bSrc].sort() });
      }
      duties.set(pairKey(x, y), list);
    }
  }

  const alive = new Set(allPairs); // R_0
  const eliminateRound = new Map(); // pairKey -> 淘汰轮次
  const elimination = new Map(); // pairKey -> 详情
  const rounds = [];
  let roundNo = 0;

  while (true) {
    roundNo += 1;
    const removed = [];

    for (const key of allPairs) {
      if (!alive.has(key)) continue;
      let firstFailure = null;

      for (const d of duties.get(key)) {
        const responderProc = d.responder === 'A' ? A : B;
        const responderState = d.challenger === 'A' ? splitKey(key)[1] : splitKey(key)[0];
        const responderTargets = weakTargets(responderProc, responderState, d.action);
        const failedTransitions = [];

        if (responderTargets.size === 0) {
          // 该侧完全无法承接此动作
          for (const src of d.sources) {
            failedTransitions.push({ source: src, reason: 'NO_MATCHING_ACTION', responses: [] });
          }
        } else {
          const targetsSorted = [...responderTargets].sort();
          for (const src of d.sources) {
            const responses = [];
            let matched = false;
            for (const tgt of targetsSorted) {
              const pk = d.challenger === 'A' ? pairKey(src, tgt) : pairKey(tgt, src);
              if (alive.has(pk)) {
                matched = true; // 存在仍存活的候选响应即履行义务
              } else {
                responses.push({ target: tgt, pair: asAB(d.challenger, pk), eliminatedRound: eliminateRound.get(pk) });
              }
            }
            if (!matched) {
              // 依据按轮次递减、再按状态对稳定排序；只引用更早轮次的淘汰结果
              responses.sort((u, v) => v.eliminatedRound - u.eliminatedRound || cmpPair(u.pair, v.pair));
              failedTransitions.push({ source: src, reason: 'ALL_RESPONSES_ELIMINATED', responses });
            }
          }
        }

        if (failedTransitions.length && firstFailure === null) {
          firstFailure = {
            action: d.action,
            challenger: d.challenger,
            responder: d.responder,
            // 挑战转移按源状态稳定排序
            transitions: failedTransitions.sort((u, v) => (u.source < v.source ? -1 : u.source > v.source ? 1 : 0)),
          };
        }
      }

      if (firstFailure) {
        const pair = splitKey(key);
        removed.push({ key, detail: { pair, round: roundNo, ...firstFailure } });
      }
    }

    removed.sort((r1, r2) => cmpPair(r1.detail.pair, r2.detail.pair));
    rounds.push({
      round: roundNo,
      eliminated: removed.map((r) => ({ pair: r.detail.pair, action: r.detail.action, challenger: r.detail.challenger })),
    });

    if (removed.length === 0) break; // 到达不动点
    for (const r of removed) {
      alive.delete(r.key);
      eliminateRound.set(r.key, roundNo);
      elimination.set(r.key, r.detail);
    }
  }

  // 关系按对称二元关系呈现：同时包含 (A态,B态) 与 (B态,A态) 两个方向，
  // 因而初始状态在关系中产生两个初始状态对。
  const keyAB = pairKey(specA.initial, specB.initial);
  const initSurvives = alive.has(keyAB);
  const equivalent = initSurvives;

  const eliminatedPairs = [...elimination.values()].sort((x, y) => x.round - y.round || cmpPair(x.pair, y.pair));
  const canonicalRelation = [...alive].map(splitKey).sort(cmpPair);
  const finalRelation = [
    ...canonicalRelation.map(([a, b]) => [a, b]),
    ...canonicalRelation.map(([a, b]) => [b, a]),
  ].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));

  return {
    ok: true,
    equivalent,
    errors: [],
    rounds,
    finalRelation,
    eliminatedPairs,
    firstEliminated: eliminatedPairs.length ? eliminatedPairs[0] : null,
    initialPairs: [
      [specA.initial, specB.initial],
      [specB.initial, specA.initial],
    ],
    initialAlive: [initSurvives, initSurvives],
  };
}

// ---------- 分支保持（branching bisimulation）---------
//
// 与普通弱互模拟的关键区别：候选响应可经过静默（tau）前缀，但前缀途中每个
// 应答状态 qi 都必须仍与“挑战发起状态”配对（留在同一轮关系中），随后再承接
// 同一动作；tau 挑战额外允许应答方原地不动（idle）承接。
//
//   挑战 p --a--> p'（a 可观察）：
//     存在应答路径 q =q0=tau=> q1 =tau=> ... =tau=> qn --a--> qf，
//     使每个前缀对 (p, qi) 与落点对 (p', qf) 都仍在本轮关系中。
//   挑战 p --tau--> p'：
//     可由应答方原地不动承接：(p', q) 仍在关系中；
//     或走上述静默前缀（末步为 tau）承接。
//
// 仍按轮次淘汰：R_0 为全集，第 k 轮依据上一轮存活集 R_{k-1} 同步确定本轮
// 淘汰集，不动点后再统一生成证据并按第 k 轮判定视角着色：
//   - 落点/前缀对在第 1..k-1 轮淘汰 → eliminated（拒绝锚点，附淘汰轮次）；
//   - 与本对在第 k 轮同批淘汰        → same-round（同轮关系违约，不附轮次）；
//   - 第 k 轮仍存活、更晚轮次才淘汰  → later-round（信息性，非违约）；
//   - 落在最终关系中 → alive；本对自身 → self。
// 失败候选必然至少含一个更早轮次淘汰锚点（否则该候选在 R_{k-1} 中成立，
// 本对不会进入本轮淘汰集），同轮违约节点作为附加依据一并呈现。

const MAX_BRANCHING_CANDIDATES = 32;

function strongTargets(proc, state, action) {
  const m = proc.out.get(state);
  const ts = m && m.get(action);
  return ts ? [...ts].sort() : [];
}

// 沿 tau 边、且只经过 allowed 中状态的可达集合（含起点，前提是起点允许）
function reachableThrough(proc, start, allowed) {
  const seen = new Set();
  if (!allowed.has(start)) return seen;
  seen.add(start);
  const stack = [start];
  while (stack.length) {
    const u = stack.pop();
    for (const v of strongTargets(proc, u, TAU)) {
      if (allowed.has(v) && !seen.has(v)) {
        seen.add(v);
        stack.push(v);
      }
    }
  }
  return seen;
}

// 单条挑战强迁移 p --action--> edgeTarget 能否由应答方以分支保持方式承接
function branchingEdgeHolds(A, B, x, y, duty, edgeTarget, alive) {
  const fromA = duty.challenger === 'A';
  const responder = fromA ? B : A;
  const start = fromA ? y : x;

  // idle：仅 tau 挑战可用，应答方原地不动
  if (duty.action === TAU) {
    const idle = fromA ? pairKey(edgeTarget, start) : pairKey(start, edgeTarget);
    if (alive.has(idle)) return true;
  }

  // 与挑战发起状态仍配对的应答侧状态集合（前缀只允许穿行其中）
  if (fromA) {
    const allowed = new Set();
    for (const q of B.names) if (alive.has(pairKey(x, q))) allowed.add(q);
    for (const qn of reachableThrough(B, start, allowed)) {
      for (const qf of strongTargets(B, qn, duty.action)) {
        if (alive.has(pairKey(edgeTarget, qf))) return true;
      }
    }
  } else {
    const allowed = new Set();
    for (const p of A.names) if (alive.has(pairKey(p, y))) allowed.add(p);
    for (const qn of reachableThrough(A, start, allowed)) {
      for (const qf of strongTargets(A, qn, duty.action)) {
        if (alive.has(pairKey(qf, edgeTarget))) return true;
      }
    }
  }
  return false;
}

// 分支保持义务是否成立（存在性，按上一轮存活集）
function branchingDutyHolds(A, B, ownerKey, duty, alive) {
  const [x, y] = splitKey(ownerKey);
  return duty.edges.every((edgeTarget) => branchingEdgeHolds(A, B, x, y, duty, edgeTarget, alive));
}

// 枚举全部简单静默前缀候选（至多 MAX_BRANCHING_CANDIDATES 条，稳定 DFS 序），
// 用于证据展示；判定只依赖 branchingDutyHolds，不依赖枚举是否截断。
function enumerateCandidates(proc, start, action) {
  const out = [];
  let truncated = false;
  const path = [start];
  const onPath = new Set([start]);

  const emitFrom = (qn) => {
    for (const qf of strongTargets(proc, qn, action)) {
      if (out.length >= MAX_BRANCHING_CANDIDATES) { truncated = true; return; }
      out.push({ prefix: path.slice(1), target: qf });
    }
  };

  const dfs = () => {
    emitFrom(path[path.length - 1]);
    if (truncated) return;
    for (const v of strongTargets(proc, path[path.length - 1], TAU)) {
      if (onPath.has(v)) continue; // 只枚举简单路径：环上重复状态可删去
      path.push(v);
      onPath.add(v);
      dfs();
      onPath.delete(v);
      path.pop();
      if (truncated) return;
    }
  };
  dfs();
  return { candidates: out, truncated };
}

function cmpLexArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function cmpCandidates(c1, c2) {
  if (c1.kind !== c2.kind) return c1.kind === 'idle' ? -1 : 1;
  const p = cmpLexArrays(c1.prefix, c2.prefix);
  if (p !== 0) return p;
  return c1.target < c2.target ? -1 : c1.target > c2.target ? 1 : 0;
}

function auditBranching(specA, specB) {
  const errors = [...validateSpec(specA, 'A'), ...validateSpec(specB, 'B')];
  if (errors.length) {
    return { ok: false, mode: 'branching', equivalent: null, errors, rounds: [], eliminatedPairs: [], firstEliminated: null, initialPairs: [] };
  }

  const A = normalize(specA);
  const B = normalize(specB);
  const actionList = sortedActions(A, B);

  const allPairs = [];
  for (const x of A.names) for (const y of B.names) allPairs.push(pairKey(x, y));

  // 预计算义务：基于“强迁移”（与弱模式按弱转移建义务不同，这是区分度来源）。
  const duties = new Map();
  for (const x of A.names) {
    for (const y of B.names) {
      const list = [];
      for (const action of actionList) {
        const aEdges = strongTargets(A, x, action);
        const bEdges = strongTargets(B, y, action);
        if (aEdges.length) list.push({ action, challenger: 'A', responder: 'B', edges: aEdges });
        if (bEdges.length) list.push({ action, challenger: 'B', responder: 'A', edges: bEdges });
      }
      duties.set(pairKey(x, y), list);
    }
  }

  const alive = new Set(allPairs); // R_0
  const eliminateRound = new Map(); // pairKey -> 淘汰轮次
  const failureFacts = new Map(); // pairKey -> 首个失败义务的最小事实
  const rounds = [];
  let roundNo = 0;

  while (true) {
    roundNo += 1;
    const removed = [];

    // 依据 R_{k-1} 同步确定本轮淘汰集合：本轮先不修改 alive，
    // 故同批对彼此可见，淘汰集合可一次性确定。
    for (const key of allPairs) {
      if (!alive.has(key)) continue;
      const [x, y] = splitKey(key);

      for (const d of duties.get(key)) {
        if (branchingDutyHolds(A, B, key, d, alive)) continue;
        const failedEdges = d.edges
          .filter((edgeTarget) => !branchingEdgeHolds(A, B, x, y, d, edgeTarget, alive))
          .sort((u, v) => (u < v ? -1 : u > v ? 1 : 0))
          .map((edgeTarget) => ({ source: d.challenger === 'A' ? x : y, target: edgeTarget }));
        removed.push({
          key,
          fact: { pair: [x, y], round: roundNo, action: d.action, challenger: d.challenger, responder: d.responder, edges: failedEdges },
        });
        break; // 仅保留首个失败义务（动作序、挑战方序稳定）
      }
    }

    removed.sort((r1, r2) => cmpPair(r1.fact.pair, r2.fact.pair));
    rounds.push({
      round: roundNo,
      eliminated: removed.map((r) => ({ pair: r.fact.pair, action: r.fact.action, challenger: r.fact.challenger })),
    });

    if (removed.length === 0) break; // 到达不动点
    for (const r of removed) {
      alive.delete(r.key);
      eliminateRound.set(r.key, roundNo);
      failureFacts.set(r.key, r.fact);
    }
  }

  // 不动点确定后统一生成证据，并按“第 k 轮判定时的关系视角”（R_{k-1}）着色：
  //   eliminated  节点在第 1..k-1 轮已淘汰：不在 R_{k-1} 中，是候选被拒的锚点
  //   same-round  节点与本对在第 k 轮同批淘汰：R_{k-1} 中尚存活，构成本轮同轮关系违约
  //   later-round 节点第 k 轮时仍存活、在更晚轮次才淘汰：非违约，仅信息性标注
  //   alive       节点落在最终关系中
  //   self        本对自身
  // 本对在第 k 轮淘汰意味着存在被 R_{k-1} 拒绝的候选：该候选必含 eliminated
  // （更早轮次淘汰）锚点——same-round/later-round 节点当时仍存活，单独不足以拒绝。
  const eliminatedPairs = [...failureFacts.values()].map((fact) => {
    const key = pairKey(fact.pair[0], fact.pair[1]);
    const [x, y] = fact.pair;
    const fromA = fact.challenger === 'A';
    const responder = fromA ? B : A;
    const start = fromA ? y : x;

    const nodeStatus = (pk) => {
      if (pk === key) return { status: 'self' };
      const r = eliminateRound.get(pk);
      if (r === undefined) return { status: 'alive' };
      if (r < fact.round) return { status: 'eliminated', eliminatedRound: r };
      if (r === fact.round) return { status: 'same-round' };
      return { status: 'later-round', eliminatedRound: r };
    };

    const transitions = fact.edges.map((e) => {
      const t = { source: e.source, target: e.target };
      // 应答侧在整个静默闭包中是否根本没有该动作
      let structurallyPossible = false;
      for (const u of epsilonClosure(responder, start)) {
        if (strongTargets(responder, u, fact.action).length) { structurallyPossible = true; break; }
      }
      if (!structurallyPossible) return { ...t, reason: 'NO_MATCHING_ACTION', candidates: [], truncated: false };

      const candidates = [];
      if (fact.action === TAU) {
        // idle 候选：应答方原地不动
        const idleAB = fromA ? [e.target, y] : [x, e.target];
        candidates.push({
          kind: 'idle',
          prefix: [],
          target: start,
          landingPair: idleAB,
          landing: nodeStatus(pairKey(idleAB[0], idleAB[1])),
          prefixPairs: [],
        });
      }

      const { candidates: paths, truncated } = enumerateCandidates(responder, start, fact.action);
      for (const c of paths) {
        const prefixPairs = c.prefix.map((q) => {
          // 前缀状态 qi 与挑战发起状态 x/y 配对
          const ab = fromA ? [x, q] : [q, y];
          return { state: q, pair: ab, ...nodeStatus(pairKey(ab[0], ab[1])) };
        });
        const landingAB = fromA ? [e.target, c.target] : [c.target, e.target];
        candidates.push({
          kind: 'path',
          prefix: c.prefix,
          target: c.target,
          landingPair: landingAB,
          landing: nodeStatus(pairKey(landingAB[0], landingAB[1])),
          prefixPairs,
        });
      }
      candidates.sort(cmpCandidates);
      return { ...t, reason: 'ALL_CANDIDATES_REJECTED', candidates, truncated };
    });

    // 失败挑战边按源状态、目标稳定排序
    transitions.sort((u, v) => {
      const cs = u.source < v.source ? -1 : u.source > v.source ? 1 : 0;
      if (cs !== 0) return cs;
      return u.target < v.target ? -1 : u.target > v.target ? 1 : 0;
    });

    return {
      pair: fact.pair,
      round: fact.round,
      action: fact.action,
      challenger: fact.challenger,
      responder: fact.responder,
      transitions,
    };
  }).sort((u, v) => u.round - v.round || cmpPair(u.pair, v.pair));

  const keyAB = pairKey(specA.initial, specB.initial);
  const initSurvives = alive.has(keyAB);

  const canonicalRelation = [...alive].map(splitKey).sort(cmpPair);
  const finalRelation = [
    ...canonicalRelation.map(([a, b]) => [a, b]),
    ...canonicalRelation.map(([a, b]) => [b, a]),
  ].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));

  return {
    ok: true,
    mode: 'branching',
    equivalent: initSurvives,
    errors: [],
    rounds,
    finalRelation,
    eliminatedPairs,
    firstEliminated: eliminatedPairs.length ? eliminatedPairs[0] : null,
    initialPairs: [
      [specA.initial, specB.initial],
      [specB.initial, specA.initial],
    ],
    initialAlive: [initSurvives, initSurvives],
  };
}

module.exports = {
  TAU,
  MAX_STATES,
  MAX_VISIBLE_ACTIONS,
  validateSpec,
  normalize,
  epsilonClosure,
  weakTargets,
  audit,
  auditBranching,
};
