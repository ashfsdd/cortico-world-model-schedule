# 模型分时调度（cortico-world-model-schedule）

按时间自动切换 Coo 的模型供应商与上下文窗口（contextWindow：一次能记住多少对话，越小越省 token）。

## 为什么

- **深夜**：换到便宜的低峰供应商 + 群消息改成「只 @ 才回」，省 token
- **早上**：换回主力供应商
- **晚间**：群消息全实时，能主动接话

供应商名按你自己环境填（`GET /api/providers` 能查）。**示例不写死具体名字**，因为不同人接的供应商不一样。

## 首次配置清单（必做）

> 装完不配，它不会做任何事。

### 1. 打开开关

| 配置 | 填什么 | 不填会怎样 |
| :-- | :-- | :-- |
| `enabled` | `true` | 插件加载但完全不动 |

### 2. 写规则表

| 配置 | 填什么 | 不填会怎样 |
| :-- | :-- | :-- |
| `rulesJson` | JSON 数组，每条有 `at`（时刻 HH:MM）和可选的 `provider` / `context` | 空数组 = 不调度 |

**最小可用示例**（凌晨降窗 + 早上切回）：

```json
[
  { "at": "02:00", "provider": "qianfan-tp", "context": { "qianfan-tp": 131072 } },
  { "at": "08:00", "provider": "beichen", "context": { "beichen": 131072 } }
]
```

### 3. 确认供应商名字对

`provider` 必须是 `GET http://127.0.0.1:17788/api/providers` 里真实存在的名字。

**填错了会怎样**：插件记一条日志然后跳过这条规则，不影响 Coo 运行。

### 4. 两个可选开关

| 配置 | 默认 | 说明 |
| :-- | :-- | :-- |
| `checkSec` | 30 | 多久检查一次（秒） |
| `catchUpOnStart` | true | Coo 启动时补执行「错过的最近一次」 |

### 配完自检

1. 看 Coo 日志有没有 `model-schedule` 的「已应用规则」记录
2. 把某条规则设成 1 分钟后，等它触发，看模型是否真的切了

---

## 规则怎么写

每条规则是个对象，**只有 `at` 必填**，其余都可选：

| 字段 | 作用 | 例子 |
| :-- | :-- | :-- |
| `at` | 时刻（必填） | `"22:00"` |
| `provider` | 切模型供应商 | `"qianfan"` |
| `context` | 改上下文窗口 | `{"qianfan": 131072}` |
| `set` | **改任意配置项**（key 写完整路径） | `{"worlds.qqbot.receiveMode": "hybrid"}` |
| `restart` | **改完重启哪些插件** | `["qqbot"]` |

### 所以它不只切模型

任何「到点改配置 + 重启」的事都能做：

```json
[
  { "at": "02:00", "provider": "qianfan", "context": { "qianfan": 131072 },
    "set": { "worlds.qqbot.receiveMode": "hybrid" }, "restart": ["qqbot"] },

  { "at": "20:00", "set": { "worlds.qqbot.receiveMode": "passive" }, "restart": ["qqbot"] },

  { "at": "23:30", "set": { "worlds.live-cue.enabled": false }, "restart": ["live-cue"] }
]
```

第三条就是「凌晨自动关掉弹幕桥」—— 不用守到那个点。

### 三个注意

- **`set` 的 key 必须是完整配置路径**（`GET /api/config` 里能看到的那个层级）
- **`restart` 会被跳过的情况**：如果目标状态已经满足，插件不重启（幂等）
- **同一分钟多条会按顺序执行**，后面的能覆盖前面的

## 三个特性

1. **幂等**：目标状态已经满足就不写盘、不重启，重复跑无副作用
2. **启动补漏**：Coo 启动时按「最近一次应该执行的时刻」对齐，跨零点会回退到昨天的规则
3. **不崩**：任何一步失败只记日志，不影响 Coo 主进程

## 依赖

只调 Coo 自己的 HTTP 接口（`127.0.0.1:17788`），不依赖任何外部服务。

- 切供应商：`POST /api/providers/<name>/activate`
- 改窗口：`GET /api/providers/<name>` 拿 revision → `POST /api/providers/<name>/save`（乐观锁，409 自动重试 3 次）

## 零 token

不注入环境提示词、不提供工具 —— 不占她的上下文。

## 测试

```bash
npm test
```

覆盖 5 项（只测实际在用的路径，不测定时器本身）：

- 默认规则至少 4 条、时间格式合法
- 规则按时间递增
- 每条规则至少有一个动作
- 默认配置的关键项类型正确
- `rulesJson` 能被解析且与 `DEFAULT_RULES` 一致

> 本插件共用宿主的 tsx 加载器，所以 `npm test` 里的路径指向 Coo 安装目录；换机器时需要改 `package.json` 的 `scripts.test`。
