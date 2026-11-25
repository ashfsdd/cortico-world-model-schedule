/**
 * 模型分时调度（cortico-world-model-schedule）
 *
 * 干两件事，都走 Coo 自己的 HTTP 接口，改完即刻生效、不用重启：
 *   ① 到点切换模型供应商（POST /api/providers/<name>/activate）
 *   ② 到点修改上下文窗口 contextWindow（GET 拿 revision → POST /providers/<name>/save）
 *
 * 设计要点：
 *   - 幂等：目标状态已经是那样就不写盘，所以「启动补漏」可以每次启动都跑。
 *   - 兜底：Coo 启动时按「最近一次应该执行的时刻」对齐（含跨零点回退到昨天）。
 *   - 不崩：任何一步失败只记错，不抛到宿主；下一轮照常检查。
 */
import { modelScheduleConfigGroup, MODEL_SCHEDULE_DEFAULTS } from './config.ts';

const API = 'http://127.0.0.1:17788';

type Rule = {
  at?: string;
  provider?: string;
  context?: Record<string, number>;
  /** 顺便改的配置项：{ "worlds.qqbot.receiveMode": "hybrid" }，key 必须是完整配置路径 */
  set?: Record<string, unknown>;
  /** 改完要重启的 world（配置项多半要重启才读），如 ["qqbot"] */
  restart?: string[];
};

/** 规则的 context 里可能写的是别的供应商；面板只展示一个数字，取第一个即可 */
function qianfanKeyFor(r: Rule): string {
  const keys = Object.keys(r.context || {});
  return keys[0] ?? 'qianfan';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function hhmm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class ModelScheduleWorld {
  /** World 实例的 id 必须等于定义的 id，否则装配层判 missing */
  readonly id = 'model-schedule';

  private ctx: any;
  private cfg: any;
  private host: any = null;
  private running = false;
  private timer: any = null;
  private busy = false;
  /** 已经执行过的「日期#规则序号」，避免同一分钟重复执行 */
  private firedKeys = new Set<string>();
  /** 每天的键在这里清一次，防止无限增长 */
  private firedDay = '';
  private lastRunAt = '';
  private lastRule = '';
  private lastResult = '';
  private activeProvider = '';
  private history: Array<{ ts: string; rule: string; result: string }> = [];

  constructor(ctx: any) {
    this.ctx = ctx;
    const raw = (ctx?.cfg ?? {}) as Record<string, unknown>;
    this.cfg = { ...MODEL_SCHEDULE_DEFAULTS, ...raw };
    if (typeof this.cfg.rulesJson !== 'string' || !this.cfg.rulesJson.trim()) {
      this.cfg.rulesJson = MODEL_SCHEDULE_DEFAULTS.rulesJson;
    }
  }

  /**
   * 实时配置：Coo 的面板改设置时写的就是这个 ctx.cfg 对象（引用），
   * 所以每次用都重新读一遍，改完下一轮 tick 就生效，不用重启。
   * 读不到就回落到启动时的快照。
   */
  private liveCfg(): Record<string, any> {
    const raw = (this.ctx?.cfg ?? {}) as Record<string, any>;
    return { ...this.cfg, ...raw };
  }

  // ── World 契约 ──────────────────────────────────────────────

  /** 不注入任何环境提示词：这个插件零 token 成本 */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  /** 不给她任何工具：切模型是宿主的事，不该消耗她的上下文 */
  tools(): any[] {
    return [];
  }

  async start(host: any): Promise<void> {
    this.host = host;
    if (this.running) return;
    this.running = true;
    this.schedule();
    void this.refreshActive();
    if (this.cfg.catchUpOnStart !== false) {
      // 给宿主 3 秒把 providers 面板初始化完再对齐，避免一启动就撞 409
      setTimeout(() => { void this.catchUp(); }, 3000);
    }
    const r0 = this.parseRules();
    this.log(`已启动：每 ${this.cfg.checkSec}s 检查一次，规则 ${r0.length} 条（${r0.map((x) => x.at).join('/') || '空'}）`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── 面板 ────────────────────────────────────────────────────

  webUi(language: 'zh' | 'en' = 'zh'): any {
    const cfg = this.liveCfg();
    const rules = this.parseRules(cfg);
    const next = this.nextRule(cfg);
    return {
      label: '模型分时调度',
      lamps: [
        {
          label: '调度',
          state: this.running && cfg.enabled ? 'online' : 'offline',
          hint: cfg.enabled ? (this.running ? '运行中' : '未启动') : '已关闭（改设置里勾上「启用分时调度」）',
        },
        {
          label: '当前模型',
          state: this.activeProvider ? 'online' : 'offline',
          hint: this.activeProvider || '未读取',
        },
      ],
      badges: [
        { label: '规则', value: `${rules.length} 条`, tone: 'plain' },
        { label: '检查', value: `${cfg.checkSec}s`, tone: 'plain' },
        { label: '下次', value: next ? `${next.rule.at}${next.rule.provider ? ` → ${next.rule.provider}` : ''}` : '—', tone: 'plain' },
      ],
      config: [modelScheduleConfigGroup(language)],
      panels: [
        {
          id: 'rules',
          title: '规则与记录',
          description: '上面改规则，下面看执行记录。改完点保存，30 秒内生效，不用重启。',
          getMethods: ['overview', 'saveRules', 'runNow'],
        },
      ],
      invoke: (panel: string, method: string, args?: unknown[]) => this.invokePanel(panel, method, args),
    };
  }

  private async invokePanel(panel: string, method: string, args?: unknown[]): Promise<any> {
    if (panel !== 'rules') throw new Error(`unknown panel: ${panel}`);

    if (method === 'overview') {
      await this.refreshActive();
      const rules = this.parseRules().map((r) => ({
        at: r.at || '',
        provider: r.provider || '',
        window: Number((r.context && (r.context[qianfanKeyFor(r)] ?? Object.values(r.context)[0])) ?? 0) || 0,
        mode: String((r.set && (r.set as any)['worlds.qqbot.receiveMode']) ?? ''),
      }));
      let providers: string[] = [];
      try {
        const d = await this.get('/api/providers');
        const arr: any[] = Array.isArray(d) ? d : (d?.providers ?? []);
        providers = arr.map((x) => String(x.name ?? x.id ?? '')).filter(Boolean);
      } catch {
        providers = [];
      }
      const next = this.nextRule();
      return {
        rules,
        providers,
        active: this.activeProvider,
        next: next ? `${next.rule.at}${next.rule.provider ? ` → ${next.rule.provider}` : ''}（${next.inMin} 分钟后）` : '—',
        items: this.history.slice(-30).reverse(),
        lastRunAt: this.lastRunAt,
        lastResult: this.lastResult,
        enabled: Boolean(this.liveCfg().enabled),
      };
    }

    if (method === 'saveRules') {
      const input = Array.isArray(args?.[0]) ? (args![0] as any[]) : [];
      const rules: Rule[] = [];
      for (const r of input) {
        const at = String(r?.at ?? '').trim();
        if (!/^\d{2}:\d{2}$/.test(at)) continue;
        const rule: Rule = { at };
        const provider = String(r?.provider ?? '').trim();
        if (provider) rule.provider = provider;
        const win = Number(r?.window ?? 0);
        if (Number.isFinite(win) && win > 0) {
          rule.context = { [provider || 'qianfan']: win };
        }
        const mode = String(r?.mode ?? '').trim();
        if (mode) {
          rule.set = { 'worlds.qqbot.receiveMode': mode };
          rule.restart = ['qqbot'];
        }
        rules.push(rule);
      }
      rules.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const rulesJson = JSON.stringify(rules, null, 2);
      try {
        this.ctx?.persist?.({ rulesJson });
      } catch (e: any) {
        return { ok: false, message: `写配置失败：${String(e?.message || e).slice(0, 80)}` };
      }
      this.cfg.rulesJson = rulesJson;
      this.log(`规则已保存：${rules.map((r) => r.at).join('/')}`);
      return { ok: true, message: `已保存 ${rules.length} 条规则，30 秒内生效` };
    }

    if (method === 'runNow') {
      const rule = this.currentDueRule();
      if (!rule) return { ok: false, message: '没有可执行的规则' };
      await this.applyRule(rule, '手动对齐');
      return { ok: true, message: this.lastResult };
    }

    throw new Error(`unknown method: ${method}`);
  }

  // ── 调度核心 ────────────────────────────────────────────────

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    const sec = Math.max(10, Number(this.cfg.checkSec) || 30);
    this.timer = setInterval(() => { void this.tick(); }, sec * 1000);
    // 立刻跑一次，别等第一个间隔
    setTimeout(() => { void this.tick(); }, 800);
  }

  private parseRules(cfg?: Record<string, any>): Rule[] {
    const src = cfg ?? this.liveCfg();
    try {
      const arr = JSON.parse(String(src.rulesJson || '[]'));
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((r) => r && /^\d{2}:\d{2}$/.test(String(r.at ?? '')))
        .map((r) => ({
          at: String(r.at),
          provider: r.provider ? String(r.provider) : '',
          context: (r.context && typeof r.context === 'object') ? r.context : {},
          set: (r.set && typeof r.set === 'object') ? r.set : {},
          restart: Array.isArray(r.restart) ? r.restart.map((x: any) => String(x)) : [],
        }));
    } catch (e: any) {
      this.log(`规则 JSON 解析失败，已忽略：${String(e?.message || e).slice(0, 80)}`);
      return [];
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy) return;
    const cfg = this.liveCfg();
    if (!cfg.enabled) return;
    const rulesNow = this.parseRules(cfg);
    if (rulesNow.length === 0) return;
    this.busy = true;
    try {
      const now = new Date();
      const day = ymd(now);
      if (day !== this.firedDay) {
        this.firedDay = day;
        this.firedKeys.clear();
      }
      const cur = hhmm(now);
      const curMin = now.getHours() * 60 + now.getMinutes();
      const rules = this.parseRules(cfg);
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        const [rh, rm] = String(r.at).split(':').map(Number);
        const ruleMin = rh * 60 + rm;
        // ⚠️ 以前用的是 r.at === cur（严格相等），只有「那一分钟」能触发。
        // 实测：22:00 那分钟正好在内核重启，tick 没跑到 → 整晚不切模型，而且面板
        // 还显示「下次 22:00」，看不出已经错过。
        // 改成「到点后 90 分钟内都算数」：错过还能补，但不会半夜翻出白天的规则。
        if (!Number.isFinite(ruleMin) || curMin < ruleMin) continue;
        if (curMin - ruleMin > 90) continue;
        // 指纹要包含规则内容：只按「日期#序号」去重的话，改完规则但序号没变会被误判成「已执行过」
        const key = `${day}#${i}#${r.at}#${r.provider || ''}#${JSON.stringify(r.context || {})}#${JSON.stringify(r.set || {})}#${JSON.stringify(r.restart || [])}`;
        if (this.firedKeys.has(key)) continue;
        this.firedKeys.add(key);
        await this.applyRule(r, `定时 ${r.at}`);
      }
      // 顺手把「当前模型」读一下，面板才有东西显示（一分钟一次，很轻）
      if (now.getMinutes() % 5 === 0 && now.getSeconds() < 40) await this.refreshActive();
    } catch (e: any) {
      this.log(`tick 异常：${String(e?.message || e).slice(0, 120)}`);
    } finally {
      this.busy = false;
    }
  }

  /** 今天（或昨天）最近一次应该执行的规则 */
  private currentDueRule(cfg?: Record<string, any>): Rule | null {
    const rules = this.parseRules(cfg);
    const now = new Date();
    let best: { rule: Rule; t: number } | null = null;
    for (const r of rules) {
      const [h, m] = String(r.at).split(':').map(Number);
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
      if (!best || d.getTime() > best.t) best = { rule: r, t: d.getTime() };
    }
    return best ? best.rule : null;
  }

  private nextRule(cfg?: Record<string, any>): { rule: Rule; inMin: number } | null {
    const rules = this.parseRules(cfg);
    if (!rules.length) return null;
    const now = new Date();
    let best: { rule: Rule; t: number } | null = null;
    for (const r of rules) {
      const [h, m] = String(r.at).split(':').map(Number);
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      if (!best || d.getTime() < best.t) best = { rule: r, t: d.getTime() };
    }
    if (!best) return null;
    return { rule: best.rule, inMin: Math.round((best.t - now.getTime()) / 60000) };
  }

  private async catchUp(): Promise<void> {
    if (!this.liveCfg().enabled) {
      this.log('未启用，跳过启动补漏');
      return;
    }
    const rule = this.currentDueRule();
    if (!rule) return;
    await this.applyRule(rule, '启动补漏');
  }

  /** 应用一条规则：先切供应商，再改上下文窗口。全程幂等。 */
  private async applyRule(rule: Rule, reason: string): Promise<void> {
    const parts: string[] = [];
    try {
      if (rule.provider) {
        const want = String(rule.provider).trim();
        const cur = (await this.refreshActive()) || '';
        if (cur === want) {
          parts.push(`${want} 已在用`);
        } else {
          const st = await this.post(`/api/providers/${encodeURIComponent(want)}/activate`, {});
          if (st.ok) {
            parts.push(`切到 ${want}`);
            this.activeProvider = want;
          } else {
            parts.push(`切 ${want} 失败(${st.status})`);
          }
        }
      }
      for (const [name, win] of Object.entries(rule.context || {})) {
        const n = Number(win);
        if (!Number.isFinite(n) || n <= 0) continue;
        const r = await this.setContextWindow(String(name), n);
        parts.push(`${name}.contextWindow=${n}${r === 'same' ? '(已是)' : ''}`);
      }
      let cfgChanged = 0;
      const hasSet = Boolean(rule.set && Object.keys(rule.set).length);
      if (hasSet) {
        const r = await this.applyConfigSettings(rule.set as Record<string, unknown>);
        cfgChanged = r.changed;
        parts.push(`配置 ${r.out.join(' ')}`);
      }
      // 有 set 时只在真的改了才重启；没有 set 时照规则重启
      if (rule.restart && rule.restart.length && (!hasSet || cfgChanged > 0)) {
        const r = await this.restartWorlds(rule.restart);
        parts.push(`重启 ${r.join(' ')}`);
      } else if (rule.restart && rule.restart.length) {
        parts.push('无需重启(值没变)');
      }
      this.lastResult = parts.join(' · ') || '无事可做';
      this.lastRule = `${reason}${rule.at ? ` @${rule.at}` : ''}`;
      this.lastRunAt = new Date().toISOString();
      this.history.push({ ts: this.lastRunAt, rule: this.lastRule, result: this.lastResult });
      if (this.history.length > 200) this.history = this.history.slice(-120);
      this.log(`${this.lastRule} → ${this.lastResult}`);
    } catch (e: any) {
      this.lastResult = `失败：${String(e?.message || e).slice(0, 100)}`;
      this.lastRule = `${reason}${rule.at ? ` @${rule.at}` : ''}`;
      this.lastRunAt = new Date().toISOString();
      this.history.push({ ts: this.lastRunAt, rule: this.lastRule, result: this.lastResult });
      this.log(`${this.lastRule} → ${this.lastResult}`);
    }
  }

  /**
   * 按配置路径批量写配置：先 GET /api/config 把所有面板找出来，
   * 看哪个面板的 schema.properties 里有这个 key，就投给那个面板。
   * 这样不用猜「worlds.qqbot.xxx 属于哪个 group」，也不会写进没有 schema 的野字段。
   */
  private async applyConfigSettings(set: Record<string, unknown>): Promise<{ out: string[]; changed: number }> {
    const keys = Object.keys(set);
    if (!keys.length) return { out: [], changed: 0 };
    const cfg = await this.get('/api/config');
    const groups: any[] = Array.isArray(cfg?.groups) ? cfg.groups : [];
    const byGroup = new Map<string, Record<string, unknown>>();
    const missing: string[] = [];
    for (const k of keys) {
      let gid = '';
      for (const g of groups) {
        const props = (g?.group?.schema?.properties ?? {}) as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          gid = String(g.group.id ?? '');
          break;
        }
      }
      if (!gid) {
        missing.push(k);
        continue;
      }
      const bucket = byGroup.get(gid) ?? {};
      bucket[k] = set[k];
      byGroup.set(gid, bucket);
    }
    // 幂等：当前值已经等于目标就跳过，免得每天白写盘、白重启一次 world
    const out: string[] = [];
    let changed = 0;
    for (const [gid, values] of byGroup) {
      const hit = groups.find((g) => String(g?.group?.id ?? '') === gid);
      const cur = (hit?.values ?? {}) as Record<string, unknown>;
      const todo: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (JSON.stringify(cur[k]) !== JSON.stringify(v)) todo[k] = v;
      }
      if (!Object.keys(todo).length) {
        out.push(`${gid}=已是`);
        continue;
      }
      const st = await this.post('/api/config', { group: gid, values: todo });
      if (st.ok) changed += 1;
      out.push(`${gid}=${st.ok ? 'ok' : st.status}`);
    }
    if (missing.length) out.push(`无面板入口:${missing.join(',')}`);
    return { out, changed };
  }

  /** 重启指定 world（只重启它，不动整个 Coo，上下文不丢）；重启后等 4 秒让灯亮起来 */
  private async restartWorlds(ids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of ids) {
      const st = await this.post('/api/worlds/restart', { id });
      out.push(`${id}=${st.ok ? 'ok' : st.status}`);
    }
    if (ids.length) await new Promise((r) => setTimeout(r, 4000));
    return out;
  }

  private async setContextWindow(name: string, win: number): Promise<'same' | 'changed'> {
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const d = await this.get(`/api/providers/${encodeURIComponent(name)}`);
      const entry = d?.entry;
      if (!entry) throw new Error(`找不到供应商 ${name}`);
      const cur = Number(entry?.spec?.contextWindow ?? 0);
      if (cur === win) return 'same';
      if (!entry.spec || typeof entry.spec !== 'object') entry.spec = {};
      entry.spec.contextWindow = win;
      const st = await this.post(`/api/providers/${encodeURIComponent(name)}/save`, {
        name,
        entry,
        expectedRevision: d.revision,
      });
      if (st.ok) return 'changed';
      lastErr = `${st.status} ${st.text.slice(0, 80)}`;
      // 409 = 别人刚改过，重新读 revision 再试一次
      if (st.status === 409) continue;
      break;
    }
    throw new Error(`save ${name} 失败：${lastErr}`);
  }

  private async refreshActive(): Promise<string> {
    try {
      const d = await this.get('/api/providers');
      const arr: any[] = Array.isArray(d) ? d : (d?.providers ?? []);
      const hit = arr.find((x) => x && x.active === true);
      const name = hit ? String(hit.name ?? hit.id ?? '') : '';
      if (name) this.activeProvider = name;
      return name;
    } catch {
      return this.activeProvider;
    }
  }

  // ── HTTP ────────────────────────────────────────────────────

  private async get(path: string): Promise<any> {
    const res = await fetch(API + path, { method: 'GET' } as any);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return await res.json();
  }

  private async post(path: string, body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    } as any);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }

  private log(msg: string): void {
    try {
      this.host?.log?.info?.(`[model-schedule] ${msg}`);
      if (!this.host?.log?.info) console.log(`[model-schedule] ${msg}`);
    } catch {
      /* ignore */
    }
  }
}

export const MODEL_SCHEDULE = {
  id: 'model-schedule',
  label: '模型分时调度',
  defaults: () => ({ ...MODEL_SCHEDULE_DEFAULTS }),
  describe: {
    tools: [],
    events: [],
  },
  create: (ctx: any) => new ModelScheduleWorld(ctx),
};

export default MODEL_SCHEDULE;
