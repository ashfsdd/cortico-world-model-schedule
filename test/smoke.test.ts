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
