# pve-cu — PVE Computer Use

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Test](https://github.com/drgnchan/pve-computer-use/actions/workflows/test.yml/badge.svg)](https://github.com/drgnchan/pve-computer-use/actions/workflows/test.yml)

[English](README.md) | 中文

通过 Proxmox VE 的 VNC 控制台操作虚拟机：命令行截图，并注入鼠标与键盘输入。

**目标机内不需要安装任何 Agent。** `pve-cu` 直接操作 PVE 已经暴露的虚拟显示器和虚拟输入设备，
因此 BIOS、系统安装界面、登录界面都能操作，与桌面无异。

它专为 AI Agent 的 *截图 → 规划 → 动作 → 验证* 闭环设计，但 CLI 本身也可以独立使用。

> 可选的 AI Agent 集成（Pi）：[docs/pi-integration.md](docs/pi-integration.md)

---

## 特性

- **无需 Guest Agent。** 工作在内核之下：BIOS/UEFI、安装器、启动菜单、登录界面。
- **截图 + 输入。** 绝对坐标移动、左/中/右键点击、双击、拖拽、滚轮、文本与组合键。
- **Windows 兼容性好。** 按键以 QEMU 扩展键事件发送，带 DOM `code`（scancode），并有普通 keysym 回退。
- **每个 target 一个 Daemon。** 一台 VM 一个 Unix Socket，动作串行队列，截图以 `0600` 落盘。
- **凭据只存在于 Daemon。** PVE 密码/API Token、控制台票据与 TLS 校验都不会到达浏览器；
  浏览器只拿到 loopback 地址和一次性 RFB 密码。
- **真正的 TLS 固定。** 用 leaf 证书 SHA-256 固定 PVE 私有集群 CA，**在写出任何请求字节之前**校验。
- **感知重绘的等待。** 用 `--wait-change` / `--wait-stable` 代替盲等。
- **秘密安全输入。** `type --from-file` / `--stdin` 让密码不出现在 `argv` 和进程列表里。
- **可选的单次调用工具。** `extensions/pve-console.ts` 在一次工具调用里返回一个动作及其截图。

## 环境要求

- **Node.js >= 20**
- **Chrome/Chromium**（默认 `/usr/bin/google-chrome`，可通过 `executablePath` / `PVE_CU_CHROME` 指定）
- **Proxmox VE**，HTTPS 8006 端口可达；需要一个具备 `VM.Console`（开控制台）和
  `VM.Audit`（读 VM 状态）权限的用户或 API Token。

`playwright-core` 仅作为库使用，不会下载浏览器。

---

## 快速开始

```bash
git clone https://github.com/drgnchan/pve-computer-use.git
cd pve-computer-use
npm install
npm run build                                  # 生成 web/dist/console.bundle.js
ln -s "$PWD/bin/pve-cu.js" ~/.local/bin/pve-cu # 或者：npm link

cp config.example.json ~/.config/pve-cu/config.json
# 编辑 ~/.config/pve-cu/config.json，填入你的 PVE 主机与虚拟机
```

然后跑安装自检——它会检查配置、构建产物、Chromium、TLS 固定与 API 端点，
**全程不发送任何凭据**：

```bash
pve-cu --target <name> fingerprint   # 打印 PVE 证书摘要，用于固定
pve-cu --target <name> doctor        # config / bundle / chromium / tls / api / credentials / daemon
pve-cu --target <name> observe       # 第一张截图
```

`doctor --auth` 会额外登录并读取 VM 状态，`doctor --console` 会额外打开真实控制台并截一帧。

---

## 架构

```text
 ┌──────────────────────────────────────────────────────────────┐
 │                     Agent / CLI / Script                     │
 │      看图理解 → 规划动作 → 调用 CLI → 再截图验证              │
 └───────────────┬──────────────────────────▲───────────────────┘
     执行动作    │                          │ read 查看 PNG/JPEG
                 ▼                          │
 ┌──────────────────────────────────────────────────────────────┐
 │                   pve-cu CLI / Daemon                        │
 │  每个 target 一个 Daemon：Unix Socket、动作串行队列、截图落盘  │
 │  ┌────────────────┐   ┌───────────────────────────────────┐  │
 │  │ PVE REST API   │   │ 无头 Chromium + noVNC (RFB)       │  │
 │  │ 认证/控制台票据 │   │ 画面解码、鼠标键盘注入            │  │
 │  └───────┬────────┘   └───────────────┬───────────────────┘  │
 │          │        loopback bridge     │                      │
 │          └────────── ws://127.0.0.1 ──┘                      │
 └────────────────────────────┬─────────────────────────────────┘
                              │ wss://pve:8006 (票据 + Cookie/Token)
                              ▼
                    PVE → 目标虚拟机控制台
```

1. Daemon 用 PVE API 认证，通过 `POST .../qemu/{vmid}/vncproxy?websocket=1`
   申请一次性控制台票据与 RFB 密码。
2. Daemon 在 `127.0.0.1` 随机端口起一个 bridge：既托管 noVNC 页面，
   也把浏览器的 WebSocket 透明转发到 PVE。
   **PVE 凭据、票据与 TLS 校验只存在于 Daemon 进程**；浏览器只拿到 bridge 地址和 8 字符 RFB 密码。
3. 无头 Chromium 加载 noVNC（`@novnc/novnc` 1.7.0，ESM）建立 RFB 会话，维护 framebuffer。
4. 截图取 noVNC 的完整 framebuffer（`RFB.toDataURL`），落盘为 PNG/JPEG。
5. 鼠标走 noVNC 的 pointer event（绝对坐标），键盘走 `RFB.sendKey(keysym, code, down)`；
   QEMU 支持 extended key event，因此每个键都带 DOM `code`（scancode），Windows 兼容性更好。

---

## 配置

配置文件：`~/.config/pve-cu/config.json`（或 `$PVE_CU_CONFIG`），参考
[`config.example.json`](config.example.json)。

```json
{
  "executablePath": "/usr/bin/google-chrome",
  "targets": {
    "windows-vm": {
      "endpoint": "https://192.0.2.10:8006",
      "node": "pve-node",
      "vmid": 105,
      "auth": { "tokenId": "pve-cu@pve!console", "tokenSecretEnv": "PVE_CU_TOKEN_WINDOWS_VM" },
      "tlsFingerprint": "<64 位十六进制 SHA-256>",
      "imageFormat": "png",
      "frameKeep": 20
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `endpoint` | PVE Web/API 源，必须是 `https://host:8006` 形式 |
| `node` / `vmid` | 目标节点与虚拟机 ID |
| `auth.tokenId` + `tokenSecretEnv` | **推荐**：API Token，密钥只放在环境变量里 |
| `auth.username` + `passwordEnv` | 用户密码登录（这种方式不支持 MFA） |
| `tlsFingerprint` | PVE leaf 证书 SHA-256，用 `fingerprint` 获取（推荐） |
| `caFile` | 备选：CA PEM（如 `/etc/pve/pve-root-ca.pem`），走完整链校验 |
| `insecureTls` | 显式关闭校验，Daemon 启动时打印警告 |
| `imageFormat` / `jpegQuality` | `png`（默认，文字清晰）或 `jpeg` |
| `cacheDir` / `socketPath` / `frameKeep` | 运行目录、Socket 路径、保留截图数 |
| `executablePath` | Chrome/Chromium 路径（回退到 `$PVE_CU_CHROME`） |
| `idleTimeoutMs` | 空闲多久后释放控制台会话（票据 + 无头浏览器），默认 `600000`；`0` 表示不释放 |
| `idleCheckIntervalMs` | 空闲检查间隔，默认 `idleTimeoutMs/10`（限制在 5~60s） |

### PVE 侧准备（最小权限）

创建一个专用用户和 API Token，只授予控制台所需权限。在 PVE 主机上执行：

```bash
# 1. 专用用户，本身不给任何 ACL
pveum user add pve-cu@pve --comment "pve-cu computer use"

# 2. 创建带权限隔离的 API Token（privsep=1，默认值）
pveum user token add pve-cu@pve console
#   full-tokenid  pve-cu@pve!console
#   value         xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   （只显示这一次）

# 3. 只把 VM.Console + VM.Audit 授予该 Token，且只作用于目标 VM
pveum acl modify /vms/105 --tokens 'pve-cu@pve!console' --roles PVEVMUser

# 4. 可选：确认生效权限
pveum user token permissions pve-cu@pve 'pve-cu@pve!console'
```

> `PVEVMUser` 包含 `VM.Console` 与 `VM.Audit`。**不要**授予 `Sys.*`、
> `VM.Config.*`、`VM.Allocate` 等权限。

如果你更希望 Token 继承用户的 ACL，可以改用 `--privsep 0` 并把角色授予用户：

```bash
pveum user token add pve-cu@pve console --privsep 0
pveum acl modify /vms/105 --users pve-cu@pve --roles PVEVMUser
```

然后导出密钥（写进 `~/.bashrc` 或 systemd 环境文件，**不要写进配置文件**）：

```bash
export PVE_CU_TOKEN_WINDOWS_VM='<token secret>'
pve-cu --target windows-vm doctor --auth   # 验证登录、权限、节点名、VM 状态
```

### TLS 信任

PVE 用自己的集群 CA（`pve-root-ca`）签发证书，且**握手时不下发该 CA**，
所以系统信任库会直接拒绝。两种受支持的方式：

```bash
# 方式一（推荐，无需登录 PVE）：固定 leaf 证书指纹
pve-cu --target windows-vm fingerprint
# 把输出的 fingerprint 填进 config.json 的 tlsFingerprint
pve-cu --target windows-vm tlscheck      # 不发送任何凭据，验证可达性 + 证书固定

# 方式二：拿到 PVE 根 CA 后走完整链校验
scp root@192.0.2.10:/etc/pve/pve-root-ca.pem ~/.config/pve-cu/pve-ca.pem
# config.json 里改为 "caFile": "/home/user/.config/pve-cu/pve-ca.pem"
```

指纹固定由自定义 `https.Agent` 实现：握手后校验 leaf 摘要**与请求地址（SAN）**，
通过前所有写入被拦截，不通过就销毁 socket。

> Node 在 `rejectUnauthorized:false` 时**不会**调用 `checkServerIdentity`，
> 所以"关掉校验 + 自定义 checkServerIdentity"的写法是假固定；本项目不使用该做法。

两个安全性质已写入测试：指纹不符时 **HTTPS 请求不会到达对端**，
**bridge 的 `wss://` 上游也不会建连**（即 `vncticket`、Cookie 和 RFB 密码不可能泄露给冒充者）。

---

## 命令

```bash
pve-cu --target windows-vm status                    # 会话健康、分辨率、票据链路
pve-cu --target windows-vm observe                   # 截图，输出 filePath / width / height
pve-cu --target windows-vm observe --wait-change     # 等客户机重画后再截图（代替盲等 sleep）
pve-cu --target windows-vm observe --wait-change --wait-timeout 20000
pve-cu --target windows-vm click --x 0.5 --y 0.5
pve-cu --target windows-vm click --x 0.8 --y 0.2 --button right
pve-cu --target windows-vm double-click --x 0.25 --y 0.35
pve-cu --target windows-vm move --x 0.5 --y 0.5
pve-cu --target windows-vm drag --from-x 0.2 --from-y 0.3 --to-x 0.7 --to-y 0.3
pve-cu --target windows-vm scroll --x 0.5 --y 0.5 --dy 4      # dy>0 向下，dy<0 向上
pve-cu --target windows-vm type --text "https://example.com"
pve-cu --target windows-vm key --keys "ctrl,l"
pve-cu --target windows-vm key --keys "alt,f4"
pve-cu --target windows-vm reset                     # 释放所有卡住的按键与鼠标
pve-cu --target windows-vm reconnect                 # 重新申请票据并重连
pve-cu --target windows-vm daemon stop
pve-cu targets
pve-cu --target windows-vm fingerprint   # 证书指纹（用于固定）
pve-cu --target windows-vm tlscheck      # 可达性 + 证书固定校验，不发送凭据
pve-cu --target windows-vm doctor        # 安装自检清单（不发凭据）
pve-cu --target windows-vm doctor --auth     # 额外登录并读 VM 状态
pve-cu --target windows-vm doctor --console  # 额外开真实控制台并截一帧
```

**坐标**：`0.0~1.0` 归一化、当前 framebuffer 像素，或 `--x 500 --y 500 --space 1000`
自定义坐标空间。`--target` 也可以用环境变量 `$PVE_CU_TARGET` 提供。

**参数解析**：`--key value`、`--key=value`、`-t value` 均可。负数会被当成值
（`--dy -2` 向上滚）；但以 `-` 开头的**文本**必须用 `=` 形式，例如
`pve-cu --target x type --text=-verbose`。

**秘密绝不能出现在 `argv` 里。** 用文件或 stdin：

```bash
pve-cu --target windows-vm type --from-file "$HOME/.config/pve-cu/windows-vm-password"
cat secret.txt | pve-cu --target windows-vm type --stdin
```

### 等待客户机重绘

- `--wait-change` 的基线是**上一个输入动作完成时的 framebuffer 计数**，
  所以点击引发的重画会立刻返回。超时不是错误（静止画面本来不推送更新），
  此时 `changed: false`，截图仍然有效。
- `--wait-stable` 等待一个有界的无重绘窗口（默认至少观察 `--min-wait 1500`ms、
  连续 `--stable-ms 800`ms 无重绘、最多 `--wait-timeout 5000`ms）。
  这只是重绘静止启发式，**不等于窗口已聚焦或就绪**；闪烁光标可能让它无法收敛。
  此时仍返回最终截图，并标注 `stable:false` / `timedOut:true`。
- 输入动作支持 `--observe`，在同一个 daemon 队列任务里完成动作及截图，
  返回 `frame` 与 `timings.actionMs/observationMs/totalMs`。
  截图失败会保留动作结果并附加 `observationError`——**不得因截图失败重发输入**。

`observe` 输出：

```json
{
  "frameId": "frame_2026-09-06_19-43-12-000_a1b2c3",
  "filePath": "/home/user/.cache/pve-cu/windows-vm/frames/frame_....png",
  "width": 1920, "height": 1080,
  "capturedAt": "2026-09-06T19:43:12.000Z",
  "framebufferUpdates": 42, "lastUpdateAt": "...",
  "changed": true, "waitedMs": 320
}
```

---

## 测试与开发

```bash
npm test             # 单元 + 离线 RFB 端到端 + mock PVE 全链路
npm run check        # src/ 与 scripts/ 的语法检查
npm run build        # 重新生成 web/dist/console.bundle.js
npm run smoke        # 无头 Chrome + bundle + 适配器接线检查（不需要 PVE）
npm run debug:rfb    # 单次连接 fake VNC server，打印握手/输入事件
npm run mock-console # 启动 mock PVE 并截一张四象限图，人工核对像素通道顺序
```

依赖缺失时（无浏览器或 `openssl`），相关用例会**自动跳过**，因此在最小环境里
`npm test` 也能安全运行。CI 使用 GitHub 的 `ubuntu-latest`，自带 Google Chrome 与 `openssl`。

真实 PVE 主机的验证记录见 [docs/validation.md](docs/validation.md)。

---

## 已知限制

- **首次截图较慢。** 第一次 `status`/`observe` 要完成认证、票据交换、启动无头浏览器
  并等待第一个 framebuffer update，这类命令超时为 120s。不要并发重试。
- **只能输入 ASCII。** 中文等非 ASCII 文本无法直接注入；需要在客户机输入法里打拼音
  再选候选词，每一步都靠截图确认。
- **同一时间只能有一个控制台。** Agent 操作时不要同时打开 PVE 网页控制台，
  否则输入会互相干扰。
- **锁定 `@novnc/novnc` 1.7.0。** 适配器使用了内部方法
  （`_handleMouseButton` / `_sendMouse` / `_framebufferUpdate` / `_display.flush`）；
  升级前必须重跑 `npm test`，离线 RFB 端到端用例会立刻发现协议或内部 API 变化。
- **分辨率变化会让像素坐标失效。** 客户机切换分辨率时 Daemon 会重设浏览器视口；
  优先使用归一化坐标，并重新截图。
- **空闲释放。** 超过 `idleTimeoutMs` 没有动作，Daemon 会先释放所有按键再关闭会话
  （票据 + 浏览器），避免长期占用控制台。下一条命令会自动重连，
  因此**久未操作后的第一条命令会慢几秒**，这是正常现象。
- **Chromium 沙箱。** 若内核缺少 user namespace，Daemon 会退回 `--no-sandbox`，
  并在 `status.notes` 中记录。

---

## 安全

- PVE 凭据、控制台票据与 TLS 校验都限制在 Daemon 进程内。浏览器里的适配器页面
  只拿到 loopback 地址和一次性 RFB 密码。
- Daemon Socket 以 `0600` 创建；运行目录与截图使用 `0700`/`0600`。
- TLS 固定在写出任何请求字节之前校验 leaf 摘要与 SAN；不匹配时直接销毁 socket，
  不会降级。
- 密码与 Token 只应通过环境变量或 `type --from-file` / `--stdin` 传递，
  绝不要作为 CLI 参数。

漏洞报告流程见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE) © 2026 drgnchan
