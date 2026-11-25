/**
 * 配置组：让 Coo 的 WebUI 自动渲染「模型分时调度」的设置面板。
 * 写法照抄 cortico-world-live-cue / cortico-world-bilibili（MIT, Pal AI Lab）：
 * 一个 *_DEFAULTS 对象 + 一个返回 ConfigGroup 的函数，properties 的 key 是完整配置路径。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * 默认规则（一天四班）：
 *   02:00 下播 → 千帆 + 群消息切回 hybrid（省 token）
 *   08:00 白天 → 北辰（顺手确认 hybrid）
 *   20:00 开播前 → 群消息切 passive（全实时，她能主动接话）
 *   22:00 开播   → 千帆（闲时 2 折）
 *
 * ⚠️ 窗口统一写 131072（模型原生上限），不要往下压。
 * 2026-11-14 实测：系统提示词 + 116 个工具 schema + 记忆注入 ≈ 7 万 token，
 * 压到 40000 会让 hardTokens（= 窗口 - maxTokens）= 38464，比实际占用还小，
 * 每轮都触发强制交接（= 失忆）。省 token 要靠缓存和精简工具，不是压窗口。
 *
 * receiveMode 三态容易记反：passive=逐条自动投递（最实时最费）；hybrid=只 @/私聊/戳实时，其余进未读箱；active=全进未读箱（最省）
 */
export const DEFAULT_RULES = [
  {
    at: '02:00',
    provider: 'qianfan',
    context: { qianfan: 131072 },
    set: { 'worlds.qqbot.receiveMode': 'hybrid' },
    restart: ['qqbot'],
  },
  {
    at: '08:00',
    provider: 'beichen',
    context: { qianfan: 131072 },
    set: { 'worlds.qqbot.receiveMode': 'hybrid' },
    restart: ['qqbot'],
  },
  {
    at: '20:00',
    set: { 'worlds.qqbot.receiveMode': 'passive' },
    restart: ['qqbot'],
  },
  {
    at: '22:00',
    provider: 'qianfan',
    context: { qianfan: 131072 },
  },
];

export const MODEL_SCHEDULE_DEFAULTS = {
  /** 由装配层显式开启 */
  enabled: false,
  /** 检查间隔（秒）：每隔这么久看一次时钟，命中规则就执行 */
  checkSec: 30,
  /** 启动时补漏：Coo 启动时若当天某条规则已过点但没执行过，补执行最近的那一条 */
  catchUpOnStart: true,
  /** 规则（JSON 文本，面板里可改）：[{ "at":"22:00", "provider":"qianfan" }] */
  rulesJson: JSON.stringify(DEFAULT_RULES, null, 2),
};

const T = {
  zh: {
    title: '模型分时调度',
    desc: '到点自动切换模型供应商、自动调上下文窗口（contextWindow：一次能记住多少对话，越小越省 token）。改完下一分钟生效，不用重启。',
    enabled: { t: '启用分时调度' },
    checkSec: { t: '检查间隔（秒）', d: '每隔这么久看一次时钟。30 秒够用，别小于 10。' },
    catchUp: { t: '启动时补漏', d: 'Coo 启动时如果已经过了某个时间点，补执行当天最近的一条规则。' },
    rules: { t: '调度规则（JSON）', d: '数组，每项 { "at": "HH:MM", "provider": "供应商名或空", "context": { "供应商名": 上下文窗口 } }。同一分钟命中多条会按顺序执行。' },
  },
  en: {
    title: 'Model schedule',
    desc: 'Switch provider and context window by clock time.',
    enabled: { t: 'Enable schedule' },
    checkSec: { t: 'Check interval (s)', d: 'How often to look at the clock. 30s is fine, do not go below 10.' },
    catchUp: { t: 'Catch up on start', d: 'When Coo starts, run the latest rule of the day that was missed.' },
    rules: { t: 'Rules (JSON)', d: 'Array of { "at": "HH:MM", "provider": "name or empty", "context": { "name": window } }.' },
  },
};

export function modelScheduleConfigGroup(language: 'zh' | 'en' = 'zh'): ConfigGroup {
  const t = T[language];
  return {
    id: 'world:model-schedule',
    owner: 'world:model-schedule',
    schema: {
      type: 'object',
      title: t.title,
      description: t.desc,
      properties: {
        'worlds.model-schedule.enabled': { type: 'boolean', title: t.enabled.t, 'x-hot': true },
        'worlds.model-schedule.checkSec': { type: 'integer', title: t.checkSec.t, description: t.checkSec.d, minimum: 10, maximum: 600 },
        'worlds.model-schedule.catchUpOnStart': { type: 'boolean', title: t.catchUp.t, description: t.catchUp.d },
        'worlds.model-schedule.rulesJson': { type: 'string', title: t.rules.t, description: t.rules.d, format: 'textarea' },
      },
    },
  };
}
