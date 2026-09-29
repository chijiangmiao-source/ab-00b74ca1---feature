'use strict';

// 弱互模拟（weak bisimulation）与分支保持（branching bisimulation）核心：
// 校验、解析、按轮次淘汰，并为每项失败义务仅引用更早轮次已淘汰的状态对，
// 支持自底向上复算。
//
// 弱转移约定（静默前缀后承接同动作，不吸收动作后的尾部 tau）：
//   s ==tau=>  p 当且仅当 s ==epsilon=> p
//   s ==a===>  p 当且仅当存在 u：s ==epsilon=> u 且 u --a--> p   （a 可观察）
//
// 分支保持约定（候选响应可经过静默前缀，但前缀中的对应状态对必须仍留在同一轮
// 关系中，随后再承接同一动作）：
//   挑战 x --a--> x'（a 含 tau）由 y 承接，当且仅当存在静默路径
//     y = w0 =tau=> w1 =tau=> ... =tau=> wn
//   使得（可见动作）wn --a--> z，或（tau 挑战）z = wn，且：
//     * 每个中间状态 wi（0 < i < n）与挑战源 x 的配对仍存活；
//     * 落点配对 (x', z) 仍存活。
//   tau 挑战允许零步静默（留在 y，仅要求 (x', y) 存活）。

const TAU = 'tau';
const MAX_STATES = 18;
const MAX_VISIBLE_ACTIONS = 4;
const TOKEN_RE = /^[!-~]+$/; // 非空白可见 ASCII

// 单个挑战转移的静默前缀候选枚举上限（仅影响失败依据展示的完整性，
// 成败判定由受限可达性精确给出，与该上限无关）。
const PREFIX_EVIDENCE_CAP = 1000;

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

// ---------- 公共工具 ----------

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

// 无效输入时的统一返回：一次显示所有问题并清除旧结论。
function invalidResult(errors, mode) {
  const base = {
    ok: false,
    equivalent: null,
    errors,
    rounds: [],
    eliminatedPairs: [],
    firstEliminated: null,
    initialPairs: [],
  };
  return mode === 'branching' ? { mode, ...base } : base;
}

// 将存活集整理为对称呈现的最终关系与初始状态对结论。
function assembleResult({ mode, specA, specB, alive, rounds, elimination }) {
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

  const result = {
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
  return mode === 'branching' ? { mode, ...result } : result;
}

// ---------- 弱互模拟：按轮次淘汰 ----------
//
// R_0 为全部跨侧状态对；第 k 轮用上一轮存活集 R_{k-1} 检查每个存活对的
// 全部义务（对双方每个有弱转移的动作，挑战方每条弱转移都须由被挑战方
// 以静默前缀后承接同动作，且落点对仍存活）。无法履行义务的对在本轮淘汰。
// 因检查时 alive 尚未写入本轮淘汰，失败义务引用的落点对必然来自更早轮次。

function auditWeak(specA, specB) {
  const errors = [...validateSpec(specA, 'A'), ...validateSpec(specB, 'B')];
  if (errors.length) return invalidResult(errors);

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

  return assembleResult({ mode: 'weak', specA, specB, alive, rounds, elimination });
}

// ---------- 分支保持：静默前缀候选 ----------

function directTargets(proc, src, action) {
  return proc.out.get(src) && proc.out.get(src).get(action);
}

// 确定性枚举从 start 出发的全部非空简单 tau 路径（按目标状态字典序 DFS），
// 至多收集 cap 条；仅用于失败依据展示。
function enumerateTauPaths(proc, start, cap) {
  const paths = [];
  let truncated = false;
  (function dfs(path, visited) {
    const u = path[path.length - 1];
    const ts = directTargets(proc, u, TAU);
    if (!ts) return;
    for (const v of [...ts].sort()) {
      if (visited.has(v)) continue;
      paths.push([...path, v]);
      if (paths.length >= cap) {
        truncated = true;
        return;
      }
      visited.add(v);
      dfs(paths[paths.length - 1], visited);
      visited.delete(v);
      if (truncated) return;
    }
  })([start], new Set([start]));
  return { paths, truncated };
}

// 分支保持义务的成败判定（精确，不依赖候选枚举上限）：
// 静默路径上每个非终点中间状态必须与挑战源 challengerSrc 仍配对存活；
// 落点必须与挑战转移目标 challengeTarget 配对存活。
//
// 可达性：以应答状态 start 为起点，沿“进入仍配对存活状态”的 tau 边扩展；
// 每条 tau 边的目标无论是否可作中间状态，都先作为可能终点检验落点。
function branchingMatch({ challenger, challengerSrc, challengeTarget, responderProc, start, action, alive }) {
  const relatedKey = (rstate) =>
    challenger === 'A' ? pairKey(challengerSrc, rstate) : pairKey(rstate, challengerSrc);
  const landingKey = (rstate) =>
    challenger === 'A' ? pairKey(challengeTarget, rstate) : pairKey(rstate, challengeTarget);

  const endpointAlive = (z) => alive.has(landingKey(z));

  // 零步静默前缀
  if (action === TAU) {
    if (endpointAlive(start)) return true;
  } else {
    const ts = directTargets(responderProc, start, action);
    if (ts) for (const z of ts) if (endpointAlive(z)) return true;
  }

  // 非零静默前缀：tau 边到达 v 后——
  //   * v 与挑战源仍配对存活：v 可作前缀内部状态（含可见动作的承接点），
  //     也可继续沿 tau 延伸；tau 挑战下 v 本身亦可作为最终落点；
  //   * v 不配对存活：仅可作为 tau 挑战的最终落点（落点对另算），不可继续穿越。
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const w = queue.shift();
    const ts = directTargets(responderProc, w, TAU);
    if (!ts) continue;
    for (const v of ts) {
      if (alive.has(relatedKey(v))) {
        if (action === TAU) {
          if (endpointAlive(v)) return true;
        } else {
          const az = directTargets(responderProc, v, action);
          if (az) for (const z of az) if (endpointAlive(z)) return true;
        }
        if (!seen.has(v)) {
          seen.add(v);
          queue.push(v);
        }
      } else if (action === TAU && endpointAlive(v)) {
        return true;
      }
    }
  }
  return false;
}

// 为失败的挑战转移构造全部静默前缀候选及其同轮关系违约依据。
function branchingCandidates({ challenger, challengerSrc, challengeTarget, responderProc, start, action, alive, eliminateRound }) {
  const candidates = [];
  let truncated = false;
  const pushCandidate = (prefix, target) => {
    if (candidates.length >= PREFIX_EVIDENCE_CAP) {
      truncated = true;
      return;
    }
    const violations = [];
    // 静默前缀内部状态必须与挑战源仍在同一轮关系中：
    //   * tau 挑战：落点即前缀终点，不检查其关联性（落点对另算）；
    //   * 可见动作：承接动作的最后一个静默状态同样必须仍配对存活。
    const internal = action === TAU ? prefix.slice(1, -1) : prefix.slice(1);
    for (const w of internal) {
      const pk = challenger === 'A' ? pairKey(challengerSrc, w) : pairKey(w, challengerSrc);
      if (!alive.has(pk)) {
        violations.push({ kind: 'PREFIX_PAIR', state: w, pair: asAB(challenger, pk), eliminatedRound: eliminateRound.get(pk) });
      }
    }
    const lk = challenger === 'A' ? pairKey(challengeTarget, target) : pairKey(target, challengeTarget);
    if (!alive.has(lk)) {
      violations.push({ kind: 'LANDING_PAIR', state: target, pair: asAB(challenger, lk), eliminatedRound: eliminateRound.get(lk) });
    }
    candidates.push({
      prefix: prefix.slice(),
      action,
      target,
      ok: violations.length === 0,
      violations,
    });
  };

  const { paths, truncated: pathTruncated } = enumerateTauPaths(responderProc, start, PREFIX_EVIDENCE_CAP);
  truncated = truncated || pathTruncated;

  if (action === TAU) {
    // 零步静默：留在 start
    pushCandidate([start], start);
    // 非零静默路径，整条路径的终点即落点
    for (const p of paths) {
      pushCandidate(p, p[p.length - 1]);
      if (truncated) break;
    }
  } else {
    // 零步前缀：start 直接承接可观察动作
    const zero = directTargets(responderProc, start, action);
    if (zero) for (const z of [...zero].sort()) pushCandidate([start], z);
    // 非零静默前缀到达 u，再由 u 承接动作
    for (const p of paths) {
      const u = p[p.length - 1];
      const ts = directTargets(responderProc, u, action);
      if (ts) for (const z of [...ts].sort()) {
        pushCandidate(p, z);
        if (truncated) break;
      }
      if (truncated) break;
    }
  }

  // 候选按落点状态、静默前缀长度、前缀状态序列稳定排序
  candidates.sort((u, v) =>
    (u.target < v.target ? -1 : u.target > v.target ? 1 : 0)
    || u.prefix.length - v.prefix.length
    || (() => {
      for (let i = 0; i < Math.max(u.prefix.length, v.prefix.length); i += 1) {
        const a = u.prefix[i] || '';
        const b = v.prefix[i] || '';
        if (a !== b) return a < b ? -1 : 1;
      }
      return 0;
    })());

  return { candidates, truncated };
}

// ---------- 分支保持：按轮次淘汰 ----------
//
// 与弱互模拟同一套 R_0 起逐轮淘汰骨架；区别仅在义务检查：挑战只看强迁移
// （tau 不再展开为整个静默闭包），应答允许静默前缀，但前缀中的对应状态对
// 必须仍留在上一轮存活集（同一轮关系）中，随后再承接同一动作。

function auditBranching(specA, specB) {
  const mode = 'branching';
  const errors = [...validateSpec(specA, 'A'), ...validateSpec(specB, 'B')];
  if (errors.length) return invalidResult(errors, mode);

  const A = normalize(specA);
  const B = normalize(specB);
  const actionList = sortedActions(A, B);

  const allPairs = [];
  for (const x of A.names) for (const y of B.names) allPairs.push(pairKey(x, y));

  // 预计算每个状态对的全部强迁移义务（含 tau 强转移）：
  // 动作顺序固定；同一动作 A 方挑战排在 B 方挑战之前。
  const duties = new Map();
  for (const x of A.names) {
    for (const y of B.names) {
      const list = [];
      for (const action of actionList) {
        const aSrc = directTargets(A, x, action);
        const bSrc = directTargets(B, y, action);
        if (aSrc && aSrc.size) list.push({ action, challenger: 'A', responder: 'B', sources: [...aSrc].sort() });
        if (bSrc && bSrc.size) list.push({ action, challenger: 'B', responder: 'A', sources: [...bSrc].sort() });
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
      const [x, y] = splitKey(key);
      let firstFailure = null;

      for (const d of duties.get(key)) {
        const responderProc = d.responder === 'A' ? A : B;
        const start = d.challenger === 'A' ? y : x;
        const challengerSrc = d.challenger === 'A' ? x : y;
        const failedTransitions = [];
        let evidenceTruncated = false;

        for (const src of d.sources) {
          const matched = branchingMatch({
            challenger: d.challenger,
            challengerSrc,
            challengeTarget: src,
            responderProc,
            start,
            action: d.action,
            alive,
          });
          if (matched) continue;

          // 失败：展开全部静默前缀候选及其同轮关系违约
          const { candidates, truncated } = branchingCandidates({
            challenger: d.challenger,
            challengerSrc,
            challengeTarget: src,
            responderProc,
            start,
            action: d.action,
            alive,
            eliminateRound,
          });
          evidenceTruncated = evidenceTruncated || truncated;
          failedTransitions.push({
            source: src,
            reason: candidates.length === 0 ? 'NO_MATCHING_ACTION' : 'NO_VALID_PREFIX',
            candidates,
          });
        }

        if (failedTransitions.length && firstFailure === null) {
          firstFailure = {
            action: d.action,
            challenger: d.challenger,
            responder: d.responder,
            // 挑战转移按源状态稳定排序
            transitions: failedTransitions.sort((u, v) => (u.source < v.source ? -1 : u.source > v.source ? 1 : 0)),
            evidenceTruncated: evidenceTruncated,
          };
        }
      }

      if (firstFailure) {
        const pair = [x, y];
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

  return assembleResult({ mode, specA, specB, alive, rounds, elimination });
}

// ---------- 入口 ----------

function audit(specA, specB, mode = 'weak') {
  if (mode === 'branching') {
    const result = auditBranching(specA, specB);
    // 与普通弱互模拟并列显示：分支保持结果内嵌同一输入下的普通弱互模拟结论。
    // 输入无效时弱结论同样为空结论（无等价判定、无轮次、无依据），不残留旧判定。
    result.weak = auditWeak(specA, specB);
    return result;
  }
  return auditWeak(specA, specB);
}

module.exports = {
  TAU,
  MAX_STATES,
  MAX_VISIBLE_ACTIONS,
  validateSpec,
  normalize,
  epsilonClosure,
  weakTargets,
  enumerateTauPaths,
  audit,
  auditWeak,
  auditBranching,
};
