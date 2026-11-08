# dsh-win-env-kit

一个可发布的 DSH 技能插件包，把 **Windows 环境规则** 和 **检查这些规则的零依赖脚本** 一起打包。装一次，任意工作区都能用。

- 包名：`dsh-win-env-kit`
- 技能名：`win-env-kit`
- 版本：`0.2.1`（独立于工作区的 `VERSION` 文件）

## 包里有什么

```
dsh-win-env-kit/
  lib/index.js                     Cordis 插件：注册技能 provider
  lib/config.mjs                   Config 架构（每条规则一个开关）
  lib/rules.mjs                    规则目录 + 正文过滤
  scripts/verify-provider.mjs      可机器判定的自检（npm run verify）
  cordis.patch.yml                 host-plane insert 行（id: win-env-kit）
  dsh.plugin.json                  兼容性清单
  icon.svg / locale/*.json         展示元数据（英文 + 中文）
  skills/win-env-kit/
    SKILL.md                      九条规则（已泛化、可移植）
    HOST-PROFILE.md               最初那台机器的实测值示例
    .gitattributes.example        拷进仓库根的 CRLF/LF 分轨模板
    tools/                        六个零依赖脚本
      dsh-env-lint.mjs             BOM / EOL / U+FFFD / GBK / SCRATCH 检查
      build-audit.mjs              MOTW / TRUST-MARK / SIGN / PE / TEMP-PATH
      dsh-privacy-gate.mjs         截图隐私门禁（ALLOW / BLOCK）
      dsh-teardown.mjs             按台账清理（gone ≠ error）
      dsh-doc-lock.mjs             共享文档 claim/check/release 锁
      dsh-screenshot.ps1           只截目标窗口（ASCII + CRLF）
```

## 安装（当前 DSH profile）

用 `plugin_manager`，`action: install_bundle`，`target` 填本包的**绝对目录**。不要手写 profile 的 `package.json` 或 `cordis.patch.yml` —— 这些步骤由 `install_bundle` 完成。改动对该 profile 下所有会话生效且重启后保留。

启用后，会话技能目录里会出现 `win-env-kit`。发布到 npm（`npm publish`）是另一个需要单独确认的步骤。

## 选择开启哪些规则

九条规则默认全开。要收窄范围，在**你自己 profile 的** `cordis.patch.yml` 里给这个插件的行加 `config`（不是本包里的那份——后一层的 patch 会覆盖它）：

```yaml
- id: win-env-kit
  config:
    enabledRules: []
    rule1: true
    rule2: true
    rule3: false        # 这里没有要分发的二进制
    rule4: false        # ……也就不需要 SmartScreen 信誉那一套
    rule5: true
    rule6: true
    rule7: true
    rule8: true
    rule9: true
```

……或者直接点名要保留哪几条：它的优先级高于每条规则的开关，所以那九个开关可以不写（省略的字段取 schema 默认值，随后被忽略）：

```yaml
- id: win-env-kit
  config:
    enabledRules: [1, 2, 5, 7, 8]
```

选择会带来这些效果：

- 被关掉的规则，它的 `## N.` 整节在模型看到之前就被删掉。前言、脚本路径说明、验证命令、host profile 指针保留。
- 验证命令行尾标注 `# rules 3-4 + 9` 的会跟着它的规则一起走；没有标注的永远保留。如果一段代码块的行被删空，整段围栏会一起移除，不会留个空壳。
- 已发布的 description 与正文开头的 `> **Configured subset:**` 提示共用同一句话 —— `This install enables rules 1, 2, 5, 7, 8; rules 3, 4, 6, 9 are off.` —— 保证触发文本和加载后的正文对「哪些规则生效」的说法始终一致。技能正文里已经没有某条规则、触发词却还在宣传它，比这两种极端都糟。
- `config` 是整份替换、不做深合并：要保留的字段都得重新写出来。`enabledRules: []` 表示「交给每条规则的开关决定」。
- 不是公认「关闭」取值（`false`、`"false"`、`0`）的值，一律当作开着，这样写坏的配置不会静悄悄把技能阉掉。

设置界面会根据 `lib/config.mjs` 的 schema 为每条规则渲染一个开关，开关的描述就是它在 `SKILL.md` 里的标题。

## 自带脚本怎么被找到

技能被加载时，`skill` 工具会给出 base directory，例如：

```
Base directory for this skill: <profile>/node_modules/dsh-win-env-kit/skills/win-env-kit
Resolve relative paths mentioned by this skill against the base directory before using them.
```

这个目录来自 provider `get()` 的 `resourceBase: { kind: 'directory', path: ... }`。**`SKILL.md` 里所有 `tools/...` 路径都相对这个 base directory，不是工作区 CWD。** 先解析成绝对路径再用：

```powershell
node "<SKILL_BASE>/tools/dsh-env-lint.mjs" .
node "<SKILL_BASE>/tools/build-audit.mjs" out\app.exe --strict
node "<SKILL_BASE>/tools/dsh-privacy-gate.mjs" "_scratch\*\shots\*.png" --strict
```

参数里的 `.` 仍是工作区 CWD，因此检查目标是用户的项目，无需把脚本拷进工作区。

## 可移植性

规则是通用的；最初那台机器的实测值都是**示例**，统一放在 `HOST-PROFILE.md` 并明确标注。换到新机器时：

- 重新测系统代码页（`chcp`）、PowerShell 版本、屏幕尺寸、Defender/SmartScreen 状态、代码签名证书是否可用。
- `dsh-privacy-gate.mjs` 默认用 1280x800 作为保守的全屏嫌疑下限；屏幕不同用 `--screen WxH` 或环境变量 `DSH_SCREEN` 覆盖。
- 脚本里的检测正则（`S-1-4-\d`、`dsh-spill-`、`Temp\dsh-`）是**检测规则**，不是机器身份，必须保留。

## 把索引加进你的仓库

`AGENTS.md` 是工作区专属索引，不随包分发。把下面片段拷进仓库的 `AGENTS.md`：

```markdown
## Windows 环境规则

本文件是索引，不是手册。在写构建脚本、打包、改文本文件编码、截图或产出分发物之前，
先加载 `win-env-kit` 技能（由 `dsh-win-env-kit` 插件提供）。验证命令：

    node "<SKILL_BASE>/tools/dsh-env-lint.mjs" .
    node "<SKILL_BASE>/tools/build-audit.mjs" <产物> --strict
    node "<SKILL_BASE>/tools/dsh-privacy-gate.mjs" "_scratch\*\shots\*.png" --strict
```

## 验证（什么叫「完成」）

```powershell
npm pack --dry-run --json     # 六个脚本、SKILL.md、icon、locale 都在清单里
npm run verify                # provider + 规则选择 + Config schema
node tools/dsh-env-lint.mjs . # UTF-8 / LF-CRLF / 无 U+FFFD / 无 SCRATCH
```

`npm run verify` 断言：`list()` 恰好返回一个名为 `win-env-kit` 的候选；`get()` 返回一个目录 `resourceBase`，其下 `tools/dsh-env-lint.mjs` 存在；正文含验证章节；`SKILL.md` 没有漏回本机 SID。之后它还驱动规则选择：默认九节全在且无提示、`rule5: false` 恰好删掉第 5 节并在提示与 description 里点名、`enabledRules` 压过逐条开关、`ruleTagsOf` 能把 `1-2` 展开且不把 `#` 前的版本号当标注。Config 架构在能解析真实 schemastery 时对真库校验，否则用可链式调用的 stub。退出码非零即构建失败。

## 维护约定

`skills/win-env-kit/tools/` 是工作区 `tools/` 的逐字节副本。脚本有改动时两份同步更新，用 `Get-FileHash` 核对，再跑 `npm run verify`。`dsh-screenshot.ps1` 必须保持 **纯 ASCII + CRLF + 无 BOM**；其余文件都是 UTF-8 无 BOM + LF。

`lib/rules.mjs` 里存着每条规则的编号与标题，标题必须和 `SKILL.md` 的 `## <n>. <title>` 一致——缺节的规则会让 `npm run verify` 失败；标题漂移本身只会让设置界面的标签变差。

`SKILL.md` frontmatter 里的 `description` 是唯一会注入每个会话技能目录的触发文本，宿主会硬截断到 500 字符。保持简短，把「按工件形态」的触发词（写 `.ps1` / `.md` / `.csv`、搬移或删除文件）前置，而不是写任务目标——磁盘清理、盘点这类任务照样会写脚本和报告。`npm run verify` 会在 description 超过 500 字符时失败。正文开头有一段「加载后自检」，会把当前计划重新对照这份工件清单。

## 许可证

MIT
