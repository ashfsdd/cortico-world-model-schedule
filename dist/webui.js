// src/webui/client.ts
var MODES = [
  { v: "", label: "\u4E0D\u6539" },
  { v: "hybrid", label: "hybrid\uFF08\u53EA @/\u79C1\u804A \u624D\u9192\uFF09" },
  { v: "passive", label: "passive\uFF08\u6BCF\u6761\u90FD\u9192\uFF0C\u6700\u8D39\uFF09" },
  { v: "active", label: "active\uFF08\u5168\u8FDB\u672A\u8BFB\u7BB1\uFF09" }
];
var INPUT_CSS = "background:rgba(128,128,128,.13);color:inherit;border:1px solid rgba(128,128,128,.3);border-radius:7px;padding:5px 8px;font-size:13px;font-family:inherit;outline:none;";
function schemeOf() {
  const root = document.documentElement;
  const marks = [
    root.dataset.theme,
    root.dataset.colorMode,
    root.className,
    document.body?.className,
    document.body?.dataset?.theme
  ].filter(Boolean).join(" ").toLowerCase();
  if (marks.includes("dark")) return "dark";
  if (marks.includes("light")) return "light";
  const bg = getComputedStyle(document.body).backgroundColor || "";
  const mb = bg.match(/[\d.]+/g);
  if (mb && mb.length >= 3) {
    const [r, g, b] = mb.map(Number);
    const alpha = mb.length >= 4 ? Number(mb[3]) : 1;
    if (alpha > 0.1) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > 8) return lum > 140 ? "light" : "dark";
    }
  }
  const fg = getComputedStyle(document.body).color || "";
  const mf = fg.match(/\d+/g);
  if (mf && mf.length >= 3) {
    const lum = 0.2126 * Number(mf[0]) + 0.7152 * Number(mf[1]) + 0.0722 * Number(mf[2]);
    if (lum > 140) return "dark";
    if (lum < 60) return "light";
  }
  return "dark";
}
function fixScheme(root) {
  const scheme = schemeOf();
  for (const n of root.querySelectorAll("input,select,button")) {
    n.style.colorScheme = scheme;
  }
  if (scheme === "dark") {
    for (const op of root.querySelectorAll("option")) {
      op.style.backgroundColor = "#1b1d21";
      op.style.color = "#eceae6";
    }
  }
}
var schemeObserver = null;
var schemeTimer = null;
function el(tag, css = "", text) {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== void 0) n.textContent = text;
  return n;
}
function shortTime(ts) {
  if (!ts) return "\u2014";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 16);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function makeSelect(value, options, onChange) {
  const wrap = el("div", "position:relative;min-width:0;");
  const btn = el("button", INPUT_CSS + "width:100%;text-align:left;cursor:pointer;display:flex;align-items:center;gap:6px;");
  const label = el("span", "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
  const arrow = el("span", "opacity:.45;font-size:9px;flex:none;", "\u25BC");
  btn.append(label, arrow);
  const list = el(
    "div",
    "position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:200;display:none;background:#1b1d21;border:1px solid rgba(150,150,150,.35);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.55);max-height:240px;overflow:auto;padding:4px 0;"
  );
  const setLabel = (v) => {
    const hit = options.find((o) => o.v === v);
    label.textContent = hit ? hit.label : "\u2014";
  };
  setLabel(value);
  for (const o of options) {
    const item = el("div", "padding:6px 10px;font-size:13px;cursor:pointer;color:#eceae6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;");
    item.textContent = o.label;
    item.addEventListener("mouseenter", () => {
      item.style.background = "rgba(122,162,247,.18)";
    });
    item.addEventListener("mouseleave", () => {
      item.style.background = "transparent";
    });
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      list.style.display = "none";
      setLabel(o.v);
      onChange(o.v);
    });
    list.append(item);
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = list.style.display === "block";
    for (const p of document.querySelectorAll(".ms-pop")) p.style.display = "none";
    list.style.display = open ? "none" : "block";
  });
  list.classList.add("ms-pop");
  wrap.append(btn, list);
  return wrap;
}
function mountRules(ctx) {
  const ui = ctx.ui;
  const sheet = ui.sheet({
    title: "\u89C4\u5219\u4E0E\u8BB0\u5F55",
    desc: "\u4E0A\u9762\u662F\u65F6\u523B\u8868\uFF1A\u5230\u70B9\u81EA\u52A8\u5207\u6A21\u578B\u3001\u8C03\u4E0A\u4E0B\u6587\u7A97\u53E3\u3001\u6539\u7FA4\u6D88\u606F\u63A5\u6536\u6A21\u5F0F\u3002\u6539\u5B8C\u70B9\u4FDD\u5B58\uFF0C30 \u79D2\u5185\u751F\u6548\u3002"
  });
  ctx.root.append(sheet.el);
  const g = window;
  if (!g.__msPopBound) {
    g.__msPopBound = true;
    document.addEventListener("click", () => {
      for (const p of document.querySelectorAll(".ms-pop")) p.style.display = "none";
    });
  }
  const status = el("div", "display:flex;gap:16px;flex-wrap:wrap;font-size:13px;opacity:.88;margin:2px 0 8px;");
  const msg = ui.msgline();
  sheet.body.append(status, msg);
  const listBox = el("div", "margin:12px 0 8px;display:flex;flex-direction:column;gap:8px;");
  sheet.body.append(listBox);
  let rows = [];
  let providers = [];
  const run = async (method, args) => {
    try {
      return await ctx.invoke(method, args);
    } catch (e) {
      msg.error(`\u8C03\u7528\u5931\u8D25\uFF1A${String(e?.message || e).slice(0, 120)}`);
      throw e;
    }
  };
  const renderRows = () => {
    listBox.innerHTML = "";
    if (!rows.length) {
      listBox.append(el("div", "font-size:13px;opacity:.6;padding:8px 2px;", "\u8FD8\u6CA1\u6709\u89C4\u5219\u3002\u70B9\u4E0B\u9762\u300C+ \u6DFB\u52A0\u4E00\u884C\u300D\u3002"));
      return;
    }
    const head = el(
      "div",
      "display:grid;grid-template-columns:96px 1fr 96px 1fr 44px;gap:8px;font-size:12px;opacity:.62;padding:0 2px;"
    );
    head.append(
      el("span", "", "\u65F6\u95F4"),
      el("span", "", "\u6A21\u578B"),
      el("span", "", "\u7A97\u53E3"),
      el("span", "", "\u7FA4\u6D88\u606F"),
      el("span", "", "")
    );
    listBox.append(head);
    rows.forEach((r, i) => {
      const line = el("div", "display:grid;grid-template-columns:96px 1fr 96px 1fr 44px;gap:8px;align-items:center;");
      const time = el("input", INPUT_CSS);
      time.type = "time";
      time.value = r.at;
      time.onchange = () => {
        rows[i].at = time.value;
      };
      const prov = makeSelect(
        r.provider || "",
        [{ v: "", label: "\u4E0D\u5207\u6362" }, ...providers.map((p) => ({ v: p, label: p }))],
        (v) => {
          rows[i].provider = v;
        }
      );
      const win = el("input", INPUT_CSS);
      win.type = "number";
      win.min = "0";
      win.step = "1000";
      win.placeholder = "\u4E0D\u6539";
      win.value = r.window ? String(r.window) : "";
      win.onchange = () => {
        rows[i].window = Number(win.value) || 0;
      };
      const mode = makeSelect(
        r.mode || "",
        MODES.map((m) => ({ v: m.v, label: m.label })),
        (v) => {
          rows[i].mode = v;
        }
      );
      const del = el("button", INPUT_CSS + "cursor:pointer;padding:5px 6px;", "\u5220");
      del.onclick = () => {
        rows.splice(i, 1);
        renderRows();
      };
      line.append(time, prov, win, mode, del);
      listBox.append(line);
    });
    fixScheme(listBox);
  };
  const table = ui.table({ head: ["\u65F6\u95F4", "\u89E6\u53D1", "\u7ED3\u679C"], maxHeight: 280 });
  const renderTable = (items) => {
    table.clear(items.length ? `\u5171 ${items.length} \u6761` : "\u8FD8\u6CA1\u6709\u6267\u884C\u8BB0\u5F55");
    for (const it of items) {
      table.addRow([shortTime(it.ts), it.rule || "\u2014", it.result || "\u2014"]);
    }
  };
  const bar = ui.rowbar();
  bar.append(
    ui.button("+ \u6DFB\u52A0\u4E00\u884C", {
      size: "sm",
      onClick: () => {
        rows.push({ at: "12:00", provider: "", window: 0, mode: "" });
        renderRows();
      }
    }),
    ui.button("\u4FDD\u5B58", { size: "sm", onClick: () => void save() }),
    ui.button("\u5237\u65B0", { size: "sm", onClick: () => void load() }),
    ui.button("\u7ACB\u5373\u5BF9\u9F50", { size: "sm", onClick: () => void runNow() })
  );
  sheet.body.append(bar);
  sheet.body.append(
    el("div", "margin-top:16px;font-weight:600;font-size:14px;margin-bottom:6px;", "\u6267\u884C\u8BB0\u5F55")
  );
  sheet.body.append(table.el);
  async function load() {
    try {
      const d = await run("overview");
      rows = (d?.rules ?? []).map((r) => ({
        at: r.at,
        provider: r.provider || "",
        window: Number(r.window) || 0,
        mode: r.mode || ""
      }));
      providers = d?.providers ?? [];
      status.innerHTML = "";
      const chip = (label, value) => {
        const s = el("span", "");
        s.append(el("span", "opacity:.62;", `${label} `), el("b", "", value || "\u2014"));
        return s;
      };
      status.append(
        chip("\u5F53\u524D\u6A21\u578B", d?.active ?? ""),
        chip("\u4E0B\u6B21", d?.next ?? ""),
        chip("\u8C03\u5EA6", d?.enabled ? "\u5F00" : "\u5173"),
        chip("\u6700\u8FD1\u4E00\u6B21", d?.lastRunAt ? shortTime(d.lastRunAt) : "")
      );
      renderRows();
      renderTable(d?.items ?? []);
      if (d?.lastResult) msg.info(`\u4E0A\u6B21\u7ED3\u679C\uFF1A${d.lastResult}`);
    } catch {
    }
  }
  async function save() {
    if (!rows.length) {
      msg.error("\u81F3\u5C11\u7559\u4E00\u6761\u89C4\u5219\uFF0C\u5426\u5219\u7B49\u4E8E\u628A\u8FD9\u4E2A\u63D2\u4EF6\u5173\u4E86");
      return;
    }
    for (const r of rows) {
      if (!/^\d{2}:\d{2}$/.test(r.at)) {
        msg.error(`\u65F6\u95F4\u683C\u5F0F\u4E0D\u5BF9\uFF1A${r.at}\uFF08\u8981 HH:MM\uFF09`);
        return;
      }
    }
    const d = await run("saveRules", [rows]);
    if (d?.ok) msg.info(d.message);
    else msg.error(d?.message || "\u4FDD\u5B58\u5931\u8D25");
    await load();
  }
  async function runNow() {
    const d = await run("runNow");
    if (d?.ok) msg.info(d.message);
    else msg.error(d?.message || "\u6267\u884C\u5931\u8D25");
    await load();
  }
  void load();
  fixScheme(sheet.body);
  setTimeout(() => fixScheme(sheet.body), 50);
  setTimeout(() => fixScheme(sheet.body), 400);
  if (schemeTimer !== null) clearInterval(schemeTimer);
  schemeTimer = window.setInterval(() => fixScheme(sheet.body), 5e3);
  if (!schemeObserver && typeof MutationObserver !== "undefined") {
    schemeObserver = new MutationObserver(() => fixScheme(sheet.body));
    schemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"]
    });
  }
}
var bundle = {
  panels: {
    rules: { mount: mountRules }
  }
};
var client_default = bundle;
export {
  client_default as default
};
