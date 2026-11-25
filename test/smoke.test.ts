/**
 * model-schedule 的冒烟测试（2026-11-23 加）。
 *
 * 只覆盖「实际在用的路径」：默认规则的结构、时间格式、切换目标是否合法。
 * 不测定时器本身（它依赖宿主时钟，测起来价值不大）。
 *
 * 跑法：node --import tsx test/smoke.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, MODEL_SCHEDULE_DEFAULTS } from '../src/config.ts';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

test('默认规则：至少 4 条，时间格式都合法', () => {
  assert.ok(DEFAULT_RULES.length >= 4, `规则数 ${DEFAULT_RULES.length}`);
  for (const r of DEFAULT_RULES) {
    assert.match(r.at, TIME_RE, `非法时间 ${r.at}`);
  }
});

test('默认规则：按时间递增（跨零点不要求）', () => {
  const mins = DEFAULT_RULES.map((r) => {
    const [h, m] = r.at.split(':').map(Number);
    return h * 60 + m;
  });
  for (let i = 1; i < mins.length; i++) {
    assert.ok(mins[i] > mins[i - 1], `第 ${i} 条时间没有递增：${DEFAULT_RULES[i - 1].at} → ${DEFAULT_RULES[i].at}`);
  }
});

test('默认规则：每条至少有一个动作（provider 或 set 或 restart）', () => {
  for (const r of DEFAULT_RULES) {
    const hasAction = Boolean(r.provider || (r.set && Object.keys(r.set).length) || (r.restart && r.restart.length));
    assert.ok(hasAction, `${r.at} 这条没有任何动作`);
  }
});

test('默认配置：modelSchedule 组的关键项存在且类型正确', () => {
  const d = MODEL_SCHEDULE_DEFAULTS as Record<string, unknown>;
  assert.equal(typeof d.enabled, 'boolean');
  assert.equal(typeof d.checkSec, 'number');
  assert.ok(Number(d.checkSec) >= 10, 'checkSec 太小会频繁唤醒');
  assert.equal(typeof d.rulesJson, 'string');
});

test('默认配置：rulesJson 能被 JSON.parse，且内容与 DEFAULT_RULES 一致', () => {
  const d = MODEL_SCHEDULE_DEFAULTS as Record<string, unknown>;
  const parsed = JSON.parse(String(d.rulesJson));
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, DEFAULT_RULES.length);
  for (let i = 0; i < parsed.length; i++) {
    assert.equal(parsed[i].at, DEFAULT_RULES[i].at);
  }
});

// ── 规则校验（2026-11-26 加）──────────────────────────────────

import { ModelScheduleWorld } from '../src/index.ts';

const mkWorld = () => new ModelScheduleWorld({ cfg: {} });
const validate = (raw: string) => (mkWorld() as any).validateRules(raw);

test('校验：JSON 语法错能指出', () => {
  const r = validate('{ bad json');
  assert.equal(r.rules.length, 0);
  assert.match(r.issues[0], /JSON 语法错误/);
});

test('校验：顶层非数组', () => {
  const r = validate('{"at":"22:00"}');
  assert.match(r.issues[0], /必须是数组/);
});

test('校验：缺 at 指出第几条', () => {
  const r = validate('[{"provider":"qianfan"}]');
  assert.match(r.issues[0], /第 1 条缺 at/);
});

test('校验：at 格式错', () => {
  const r = validate('[{"at":"22点"}]');
  assert.match(r.issues[0], /格式不对/);
});

test('校验：at 超范围', () => {
  const r = validate('[{"at":"25:00"}]');
  assert.match(r.issues[0], /超出范围/);
});

test('校验：正常规则无 issue', () => {
  const r = validate('[{"at":"22:00","provider":"qianfan"}]');
  assert.equal(r.issues.length, 0);
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0].at, '22:00');
});

test('校验：set 类型不对会提示，但规则仍保留', () => {
  const r = validate('[{"at":"02:00","set":[]}]');
  assert.match(r.issues[0], /set 应该是对象/);
  assert.equal(r.rules.length, 1);
});
