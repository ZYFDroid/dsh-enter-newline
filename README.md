# dsh-enter-newline

DSH（DeepSeek Harness）web 插件：**输入框里 Enter 换行、Ctrl/Cmd+Enter 发送**。

专为喜欢在 Prompt 里写一大段条理清晰 Markdown 的用户设计——默认的「Enter 发送 / Shift+Enter 换行」改成「Enter 换行 / Ctrl+Enter 发送」，同时保留：

| 按键 | 行为 |
|---|---|
| `Enter` | 插入换行（本插件新增） |
| `Ctrl+Enter` / `Cmd+Enter` | 发送（composer 原有加速提交路径，未改动；忙碌时仍可插话/清空队列） |
| `Shift+Enter` | 换行（原有行为） |
| `Alt+Enter` | 放行给 composer（composer 不看 `altKey`，等价于默认的 Enter 发送） |

> **版本适配**：本插件最初针对 DSH **0.1.0** 的 `textarea` 版 composer 编写；在 **0.1.7**（composer 已换成 Lexical `contenteditable`）上旧实现**完全失效**，见[版本适配说明](#版本适配说明)。

## 目录

- [插件架构速览](#插件架构速览)：DSH 插件系统怎么分层、client 插件如何被加载
- [本插件原理](#本插件原理)：回车拦截逻辑与安全边界
- [版本适配说明](#版本适配说明)：0.1.0 → 0.1.7 composer 重写带来的差异
- [安装](#安装)
- [开发 / 重建](#开发--重建)
- [卸载](#卸载)

---

## 插件架构速览

DSH 是一个 cordis（服务总线）插件图。profile 目录（默认 `~/.dsh/profiles/<name>`）的 `package.json` 里 `dsh.profile.bundles` 按顺序列出插件包；每个包的 `dsh.bundle.patch` 指向一个 `cordis.patch.yml`，boot 时逐层合并成插件图。参考本机已装的 `dsh-better-sidebar`、`dsh-at-file`。

一个 bundle 插件包可以有两个「半身」：

```
package.json
├── dsh.bundle.patch  → ./cordis.patch.yml   （把插件行 insert 进 cordis 图）
├── dsh.client        → { platform: "web", inject: [...] }
├── exports["."]      → lib/index.js          （宿主半身：node 端 cordis 插件）
└── exports["./client"] → lib/client.js        （浏览器半身：web 端插件）
```

**client 插件的加载链**（关键结论，来自本机 rc.7 源码 `@deepseek-ai/dsh-client-modules`）：

1. 宿主端 `ClientModuleRegistry` 扫描**已挂载的 loader 条目**，对声明了 `dsh.client.platform === "web"` 且 `exports["./client"]` 存在的包，生成 boot 清单 `window.__DSH_BOOT__ = { rev, entries: [{ id: <包名>, url: "/plugins/<包名>/client.js?rev=...", inject, immediately }] }`，并注入 index.html。
2. 浏览器端（`@deepseek-ai/dsh-client-web` 的 shell）解析清单，加载每个 bundle；bundle 用 `window.__ModuleLoader__.load({ id, factory })` 注册，`factory(require)` 返回 `module.exports`。
3. 对每个 entry 执行 `loader.create({ name: <包名> })`——模块导出即 cordis 插件面：`{ inject: [...服务名], apply(ctx) }`。
4. bundle 里的 `require("@deepseek-ai/dsh-*")` / `react` 由 web app 的模块表提供（所以构建时这些要 external，并在 `dsh.client.inject` 里声明依赖的包名，让清单包含对应模块行）。**本插件的 client 半身在运行时不 `require` 任何东西**，因此 `dsh.client.inject` 为空数组。

结论：**改输入框行为 = 写一个只带 client 半身的插件**，宿主半身只需是一个能挂载的空 cordis 插件（本插件即是如此）。

## 本插件原理

composer 的 Enter 处理在 `@deepseek-ai/dsh-client-ui-conversation` 的 `registerComposerKeymap` 里（当前 `lib/client.js` 约 16554-16565 行），是注册到 **Lexical 编辑器根元素**上的一条编辑命令（`KEY_ENTER_COMMAND`）：

```js
editor.registerCommand(cn$1 /* KEY_ENTER_COMMAND */, (event) => {
  if (event?.shiftKey === true) return false;            // Shift+Enter → 编辑器自己插软换行
  if (event !== null && isComposingEvent(event, recentlyComposing)) return true;  // IME 组合中不提交
  if (handlers.arbitrate("enter", false) !== "pass") { event?.preventDefault(); return true; }  // 菜单打开时消费 Enter
  event?.preventDefault();
  if (!handlers.canSubmit()) return true;
  handlers.submit(event?.ctrlKey === true || event?.metaKey === true);             // 发送（accelerated = ctrl/meta）
  return true;
}, 4)
```

本插件在 `document` 上挂一个**捕获阶段**的 `keydown` 监听，它比编辑器根元素上的监听先跑：

1. 纯 `Enter`（无修饰键）落在 composer 编辑面（`[data-composer-card] [data-composer-input]`，`contenteditable` 的 `div`）上时：`preventDefault()` + `stopPropagation()`——既不触发浏览器原生换行，事件也传不到编辑器根，`KEY_ENTER_COMMAND` 因此既不会提交也不会插入；
2. 随后在编辑面上派发一个**合成的 `beforeinput` 事件**（`inputType: "insertLineBreak"`）。这正是浏览器为 Shift+Enter 产生的事件，Lexical 的 `beforeinput` 监听里就有 `case "insertLineBreak": Nl(r, Ue$2, !1)` 分支（`Ue$2` = `INSERT_LINE_BREAK_COMMAND`）。于是这次换行走的是编辑器自己的输入管线：文档模型、历史栈（撤销/重做）、草稿投影、输入状态机全部按一次普通编辑处理。Lexical 内部（拖拽删除）也用同样的 `dispatchEvent(new InputEvent('beforeinput', …))` 手法。
   - 因为是编辑器在**当前选区**上执行这条命令，换行插在**光标处**（实测：光标移到行中按 Enter 即从该处断开），跨行选区、撤销栈、光标位置都正确——比那些只会往末尾追加 `\n` 的做法（如已停更的 `dsh-enter-customizer`）可靠。
   - 插入的是**软换行**（`LineBreakNode`，与 Shift+Enter 同类），不是新段落，与 composer 既有行为一致。
   - 特性探测用的是「构造一个实例看 `inputType` 是否保留」，**不能**写 `InputEvent.prototype.inputType !== undefined`：直接读原型拿到的是 `undefined`（Chromium/Node 实测如此），条件恒假会让主路径被静默跳过——表象就是 Enter 既不换行、也不发送。
3. `Ctrl/Cmd+Enter` 直接放行 → composer 原样走加速提交（发送）。
4. 四类硬性放行，避免破坏既有交互：
   - **IME 组合中**（`isComposing` / `keyCode === 229` / 编辑面上的 `[data-composer-composing]` 标记，含组合刚结束的 10ms 窗口）：中文输入法用 Enter 上屏，必须放行；
   - **弹出层打开**（composer card 内出现 `[role="listbox"]` / `[role="menu"]` / `[role="dialog"]`，即命令菜单、`@` 提及选择器、上下文面板）：Enter 应确认选中项而非换行；
   - **编辑面不可编辑**（`contenteditable="false"`；智能体忙碌，或未选工作区时的 hero 态）：Enter 应维持原行为（打开工作区选择器）；
   - **不在 composer card 内**（队列编辑器、会话标题等其他输入点）：一律不碰。

没有 `beforeinput`（老引擎）时回退到 `document.execCommand('insertLineBreak')`；老版本（0.1.0）的 `textarea` 版 composer 也仍然兼容：走 `execCommand` → `insertText` → 「原生 value setter + 派发 `input` 事件」三级回退。

## 版本适配说明

| DSH composer | 草稿输入面 | 本插件版本 | 结果 |
|---|---|---|---|
| 0.1.0（textarea 版） | `[data-composer-card] textarea`（React `onKeyDown` 提交） | 0.1.0 | 正常 |
| 0.1.7-rc.1（Lexical 版） | `[data-composer-card] [data-composer-input]`（`contenteditable` + `KEY_ENTER_COMMAND`） | 0.1.0 | **完全失效（静默）** |
| 0.1.7-rc.1 | 同上 | 0.2.0 | 正常 |

0.1.0 版失效的原因（全部是静默失败，没有任何报错）：

- `target instanceof HTMLTextAreaElement` 对 `contenteditable` 的 `div` 永远为 `false`，捕获监听在第一道判断就 `return`，回车照旧发送；
- `document.execCommand('insertLineBreak')` 与 `HTMLTextAreaElement.prototype.value` setter 对 `contenteditable` 都没有意义。

0.2.0 的改动：

- 识别新的编辑面（`[data-composer-input]` + `contenteditable`），提交拦截逻辑不变（仍是捕获阶段 `preventDefault` + `stopPropagation`）；
- 换行改为派发 `beforeinput(insertLineBreak)`，接入 Lexical 自己的输入管线（不再依赖 `execCommand` 与 React `onChange`）；
- IME 放行新增 composer 自己的 `[data-composer-composing]` 标记判定；
- 保留 0.1.0 的 `textarea` 兼容路径；
- `dsh.client.inject` 从 `["@deepseek-ai/dsh-client-runtime"]` 改为 `[]`：client 半身运行时不 `require` 任何模块，声明的包名只会让宿主去解析一个并不存在的 loader 条目（`@deepseek-ai/dsh-client-runtime` 依赖未发布的 `@deepseek-ai/dsh-compact`，无法独立安装）；类型面改为在 `src/client/index.ts` 里就地声明所需的最小 `ClientContext` 结构。

**0.2.0 的实测记录**（本机 profile `web`，`@deepseek-ai/dsh-client-ui-conversation@0.1.7-rc.1`）：

- 纯 Enter 在光标处插入软换行 ✅（含行中、跨段位置；是软换行而非新段落）
- `Shift+Enter` 照旧换行 ✅
- `Ctrl+Enter` 发送 ✅（含忙碌时的加速提交路径）
- 中文输入法候选框上屏不受影响 ✅
- `/` 命令菜单、`@` 提及选择器打开时 Enter 仍是确认选中项 ✅
- `Ctrl+Z` 能撤销刚插入的换行 ✅

> 中途踩过一个坑：为了判断浏览器是否支持合成 `beforeinput`，曾写成 `InputEvent.prototype.inputType !== undefined`——该判断恒假，于是插入路径被整段跳过，现象是 **Enter 既不换行也不发送**（拦截已生效、插入没发生）。现已改为构造实例探测，并保证探测失败也仍会尝试 `execCommand('insertLineBreak')`；`scripts/verify.mjs` 的桩也改成真实浏览器语义（`inputType` 在实例上、原型上没有），因此这类回归会被测试挡住。

`scripts/verify.mjs` 里除了桩环境行为测试，还会对**本机已装的 `dsh-client-ui-conversation` bundle** 复核这四条依赖契约（找不到安装则跳过）：`data-composer-input`、`data-composer-card`、`case "insertLineBreak"`、`data-composer-composing`。DSH 升级后跑一次 `npm run verify` 即可知道是否需要再适配。

## 安装

前置：`dsh` 已安装、`pnpm` 可用（`dsh plugin` 是 pnpm 转发器）。

```sh
# 在本插件目录（或任意路径）：
dsh plugin --profile web add link:C:/Users/ZYFDroid/Documents/DSHStudy/dsh-enter-newline
# link: 是符号链接安装，改源码即生效（重启 web 后）；发布场景可用 file:<tarball>
```

`dsh plugin` 会检查 `dsh.bundle.patch` 并把 `dsh-enter-newline` 追加进 `dsh.profile.bundles`，无需手改 profile 文件。

**重启 `dsh web`** 后生效（client 插件在 boot 时进清单；变更需重启，无热更）。

## 开发 / 重建

```sh
npm install          # devDeps: esbuild / typescript / @types/node / @deepseek-ai/cordis（注意 Windows 需正常 shell，沙箱内 spawn 会被拦）
npm run typecheck    # tsc --noEmit
npm run build        # src/ → lib/（esbuild 双端打包）
npm run verify       # node 桩环境冒烟测试（无需浏览器）+ 已装 composer 契约复核
npm run check        # typecheck + build + verify
```

产物：
- `lib/client.js` —— 浏览器端，`window.__ModuleLoader__.load(...)` 包裹的 CJS bundle；
- `lib/index.js` —— node 端空宿主插件。

## 卸载

```sh
dsh plugin --profile web remove dsh-enter-newline
```

---

MIT
