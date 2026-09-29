'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditWeak, auditBranching, weakTargets, normalize, TAU } = require('../src/bisimulation');
const { samples } = require('../src/samples');

test('仅以 tau 环重命名而等价：关系包含两个初始状态对', () => {
  const r = audit(samples.equivalent.procA, samples.equivalent.procB);
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, true);
  assert.deepEqual(r.initialPairs, [['S0', 'P0'], ['P0', 'S0']]);
  assert.ok(r.initialAlive.every(Boolean));
  assert.ok(r.finalRelation.some((p) => p[0] === 'S0' && p[1] === 'P0'));
  assert.ok(r.finalRelation.some((p) => p[0] === 'P0' && p[1] === 'S0'));
  // 行为不同的配对（如 S0 与终态 P1）被淘汰属正常；初始对存活即等价
  assert.ok(!r.eliminatedPairs.some((p) => p.pair[0] === 'S0' && p.pair[1] === 'P0'));
});

test('缺失匹配动作：不等价，首个失败义务是缺失侧无法承接的动作', () => {
  const r = audit(samples.missing.procA, samples.missing.procB);
  assert.equal(r.equivalent, false);
  const f = r.firstEliminated;
  assert.equal(f.action, 'x'); // 有 x 的 A 方挑战，B 方无法承接
  assert.equal(f.challenger, 'A');
  assert.ok(f.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));
  // 四个跨侧对中三个无法匹配（死态对 (a1,b1) 存活）
  assert.equal(r.rounds[0].eliminated.length, 3);
  const initPair = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(initPair.round, 1);
});

test('多轮级联：初始对第 2 轮淘汰，失败义务只引用第 1 轮淘汰对', () => {
  const r = audit(samples.cascade.procA, samples.cascade.procB);
  assert.equal(r.equivalent, false);

  const p11 = r.eliminatedPairs.find((p) => p.pair[0] === 'a1' && p.pair[1] === 'b1');
  assert.equal(p11.round, 1);
  assert.equal(p11.action, 'y');

  const p00 = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(p00.round, 2);
  assert.equal(p00.action, 'x');
  assert.equal(p00.challenger, 'A');

  const fail = p00.transitions.find((t) => t.source === 'a1');
  assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
  assert.equal(fail.responses.length, 1);
  assert.deepEqual(fail.responses[0].pair, ['a1', 'b1']);
  assert.equal(fail.responses[0].eliminatedRound, 1);

  // 每条失败义务的依据都来自严格更早的轮次（自底向上可复算）
  for (const ep of r.eliminatedPairs) {
    for (const t of ep.transitions) {
      if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
        for (const w of t.responses) {
          assert.ok(typeof w.eliminatedRound === 'number');
          assert.ok(w.eliminatedRound < ep.round, `依据轮次应更早: ${JSON.stringify(w)} in round ${ep.round}`);
        }
        // 依据按轮次递减排序
        const rounds = t.responses.map((w) => w.eliminatedRound);
        assert.deepEqual(rounds, [...rounds].sort((x, y) => y - x));
      }
    }
  }
});

test('tau 链上的弱转移：静默前缀后承接动作', () => {
  const proc = normalize({
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }, { name: 'v' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'p' },
      { id: '3', from: 'p', action: 'a', to: 'v' },
    ],
  });
  assert.deepEqual([...weakTargets(proc, 's', 'a')], ['v']);
  assert.deepEqual([...weakTargets(proc, 's', TAU)].sort(), ['p', 's', 'u']);
});

test('静默前缀 + 可观察承接的典型等价：tau 前缀进程与直接动作进程', () => {
  const A = {
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'u' }, // tau 自环
      { id: '3', from: 'u', action: 'a', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: '1', from: 'q', action: 'a', to: 'r' }],
  };
  const r = audit(A, B);
  assert.equal(r.equivalent, true);
});

test('输入无效：一次显示所有问题并清除旧结论', () => {
  const bad = {
    states: [{ name: 'x' }, { name: 'x' }, {}, { name: 'bad name' }],
    initial: 'ghost',
    transitions: [
      { id: 't', from: 'x', action: '', to: 'nope' },
      { id: 't', from: 'x', action: 'foo', to: 'x' },
      { id: 'a1', from: 'x', action: 'a', to: 'x' },
      { id: 'a2', from: 'x', action: 'b', to: 'x' },
      { id: 'a3', from: 'x', action: 'c', to: 'x' },
      { id: 'a4', from: 'x', action: 'd', to: 'x' },
      { id: 'a5', from: 'x', action: 'e', to: 'x' },
    ],
  };
  const r = audit(bad, { states: [], initial: '', transitions: [] });
  assert.equal(r.ok, false);
  assert.equal(r.equivalent, null);
  const codes = r.errors.map((e) => e.code);
  for (const code of [
    'STATE_DUPLICATE',
    'STATE_NAME_INVALID',
    'STATE_NAME_MISSING',
    'INITIAL_UNKNOWN',
    'ENDPOINT_UNKNOWN',
    'ACTION_MISSING',
    'TID_DUPLICATE',
    'INITIAL_MISSING',
    'ACTION_LIMIT',
  ]) {
    assert.ok(codes.includes(code), `应报告 ${code}；实际 ${JSON.stringify(codes)}`);
  }
  // 两侧问题都要收集
  assert.ok(r.errors.some((e) => e.side === 'A'));
  assert.ok(r.errors.some((e) => e.side === 'B'));
  // 清除旧结论：无轮次、无淘汰对、无初始对
  assert.equal(r.rounds.length, 0);
  assert.equal(r.eliminatedPairs.length, 0);
  assert.equal(r.firstEliminated, null);
  assert.equal(r.initialPairs.length, 0);
});

test('稳定排序：首个失败动作按动作字典序（tau 最后），轮次内状态对稳定排序', () => {
  const A = {
    states: [{ name: 's' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 'z', from: 's', action: 'z', to: 'p' },
      { id: 'b', from: 's', action: 'b', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 'c', from: 'q', action: 'c', to: 'r' }],
  };
  const r = audit(A, B);
  // 首个淘汰对按状态对字典序为 (p,q)：p 为死态，q 可做 c，首个失败动作为 c（B 挑战）
  assert.deepEqual(r.firstEliminated.pair, ['p', 'q']);
  assert.equal(r.firstEliminated.action, 'c');
  assert.equal(r.firstEliminated.challenger, 'B');
  // (s,q) 的首个失败义务才是动作 b（A 挑战，字典序早于 z）
  const sq = r.eliminatedPairs.find((p) => p.pair[0] === 's' && p.pair[1] === 'q');
  assert.equal(sq.action, 'b');
  assert.equal(sq.challenger, 'A');
  for (const rd of r.rounds) {
    const pairs = rd.eliminated.map((e) => e.pair.join(','));
    assert.deepEqual(pairs, [...pairs].sort());
  }
});

test('同构进程（仅状态重命名）等价', () => {
  const mk = (prefix) => ({
    states: [{ name: `${prefix}0` }, { name: `${prefix}1` }, { name: `${prefix}2` }],
    initial: `${prefix}0`,
    transitions: [
      { id: `${prefix}a`, from: `${prefix}0`, action: 'a', to: `${prefix}1` },
      { id: `${prefix}b`, from: `${prefix}1`, action: 'b', to: `${prefix}2` },
      { id: `${prefix}t`, from: `${prefix}2`, action: 'tau', to: `${prefix}0` },
    ],
  });
  const r = audit(mk('s'), mk('q'));
  assert.equal(r.equivalent, true);
  // 静默环使各状态经 tau 弱可达彼此：行为相同的非初始配对也可在关系中，
  // 关键是两个初始状态对均存活、初始对未被淘汰
  assert.ok(!r.eliminatedPairs.some((p) => p.pair[0] === 's0' && p.pair[1] === 'q0'));
});

test('状态数与可观察动作种类上限', () => {
  const tooMany = {
    states: Array.from({ length: 19 }, (_, i) => ({ name: `s${i}` })),
    initial: 's0',
    transitions: [],
  };
  const r1 = audit(tooMany, { states: [{ name: 'q' }], initial: 'q', transitions: [] });
  assert.ok(r1.errors.some((e) => e.code === 'STATE_LIMIT'));

  const fiveActions = {
    states: [{ name: 's' }],
    initial: 's',
    transitions: ['a', 'b', 'c', 'd', 'e'].map((a) => ({ id: a, from: 's', action: a, to: 's' })),
  };
  const r2 = audit(fiveActions, { states: [{ name: 'q' }], initial: 'q', transitions: [] });
  assert.ok(r2.errors.some((e) => e.code === 'ACTION_LIMIT'));
});

test('18 状态 4 动作的上限边界可正常计算', () => {
  const mk = (prefix) => ({
    states: Array.from({ length: 18 }, (_, i) => ({ name: `${prefix}${i}` })),
    initial: `${prefix}0`,
    transitions: [
      ...['a', 'b', 'c', 'd'].map((act, i) => ({ id: `${prefix}${act}`, from: `${prefix}0`, action: act, to: `${prefix}${i + 1}` })),
      { id: `${prefix}tau`, from: `${prefix}0`, action: 'tau', to: `${prefix}0` },
    ],
  });
  const r = audit(mk('s'), mk('q'));
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, true);
});

// ---------- 分支保持复核 ----------

test('分支保持：弱互模拟等价的静默分叉案例在分支保持下不等价', () => {
  const r = auditBranching(samples.branching.procA, samples.branching.procB);
  assert.equal(r.mode, 'branching');
  assert.equal(r.equivalent, false);

  // 静默状态 aa 与初态 b0 不相关（aa 丢失 b 承诺）：第 1 轮即淘汰
  const aaB0 = r.eliminatedPairs.find((p) => p.pair[0] === 'aa' && p.pair[1] === 'b0');
  assert.equal(aaB0.round, 1);
  assert.equal(aaB0.action, 'b');
  assert.equal(aaB0.challenger, 'B');

  // 初始对在第 2 轮因 B 的直接 a 挑战失败：A 只能穿过 aa，而 (b0,aa) 已于第 1 轮淘汰
  const init = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(init.round, 2);
  assert.equal(init.action, 'a');
  assert.equal(init.challenger, 'B');
  const fail = init.transitions.find((t) => t.source === 'bz');
  assert.equal(fail.reason, 'NO_VALID_PREFIX');
  const cand = fail.candidates[0];
  assert.deepEqual(cand.prefix, ['a0', 'aa']);
  assert.equal(cand.action, 'a');
  assert.equal(cand.target, 'az');
  assert.equal(cand.ok, false);
  const v = cand.violations[0];
  assert.equal(v.kind, 'PREFIX_PAIR');
  assert.equal(v.state, 'aa');
  assert.deepEqual(v.pair, ['b0', 'aa']);
  assert.equal(v.eliminatedRound, 1);

  // 同轮关系违约只引用更早轮次（此处第 2 轮引用第 1 轮）
  for (const ep of r.eliminatedPairs) {
    for (const t of ep.transitions) {
      if (!t.candidates) continue;
      for (const c of t.candidates) {
        for (const vio of c.violations) {
          assert.ok(typeof vio.eliminatedRound === 'number');
          assert.ok(vio.eliminatedRound < ep.round, `违约依据轮次应更早: ${JSON.stringify(vio)} in round ${ep.round}`);
        }
      }
    }
  }
});

test('分支保持：audit(mode=branching) 内嵌普通弱互模拟结论并列对照', () => {
  const r = audit(samples.branching.procA, samples.branching.procB, 'branching');
  assert.equal(r.mode, 'branching');
  assert.equal(r.equivalent, false);
  assert.ok(r.weak, '应内嵌普通弱互模拟结论');
  assert.equal(r.weak.equivalent, true, '同一案例普通弱互模拟必须判等价');
  assert.equal(r.weak.mode, undefined, '普通结论保持原有字段结构（无 mode）');
  assert.ok(r.weak.finalRelation.some((p) => p[0] === 'a0' && p[1] === 'b0'));
  assert.equal(r.initialPairs.length, 2);
});

test('分支保持：普通 audit() 默认 weak 且返回结构不含分支字段', () => {
  const r = audit(samples.branching.procA, samples.branching.procB);
  assert.equal(r.mode, undefined);
  assert.equal(r.equivalent, true);
  assert.equal(r.weak, undefined);
});

test('分支保持：tau 挑战允许静默至不相关状态后的落点（只要落点对存活）', () => {
  // A = tau.p；B = tau.r，p、r 均为终态：两侧同构，tau 挑战可由对方静默承接，
  // 也可零步承接（落点对存活即可）。分支保持应等价。
  const A = {
    states: [{ name: 's' }, { name: 'p' }],
    initial: 's',
    transitions: [{ id: 't', from: 's', action: 'tau', to: 'p' }],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 't', from: 'q', action: 'tau', to: 'r' }],
  };
  const r = auditBranching(A, B);
  assert.equal(r.equivalent, true);
});

test('分支保持：强 tau 挑战到无承诺状态时，零步静默落点违约', () => {
  // A：s 可静默到终态 p（提交后 a 承诺消失），也可直接 a 到终态；B：q 仅直接 a 到终态。
  // 可见动作 a 双向可承接；但 A 的强 tau 挑战 s→p 时，B 无静默可走，
  // 零步落点 (p,q) 因 q 仍有 a 承诺而在第 1 轮淘汰，初始对的首个失败义务即 tau。
  const A = {
    states: [{ name: 's' }, { name: 'p' }, { name: 'p2' }],
    initial: 's',
    transitions: [
      { id: 't', from: 's', action: 'tau', to: 'p' },
      { id: 'a', from: 's', action: 'a', to: 'p2' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 'a', from: 'q', action: 'a', to: 'r' }],
  };
  const r = auditBranching(A, B);
  assert.equal(r.equivalent, false);
  const sq = r.eliminatedPairs.find((p) => p.pair[0] === 's' && p.pair[1] === 'q');
  assert.equal(sq.action, TAU);
  assert.equal(sq.challenger, 'A');
  const fail = sq.transitions[0];
  assert.equal(fail.source, 'p');
  assert.equal(fail.reason, 'NO_VALID_PREFIX');
  const zero = fail.candidates.find((c) => c.prefix.length === 1);
  assert.deepEqual(zero.prefix, ['q']);
  assert.equal(zero.violations[0].kind, 'LANDING_PAIR');
  assert.deepEqual(zero.violations[0].pair, ['p', 'q']);
});

test('分支保持：候选静默前缀按落点状态、前缀长度、前缀序列稳定排序', () => {
  const r = auditBranching(samples.branching.procA, samples.branching.procB);
  for (const ep of r.eliminatedPairs) {
    for (const t of ep.transitions) {
      if (!t.candidates) continue;
      const key = (c) => `${c.target} ${c.prefix.length} ${c.prefix.join('/')}`;
      const keys = t.candidates.map(key);
      assert.deepEqual(keys, [...keys].sort(), `候选未稳定排序：${JSON.stringify(keys)}`);
    }
  }
});

test('分支保持：无效输入一次返回全部问题且不产出任何模式结论', () => {
  const bad = { states: [{ name: 'x' }, { name: 'x' }], initial: 'ghost', transitions: [] };
  const r = audit(bad, { states: [], initial: '', transitions: [] }, 'branching');
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'branching');
  assert.equal(r.equivalent, null);
  assert.ok(r.errors.length >= 3);
  assert.deepEqual(r.rounds, []);
  assert.deepEqual(r.eliminatedPairs, []);
  assert.equal(r.firstEliminated, null);
  assert.ok(r.weak, '并列的普通结论也应存在但为空结论');
  assert.equal(r.weak.ok, false);
  assert.equal(r.weak.equivalent, null);
  assert.deepEqual(r.weak.rounds, []);
});
