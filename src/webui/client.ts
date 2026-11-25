/**
 * 模型分时调度 · 面板
 *
 * 一个页签「规则与记录」，上下两块：
 *   上：规则表（时间 / 模型 / 窗口 / 群消息），点着改，保存后 30 秒生效
 *   下：执行记录（最近 30 次）
 *
 * 为什么不用自动渲染的配置表单：那张表里的规则是一坨 JSON，改一次要手写数组。
 * 这里把 JSON 拆成一行一条，跟 Coo 自带的「模型供应商」页一个操作习惯。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

type RuleRow = { at: string; provider: string; window: number; mode: string };

type Overview = {
  rules: RuleRow[];
  providers: string[];
  active: string;
  next: string;
  items: Array<{ ts: string; rule: string; result: string }>;
  lastRunAt: string;
  lastResult: string;
  enabled: boolean;
};

const MODES: Array<{ v: string; label: string }> = [
  { v: '', label: '不改' },
  { v: 'hybrid', label: 'hybrid（只 @/私聊 才醒）' },
  { v: 'passive', label: 'passive（每条都醒，最费）' },
  { v: 'active', label: 'active（全进未读箱）' },
];

const INPUT_CSS =
  'background:rgba(128,128,128,.13);color:inherit;border:1px solid rgba(128,128,128,.3);' +
  'border-radius:7px;padding:5px 8px;font-size:13px;font-family:inherit;outline:none;';

/**
 * 原生下拉框 / 时间选择器的「弹出层」由 Chromium 自绘，CSS 管不到，只认 color-scheme。
 * 不设的时候它一律按浅色画 → 深色主题下弹出一块白底。
 *
 * ⚠️ 判据不能读元素自己的颜色：面板刚 mount 时节点可能还没挂进 document，
 * getComputedStyle 会返回默认黑字 → 误判成浅色主题。这里按「先看主题标记、
 * 再看页面背景、最后看正文颜色」的顺序判，并且必须读 document 上的节点。
 */
function schemeOf(): 'light' | 'dark' {
  const root = document.documentElement;
  const marks = [
    root.dataset.theme,
    root.dataset.colorMode,
    root.className,
    document.body?.className,
    document.body?.dataset?.theme,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (marks.includes('dark')) return 'dark';
  if (marks.includes('light')) return 'light';

  // 背景亮度：亮的背景 = 浅色主题
  const bg = getComputedStyle(document.body).backgroundColor || '';
  const mb = bg.match(/[\d.]+/g);
  if (mb && mb.length >= 3) {
    const [r, g, b] = mb.map(Number);
    const alpha = mb.length >= 4 ? Number(mb[3]) : 1;
    if (alpha > 0.1) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > 8) return lum > 140 ? 'light' : 'dark';
    }
  }

  // 正文颜色：浅色字 = 深色主题（这是最可靠的一条，但必须读 body 而不是控件本身）
  const fg = getComputedStyle(document.body).color || '';
  const mf = fg.match(/\d+/g);
  if (mf && mf.length >= 3) {
    const lum = 0.2126 * Number(mf[0]) + 0.7152 * Number(mf[1]) + 0.0722 * Number(mf[2]);
    if (lum > 140) return 'dark';
    if (lum < 60) return 'light';
  }
  return 'dark';
}

function fixScheme(root: ParentNode): void {
  const scheme = schemeOf();
  for (const n of root.querySelectorAll<HTMLElement>('input,select,button')) {
    n.style.colorScheme = scheme;
  }
  // 只设 select 的 color-scheme 在部分 Chromium 版本上无效（弹出层仍按浅色画）。
  // option 的 background/color 是最后一道保险：写死深色，白屏就没了。
  if (scheme === 'dark') {
    for (const op of root.querySelectorAll<HTMLElement>('option')) {
      op.style.backgroundColor = '#1b1d21';
      op.style.color = '#eceae6';
    }
  }
}

let schemeObserver: MutationObserver | null = null;
let schemeTimer: number | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
}

function shortTime(ts: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 16);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 自绘下拉。
 *
 * 为什么不用原生 <select>：它在 Windows 上的弹出列表是**系统级窗口**，不是 DOM 节点，
 * CSS 完全管不到，`color-scheme` 也只能碰运气。深色主题下必然弹出一块白底 ——
 * 试过 color-scheme、试过给 option 写 background，都不稳。
 * 这里用 div 重画，配色 100% 由我们控制，不再受宿主/系统主题影响。
 */
function makeSelect(
  value: string,
  options: Array<{ v: string; label: string }>,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = el('div', 'position:relative;min-width:0;');
  const btn = el('button', INPUT_CSS + 'width:100%;text-align:left;cursor:pointer;display:flex;align-items:center;gap:6px;');
  const label = el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
  const arrow = el('span', 'opacity:.45;font-size:9px;flex:none;', '▼');
  btn.append(label, arrow);

  const list = el(
    'div',
    'position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:200;display:none;' +
      'background:#1b1d21;border:1px solid rgba(150,150,150,.35);border-radius:8px;' +
      'box-shadow:0 10px 28px rgba(0,0,0,.55);max-height:240px;overflow:auto;padding:4px 0;',
  );

  const setLabel = (v: string): void => {
    const hit = options.find((o) => o.v === v);
    label.textContent = hit ? hit.label : '—';
  };
  setLabel(value);

  for (const o of options) {
    const item = el('div', 'padding:6px 10px;font-size:13px;cursor:pointer;color:#eceae6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    item.textContent = o.label;
    item.addEventListener('mouseenter', () => {
      item.style.background = 'rgba(122,162,247,.18)';
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
    });
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      list.style.display = 'none';
      setLabel(o.v);
      onChange(o.v);
    });
    list.append(item);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = list.style.display === 'block';
    for (const p of document.querySelectorAll<HTMLElement>('.ms-pop')) p.style.display = 'none';
    list.style.display = open ? 'none' : 'block';
  });
  list.classList.add('ms-pop');

  wrap.append(btn, list);
  return wrap;
}

function mountRules(ctx: WebUiPanelContext): void {
  const ui = ctx.ui;
  const sheet = ui.sheet({
    title: '规则与记录',
    desc: '上面是时刻表：到点自动切模型、调上下文窗口、改群消息接收模式。改完点保存，30 秒内生效。',
  });
  ctx.root.append(sheet.el);

  // 点空白处收起所有自绘下拉（只绑一次，避免重开面板越绑越多）
  const g = window as unknown as { __msPopBound?: boolean };
  if (!g.__msPopBound) {
    g.__msPopBound = true;
    document.addEventListener('click', () => {
      for (const p of document.querySelectorAll<HTMLElement>('.ms-pop')) p.style.display = 'none';
    });
  }

  const status = el('div', 'display:flex;gap:16px;flex-wrap:wrap;font-size:13px;opacity:.88;margin:2px 0 8px;');
  const msg = ui.msgline();
  sheet.body.append(status, msg);

  const listBox = el('div', 'margin:12px 0 8px;display:flex;flex-direction:column;gap:8px;');
  sheet.body.append(listBox);

  let rows: RuleRow[] = [];
  let providers: string[] = [];

  const run = async (method: string, args?: unknown[]): Promise<any> => {
    try {
      return await (ctx as any).invoke(method, args);
    } catch (e: any) {
      msg.error(`调用失败：${String(e?.message || e).slice(0, 120)}`);
      throw e;
    }
  };

  const renderRows = (): void => {
    listBox.innerHTML = '';
    if (!rows.length) {
      listBox.append(el('div', 'font-size:13px;opacity:.6;padding:8px 2px;', '还没有规则。点下面「+ 添加一行」。'));
      return;
    }
    const head = el('div',
      'display:grid;grid-template-columns:96px 1fr 96px 1fr 44px;gap:8px;font-size:12px;opacity:.62;padding:0 2px;');
    head.append(
      el('span', '', '时间'),
      el('span', '', '模型'),
      el('span', '', '窗口'),
      el('span', '', '群消息'),
      el('span', '', ''),
    );
    listBox.append(head);

    rows.forEach((r, i) => {
      const line = el('div', 'display:grid;grid-template-columns:96px 1fr 96px 1fr 44px;gap:8px;align-items:center;');

      const time = el('input', INPUT_CSS) as HTMLInputElement;
      time.type = 'time';
      time.value = r.at;
      time.onchange = () => {
        rows[i].at = time.value;
      };

      const prov = makeSelect(
        r.provider || '',
        [{ v: '', label: '不切换' }, ...providers.map((p) => ({ v: p, label: p }))],
        (v) => {
          rows[i].provider = v;
        },
      );

      const win = el('input', INPUT_CSS) as HTMLInputElement;
      win.type = 'number';
      win.min = '0';
      win.step = '1000';
      win.placeholder = '不改';
      win.value = r.window ? String(r.window) : '';
      win.onchange = () => {
        rows[i].window = Number(win.value) || 0;
      };

      const mode = makeSelect(
        r.mode || '',
        MODES.map((m) => ({ v: m.v, label: m.label })),
        (v) => {
          rows[i].mode = v;
        },
      );

      const del = el('button', INPUT_CSS + 'cursor:pointer;padding:5px 6px;', '删') as HTMLButtonElement;
      del.onclick = () => {
        rows.splice(i, 1);
        renderRows();
      };

      line.append(time, prov, win, mode, del);
      listBox.append(line);
    });
    fixScheme(listBox);
  };

  const table = ui.table({ head: ['时间', '触发', '结果'], maxHeight: 280 });

  const renderTable = (items: Overview['items']): void => {
    table.clear(items.length ? `共 ${items.length} 条` : '还没有执行记录');
    for (const it of items) {
      table.addRow([shortTime(it.ts), it.rule || '—', it.result || '—']);
    }
  };

  const bar = ui.rowbar();
  bar.append(
    ui.button('+ 添加一行', {
      size: 'sm',
      onClick: () => {
        rows.push({ at: '12:00', provider: '', window: 0, mode: '' });
        renderRows();
      },
    }),
    ui.button('保存', { size: 'sm', onClick: () => void save() }),
    ui.button('刷新', { size: 'sm', onClick: () => void load() }),
    ui.button('立即对齐', { size: 'sm', onClick: () => void runNow() }),
  );
  sheet.body.append(bar);

  sheet.body.append(
    el('div', 'margin-top:16px;font-weight:600;font-size:14px;margin-bottom:6px;', '执行记录'),
  );
  sheet.body.append(table.el);

  async function load(): Promise<void> {
    try {
      const d = (await run('overview')) as Overview;
      rows = (d?.rules ?? []).map((r) => ({
        at: r.at,
        provider: r.provider || '',
        window: Number(r.window) || 0,
        mode: r.mode || '',
      }));
      providers = d?.providers ?? [];
      status.innerHTML = '';
      const chip = (label: string, value: string) => {
        const s = el('span', '');
        s.append(el('span', 'opacity:.62;', `${label} `), el('b', '', value || '—'));
        return s;
      };
      status.append(
        chip('当前模型', d?.active ?? ''),
        chip('下次', d?.next ?? ''),
        chip('调度', d?.enabled ? '开' : '关'),
        chip('最近一次', d?.lastRunAt ? shortTime(d.lastRunAt) : ''),
      );
      renderRows();
      renderTable(d?.items ?? []);
      if (d?.lastResult) msg.info(`上次结果：${d.lastResult}`);
    } catch {
      /* run() 已经报过错 */
    }
  }

  async function save(): Promise<void> {
    if (!rows.length) {
      msg.error('至少留一条规则，否则等于把这个插件关了');
      return;
    }
    for (const r of rows) {
      if (!/^\d{2}:\d{2}$/.test(r.at)) {
        msg.error(`时间格式不对：${r.at}（要 HH:MM）`);
        return;
      }
    }
    const d = (await run('saveRules', [rows])) as { ok: boolean; message: string };
    if (d?.ok) msg.info(d.message);
    else msg.error(d?.message || '保存失败');
    await load();
  }

  async function runNow(): Promise<void> {
    const d = (await run('runNow')) as { ok: boolean; message: string };
    if (d?.ok) msg.info(d.message);
    else msg.error(d?.message || '执行失败');
    await load();
  }

  void load();

  // 主题校正：面板可能是「先创建、后挂载」，第一帧拿到的 body 还不一定带主题。
  // 所以补两次延迟校正，再挂一个 5 秒的兜底定时（面板关掉也只是空转，开销可忽略）。
  fixScheme(sheet.body);
  setTimeout(() => fixScheme(sheet.body), 50);
  setTimeout(() => fixScheme(sheet.body), 400);
  if (schemeTimer !== null) clearInterval(schemeTimer);
  schemeTimer = window.setInterval(() => fixScheme(sheet.body), 5000);

  if (!schemeObserver && typeof MutationObserver !== 'undefined') {
    schemeObserver = new MutationObserver(() => fixScheme(sheet.body));
    schemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
  }
}

const bundle: WebUiClientBundle = {
  panels: {
    rules: { mount: mountRules },
  },
};

export default bundle;
