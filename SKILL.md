---
name: pve-computer-use
description: Control and inspect a virtual machine on Proxmox VE through its VNC console. Captures framebuffer screenshots and injects mouse and keyboard events (click, double-click, move, drag, scroll, type, keypress, reset) via pve-cu. Use when the user asks to operate, automate, or inspect a VM running on the PVE host (BIOS, installer, login screen or desktop), when no in-guest agent is available.
---

# PVE Computer Use

通过 PVE 的 VNC 控制台操作虚拟机，形成闭环视觉反馈。**目标机内不需要安装任何 Agent。**

## Architecture

1. **Observe**: `pve-cu --target <name> observe` 截取 framebuffer，返回本地图片路径。
2. **Inspect**: 用 Pi 的 `read` 工具读取该图片，判断当前界面状态。
3. **Plan**: 定位目标元素，确定最小且安全的下一步动作。
4. **Act**: 执行 `pve-cu --target <name> click/type/key/...`。
5. **Verify**: 用 `observe --wait-change` 等客户机**真正重画**后再 `read` 验证，不要用固定 sleep 盲等。

```
   pve-cu observe → read <filePath> → 视觉分析与规划 → pve-cu click/type/key → 重复
```

先确认 target：`pve-cu targets`。每个 target 固定绑定一台 VM（endpoint + node + vmid），不要试图"切换当前虚拟机"。

## Pi 原生工具（优先）

若已加载 `pve_console`，优先用它：一次工具调用执行**一个动作**并直接返回最新截图附件，
不必再用 `read` 打开路径。先 `{target:"windows-vm", action:"observe"}` 看图；之后例如：

```json
{"target":"windows-vm","action":"double-click","x":37,"y":237,"wait":"stable","minWaitMs":2500,"waitTimeoutMs":10000}
```

密码仍只通过 `fromFile`（绝对路径或 `~/...`）交给 pve-cu，不读出内容、不用 `text`。
TOTP 仍只走专用 MCP，工具报成功不等于认证成功，必须看目标屏幕。
不要并行发同一目标的操作。所有敏感操作确认规则仍适用。

- 输入动作默认等待稳定画面（至少 1500ms，连续 800ms 无重绘，最多 5000ms）；启动类建议 `minWaitMs:2500`。
- `stable:true` **只表示重绘暂歇，不代表窗口已打开或焦点已就绪**，必须看图确认。
- 光标闪烁、时钟等可能导致 `stable:false/timedOut:true`；直接看最终截图，不要因此重发操作。
- `observationError` / `imageError` 表示动作后观察失败，**不能据此重试动作**；重新 observe。
- 传输超时/取消也不撤销已发送动作；先观察，禁止自动重试输入。
- `timings`、`cliMs`、`toolTotalMs` 帮助区分输入、观察和 CLI 耗时；不包含下一轮模型推理耗时。

未加载原生工具时 CLI 可合并动作与截图：
`pve-cu --target windows-vm click --x 0.5 --y 0.5 --observe --wait-stable`，随后 `read` 返回的 `frame.filePath`。
单独观察可用 `observe --wait-stable --stable-ms 800 --min-wait 1500 --wait-timeout 5000`。

## CLI Reference

### 1. Status

```bash
pve-cu --target windows-vm status
```

返回 `connected`、`width`/`height`、`framebufferUpdates`、`authMethod`、`vmName`、`tlsMode`、`notes`、`pageErrors`。
`connected: false` 或存在 `failure` 时先排错，不要盲目发送输入。
排错顺序：`tlscheck`（网络/证书）→ `status`（认证/权限/VM 状态）→ `reconnect`（票据过期）。

### 2. Capture Screen Frame

```bash
pve-cu --target windows-vm observe
pve-cu --target windows-vm observe --wait-change                 # 等画面变化，最多 5s
pve-cu --target windows-vm observe --wait-change --wait-timeout 15000   # 开机器/加载页面时用
```

`--wait-change` 的基线是**上一个输入动作完成时的帧计数**，因此点击引起的重画会立刻返回；
超时也不算失败（静止画面本来就不会推送更新），输出里 `changed: false` 时直接看截图内容判断。

输出：

```json
{
  "frameId": "frame_2026-09-06_19-43-12-000_a1b2c3",
  "filePath": "/home/user/.cache/pve-cu/windows-vm/frames/frame_....png",
  "width": 1920,
  "height": 1080,
  "capturedAt": "2026-09-06T19:43:12.000Z",
  "framebufferUpdates": 42,
  "lastUpdateAt": "2026-09-06T19:43:11.880Z",
  "changed": true,
  "waitedMs": 320
}
```

（`changed` / `waitedMs` / `baselineUpdates` 只在使用 `--wait-change` 时出现。）

**紧接着必须用 `read` 工具打开 `filePath` 看图**，不要凭想象描述界面。

### 3. Mouse Actions

坐标支持归一化 `0.0~1.0`（左上 `0.0,0.0`，中心 `0.5,0.5`，右下 `1.0,1.0`），
也支持当前 framebuffer 像素，或 `--space` 自定义坐标空间。

负数参数两种写法都行（`--dy -3` 或 `--dy=-3`）；但**以 `-` 开头的文本**必须用 `=`，
例如 `type --text=-verbose`，否则会被当成开关。

```bash
pve-cu --target windows-vm click --x 0.5 --y 0.5
pve-cu --target windows-vm click --x 0.8 --y 0.2 --button right
pve-cu --target windows-vm double-click --x 0.25 --y 0.35
pve-cu --target windows-vm move --x 0.5 --y 0.5
pve-cu --target windows-vm drag --from-x 0.2 --from-y 0.3 --to-x 0.7 --to-y 0.3 [--button left]
pve-cu --target windows-vm scroll --x 0.5 --y 0.5 --dy 4     # dy>0 向下/向后，dy<0 向上/向前
```

### 4. Keyboard Actions

```bash
pve-cu --target windows-vm type --text "https://example.com"    # 仅 ASCII
pve-cu --target windows-vm key --keys "ctrl,l"
pve-cu --target windows-vm key --keys "alt,f4"
pve-cu --target windows-vm key --keys "ctrl,shift,esc"
pve-cu --target windows-vm key --keys "Enter"      # Escape / Tab / Backspace / f1..f24
pve-cu --target windows-vm key --keys "win"        # Super/Meta，Windows 开始菜单
pve-cu --target windows-vm key --keys "up|down|left|right|home|end|pageup|pagedown|delete|insert"
```

中文无法直接注入：需要客户机内已有中文输入法，用 `type` 打拼音，再用数字/空格选候选词，每一步都靠截图确认。
实测流程（Windows 11 + 微软拼音）：

1. 看托盘输入法指示（`中`/`英`），需要时按 `Shift` 切换（截图确认）；
2. `type --text "jishiben"` → 截图应看到**候选条**（底部 `1 记事本 2 几十本 …`）与框内拼音组合串；
3. `key --keys 1`（或空格）上屏 → 截图确认汉字已进入输入框；
4. 用完把输入法切回原来的状态，避免影响用户后续手动输入。

**秘密（密码/token）绝不用 `--text` 传**（会进 argv 与进程列表）：

```bash
pve-cu --target windows-vm type --from-file "$HOME/.pi/agent/secrets/windows-vm-password"   # 文件 0600
cat pass.txt | pve-cu --target windows-vm type --stdin
```

### 5. Emergency Reset / Reconnect

```bash
pve-cu --target windows-vm reset        # 释放所有按键与鼠标按钮，防止卡键
pve-cu --target windows-vm reconnect    # 票据过期或连接中断后重连
pve-cu --target windows-vm daemon stop
```

排错用（不发送凭据、不触碰 VM）：

```bash
pve-cu targets
pve-cu --target windows-vm doctor           # 安装自检清单，不发送凭据
pve-cu --target windows-vm doctor --auth    # 额外登录并读 VM 状态（会发送凭据）
pve-cu --target windows-vm fingerprint      # 证书 SHA-256，写进 config 的 tlsFingerprint
pve-cu --target windows-vm tlscheck         # 可达性 + 证书固定是否生效
pve-cu --target windows-vm daemon log       # 打印 daemon 日志路径
```

**遇到任何失败先跑 `doctor`**：它按 `config / bundle / chromium / tls / api / credentials / daemon`
逐项给出 `ok`、`detail` 和 `hint`，比猜测快得多。向用户报告问题时直接引用失败项的 `hint`。
只有用户明确要求验证登录时才加 `--auth`。

## Safety and Operational Rules

1. **总是读取最新截图**：不要基于上一步的预期猜测界面。
2. **一次一个动作**：执行一个有意义的动作（或向已聚焦输入框连续输入），然后立刻观察。
3. **敏感操作必须先确认**：重启/关机/进入 BIOS、删除文件、修改网络与防火墙、输入密码或提交支付。
   暂停并向用户确认后再执行。
4. **卡键恢复**：动作没有预期效果时先 `reset`，再 `observe` 评估。
5. **不要与人抢控制台**：用户自己开着 PVE 网页控制台时，先请对方关闭该标签页，避免输入互相干扰。
6. **不要在命令行里出现任何密钥**：Token/密码只能来自环境变量与配置文件；日志与截图目录权限为 `0700/0600`。

## Operational Gotchas

### A0. 用 --wait-change 代替盲等
动作之后不要用 `sleep` 猜测等待时间。正确做法：
`click/type/key` → `observe --wait-change [--wait-timeout N]` → `read` 看图。
开机器、进 BIOS、系统启动、大页面加载这类慢变化，把 `--wait-timeout` 提到 15000~30000。

### A. 首帧需要时间
`observe`/`status` 首次调用会完成认证、申请票据、启动无头浏览器并等待第一个 framebuffer update，
可能需要数秒到数十秒（超时 120s）。**不要因此重复并发调用**，等命令返回。

### B. 画面不动 ≠ 虚拟机死机
`framebufferUpdates` 长时间不变只说明画面静止（VNC 只推送变化区域）。
判断状态要看截图内容，并结合 `status.connected`；确认可用 `key --keys "ctrl,alt,delete"` 之类动作后再截图验证（属敏感操作，先确认）。

### C. 黑屏的多种原因
BIOS/UEFI 未点亮显示、客户机关闭了显示器、控制台刚重连还未收到完整帧。
处理顺序：`observe` 重试一次 → `status` 看 `failure`/`pageErrors` → `reconnect` → 再截图 → 最后才怀疑虚机关机。

### D. 分辨率会变化
客户机切换分辨率（进桌面、退出全屏、RDP 断开）后 framebuffer 尺寸变化，
之前的像素坐标失效。**分辨率变化后必须重新截图并重新计算坐标**（优先用归一化坐标）。

### E0. 密码正确也可能因焦点/界面时序导致登录失败
密码输入前显式点击密码框并观察确认焦点；不要仅凭蓝色下划线认为输入已就绪。
凭据界面可能超时回锁屏，上一张截图不能长期代表当前焦点。
若同一密码文件显式聚焦后登录成功，不能把先前失败归因于文件内容错误。
出现错误时先检查输入状态并停止连续重试，避免锁定账户。

### E. 登录界面密码框不回显
向 Windows 登录界面注入密码后，截图里密码框可能仍是空的。
不要据此判断失败：等几秒后看画面是否进入桌面（成功）或出现"密码错误"（失败）。

### F. 票据与连接会过期
PVE 的 vnc ticket 是短期的，控制台空闲也可能断开。出现 `Console dropped ...` / `failure` 时执行 `reconnect`，
仍失败再检查 `status.authMethod`、权限（需要 `VM.Console`）与 VM 是否 running。

### G. TLS 指纹必须固定
PVE 用自己的集群 CA 签发证书，且握手时不下发该 CA，系统信任库会直接拒绝。
首次使用前运行 `pve-cu --target <t> fingerprint`，把摘要写进配置的 `tlsFingerprint`，
再用 `pve-cu --target <t> tlscheck` 验证（不发送任何凭据）。
指纹不符时 Daemon 会在写入任何请求字节前断开，因此凭据不会泄露给冒充者；
不要用 `insecureTls` 绕过。

### H. 久未操作后的第一条命令会慢几秒
Daemon 默认空闲 10 分钟就释放控制台会话（票据 + 无头浏览器），避免长期占着 VM 控制台。
下一条命令会自动重新认证、申请票据并重连，因此**慢不等于失败**：
等它返回（超时 120s），不要因为等待而并发重复发命令。

### I. Windows 安全登录：先送 Ctrl+Alt+Del（实测踩坑）
启用安全登录的机器在锁屏上**普通按键和点击只会“唤醒”屏幕**（时钟滑一下又回去），不会出凭据界面。
必须：

```bash
pve-cu --target <t> key --keys "ctrl,alt,delete"
```

才会出现用户头像 + 密码框。看不到密码框时先送 SAS，再考虑其他原因。

### J. 光标重绘滞后：单张截图不能判定输入失败（实测踩坑）
Windows 在标准 VGA 上是软件光标，**光标位置的重绘可能滞后于输入**：move 之后截图里光标还在旧位置，
但 guest 内部位置已经更新（下一次任意重绘时才画出来）。因此：

1. 不要用“光标没动”判定鼠标失效；
2. 用 `observe --wait-change` 抓输入引起的**次级效果**（动画、界面切换、弹窗）；
3. 需要确认坐标命中时，点一个会产生可见反馈的元素（图标/按钮），而不是空壁纸。

### K. 点击后立刻打字会丢键（实测踩坑）
点击会打开**带动画的控件**（开始菜单/搜索面板/下拉）时，焦点在动画期间未就绪，紧跟的 `type` 会整段丢失。
正确做法：点击后用稳定等待并截图确认焦点/光标已在输入框再打字；丢键的典型症状是
面板打开了但框里是空的。

### L. 双击/启动类动作的首帧往往太早（实测踩坑）
`double-click` 后 80ms 的 `--wait-change` 截图可能只拍到“图标选中态”，窗口还在启动。
判断是否打开要**再等 2~3s 补一张**，或直接用 `--wait-timeout 10000` 后再补观察，不要据此重发双击
（重发会把已打开的窗口又关掉/再开）。
