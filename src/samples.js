'use strict';

// 页面内置示例：
//  1. equivalent —— 仅差一个可观察上不可见的 tau 自环（状态重命名），应判定等价
//  2. missing    —— 一侧可观察动作另一侧无法承接，应判定不等价
//  3. cascade    —— 多轮淘汰：初始对在第 2 轮因引用第 1 轮淘汰结果而失败
//  4. branching  —— 静默分叉：弱互模拟等价，但分支保持不等价
//                    A = tau.a + b ；B = tau.a + a + b
//                    B 的直接 a 挑战只能由 A 穿过静默状态 aa 承接，
//                    而 aa 已丢失 b 承诺，与 B 初态不在同一轮关系中。

const samples = {
  equivalent: {
    label: 'tau 自环 + 重命名（应等价）',
    procA: {
      states: [{ name: 'S0' }, { name: 'S1' }],
      initial: 'S0',
      transitions: [
        { id: 'a-tau-loop', from: 'S0', action: 'tau', to: 'S0' },
        { id: 'a-x', from: 'S0', action: 'x', to: 'S1' },
      ],
    },
    procB: {
      states: [{ name: 'P0' }, { name: 'P1' }],
      initial: 'P0',
      transitions: [{ id: 'b-x', from: 'P0', action: 'x', to: 'P1' }],
    },
  },
  missing: {
    label: '缺失匹配动作（应不等价）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }],
      initial: 'a0',
      transitions: [{ id: 'ax', from: 'a0', action: 'x', to: 'a1' }],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }],
      initial: 'b0',
      transitions: [{ id: 'by', from: 'b0', action: 'y', to: 'b1' }],
    },
  },
  cascade: {
    label: '多轮级联淘汰（初始对第 2 轮失败）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }, { name: 'a2' }],
      initial: 'a0',
      transitions: [
        { id: 'ax', from: 'a0', action: 'x', to: 'a1' },
        { id: 'ay', from: 'a1', action: 'y', to: 'a2' },
      ],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }],
      initial: 'b0',
      transitions: [{ id: 'bx', from: 'b0', action: 'x', to: 'b1' }],
    },
  },
  branching: {
    label: '静默分叉（弱互模拟等价 / 分支保持不等价）',
    procA: {
      // A：静默进入 aa 后只能 a；初态仍可直接 b
      states: [{ name: 'a0' }, { name: 'aa' }, { name: 'az' }],
      initial: 'a0',
      transitions: [
        { id: 'a-tau', from: 'a0', action: 'tau', to: 'aa' },
        { id: 'a-a', from: 'aa', action: 'a', to: 'az' },
        { id: 'a-b', from: 'a0', action: 'b', to: 'az' },
      ],
    },
    procB: {
      // B：静默后可 a，且初态还可直接 a（该直接 a 承诺即 A 静默后悄然丢失的分支）
      states: [{ name: 'b0' }, { name: 'ba' }, { name: 'bz' }],
      initial: 'b0',
      transitions: [
        { id: 'b-tau', from: 'b0', action: 'tau', to: 'ba' },
        { id: 'b-a1', from: 'ba', action: 'a', to: 'bz' },
        { id: 'b-a2', from: 'b0', action: 'a', to: 'bz' },
        { id: 'b-b', from: 'b0', action: 'b', to: 'bz' },
      ],
    },
  },
};

module.exports = { samples };
