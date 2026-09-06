# PVE Computer Use (`pve-cu`)

用「截图 + 鼠标键盘」的方式控制 Proxmox VE 上的虚拟机控制台，命令风格与 `onekvm-cu` 一致，可直接作为 Pi Skill 使用。

不需要在虚拟机内安装任何 Agent：控制的是 PVE 提供的虚拟显示器与虚拟输入设备，因此 BIOS、系统安装界面、登录界面都能操作。

---

## 架构

```text
 ┌──────────────────────────────────────────────────────────────┐
 │                          Pi Agent                            │
 │      看图理解 → 规划动作 → 调用 CLI → 再截图验证              │
 └───────────────┬──────────────────────────▲───────────────────┘
      执行动作   │                          │ read 查看图片附件
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

1. Daemon 用 PVE API 认证，`POST .../qemu/{vmid}/vncproxy?websocket=1` 申请一次性控制台票据与 RFB 密码。
2. Daemon 在 `127.0.0.1` 随机端口起一个 bridge：既托管 noVNC 页面，也把浏览器的 WebSocket 透明转发到 PVE。
   **PVE 凭据、票据与 TLS 校验只存在于 Daemon 进程**；浏览器只拿到 bridge 地址和 8 字符 RFB 密码。
3. 无头 Chromium 加载 noVNC（`@novnc/novnc` 1.7.0，ESM）建立 RFB 会话，维护 framebuffer。
4. 截图取 noVNC 的完整 framebuffer（`RFB.toDataURL`），落盘为 PNG/JPEG，Agent 用 `read` 看图。
5. 鼠标走 noVNC 的 pointer event（绝对坐标），键盘走 `RFB.sendKey(keysym, code, down)`；
   QEMU 支持 extended key event，因此每个键都带 DOM `code`，Windows 客户机兼容性更好。

---

## 安装

```bash
cd ~/pve-computer-use
npm install
npm run build          # 生成 web/dist/console.bundle.js
ln -s "$PWD/bin/pve-cu.js" ~/.local/bin/pve-cu
npm test               # 23 个用例：单元 + 离线 RFB 端到端 + mock PVE 全链路
npm run smoke          # 无头 Chrome + bundle + 适配器接线检查（不需要 PVE）
npm run debug:rfb      # 单次连接 fake VNC server，打印握手/输入事件，排查用
```

依赖：Node 20+、系统 Chrome/Chromium（默认 `/usr/bin/google-chrome`）。`playwright-core` 不下载浏览器。

> noVNC 必须用 **1.7.x**：npm 上的 1.6.0 只发布 Babel 转译的 CJS（`lib/`），
> 其 `util/browser.js` 含 top-level await，被 esbuild 打成 ESM 后会报 `exports is not defined`。

---

## 配置

配置文件：`~/.config/pve-cu/config.json`（或 `PVE_CU_CONFIG`），参考 `config.example.json`。

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
| `endpoint` | PVE Web/API 源，必须 `https://host:8006` 形式 |
| `node` / `vmid` | 目标节点与虚拟机 ID |
| `auth.tokenId` + `tokenSecretEnv` | **推荐**：API Token，密钥只放在环境变量里 |
| `auth.username` + `passwordEnv` | 用户密码（不支持 MFA 登录） |
| `tlsFingerprint` | PVE 证书 SHA-256，用 `fingerprint` 命令获取（推荐，见下） |
| `caFile` | 或指定 CA PEM（如 `/etc/pve/pve-root-ca.pem`），走完整链校验 |
| `insecureTls` | 显式关闭校验，Daemon 启动时打印警告 |
| `imageFormat` / `jpegQuality` | `png`（默认，文字清晰）或 `jpeg` |
| `cacheDir` / `socketPath` / `frameKeep` | 运行目录、Socket 路径、保留截图数 |

**PVE 侧准备**（专用账号，最小权限）：

```bash
pveum user add pve-cu@pve --comment "computer use"
pveum acl modify /vms/105 --users pve-cu@pve --roles PVEVMUser   # 含 VM.Console
pveum user token add pve-cu@pve console --privsep 0
```

然后导出密钥（写进 `~/.bashrc` 或 systemd 环境，不要写进配置文件）：

```bash
export PVE_CU_TOKEN_WINDOWS_VM='<token secret>'
```

### TLS 信任

PVE 用自己的集群 CA（`pve-root-ca`）签发证书，且**握手时不下发该 CA**，所以系统信任库会直接拒绝。
两种受支持的方式：

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
> 所以“关掉校验 + 自定义 checkServerIdentity”的写法是假固定；不要用。

两个安全断言已写入测试：指纹不符时 **HTTPS 请求不会到达对端**，
**bridge 的 `wss://` 上游也不会建连**（即 `vncticket`、Cookie 和 RFB 密码不可能泄露给冒充者）。

---

## 命令

```bash
pve-cu --target windows-vm status                    # 会话健康、分辨率、票据链路
pve-cu --target windows-vm observe                   # 截图，输出 filePath / width / height
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
```

坐标：`0.0~1.0` 归一化、当前 framebuffer 像素，或 `--x 500 --y 500 --space 1000` 自定义坐标空间。
`--target` 也可以用环境变量 `PVE_CU_TARGET` 提供。

参数解析：`--key value`、`--key=value`、`-t value` 均可。负数会被当成值（`--dy -2` 向上滚）；
但以 `-` 开头的**文本**必须用 `=` 形式，例如 `pve-cu --target x type --text=-verbose`。

`observe` 输出：

```json
{
  "frameId": "frame_2026-09-06_19-43-12-000_a1b2c3",
  "filePath": "/home/user/.cache/pve-cu/windows-vm/frames/frame_....png",
  "width": 1920, "height": 1080,
  "capturedAt": "2026-09-06T19:43:12.000Z",
  "framebufferUpdates": 42, "lastUpdateAt": "..."
}
```

---

## 与 `onekvm-cu` 的关系

| | onekvm-cu | pve-cu |
|---|---|---|
| 视频来源 | One-KVM HDMI 采集 (MJPEG) | PVE VNC/RFB framebuffer |
| 输入通道 | USB HID Gadget | QEMU 虚拟键鼠（RFB 事件） |
| 目标数量 | 单台物理机 | 每台 VM 一个 target/Daemon |
| 中文输入 | 需目标机输入法 + 拼音 | 同样限制（RFB 只发按键） |
| CLI 语义 | `observe/click/type/key/reset` | 完全一致 |

两者的 Skill 操作闭环相同：**观察 → read 看图 → 单一动作 → 再观察验证**。

---

## 与 SecureLink TOTP MCP 的衔接

`~/tools/securelink-auth-mcp` 的 `securelink_enter_totp` 可以把验证码直接送进
某台固定的 PVE 虚拟机控制台（种子仍只在本地 Keyring，验证码不出现在工具参数与返回值里）：

```bash
# MCP server 的环境（Pi MCP Adapter 配置里设置）
SECURELINK_TOTP_BACKEND=pve
SECURELINK_TOTP_PVE_TARGET=windows-vm
```

安全约束：

- 工具**无参数**，目标机器由环境固定，模型无法临时改投别的 VM。
- 发送前先向该 target 的 Daemon 要 `status`，必须同时满足
  `target`/`node`/`vmid` 与配置一致且 `connected: true`，否则拒绝输入。
- Daemon 必须已在运行（`pve-cu --target <name> status`）；MCP 不会自己拉起它。
- 返回值里带 `channel`（backend/target/node/vmid），便于核对验证码去了哪台机器。
- 不设 `SECURELINK_TOTP_BACKEND` 时行为完全不变，仍走 One-KVM 硬件。

调用前仍必须由 Agent 看图确认 MFA 输入框已聚焦；返回 `entered: true` 只代表输入完成，
是否登录成功要再截图判断。

---

## 已知限制

- **首次截图**需等待 RFB 握手和第一个 framebuffer update，`status`/`observe` 超时设为 120s。
- **只能输入 ASCII**；中文需在客户机内用输入法（`type` 打拼音 + 数字/空格选词，靠截图确认候选）。
- **同一控制台并发操作会互相干扰**：Agent 操作时不要同时打开 PVE 网页控制台。
- noVNC 适配器使用了 `_handleMouseButton` / `_sendMouse` / `_framebufferUpdate` / `_display.flush` 等内部方法，
  已锁定 `@novnc/novnc` 1.7.0，升级前必须重跑 `npm test`（离线 RFB 端到端用例会立刻发现协议/内部 API 变化）。
- 客户机分辨率变化时 Daemon 会重设浏览器视口；极端情况下建议手动 `observe` 一次再继续。
- 若 Chromium 因内核缺少 user namespace 而无法启用沙箱，Daemon 会退回 `--no-sandbox` 并在 `status.notes` 中说明。

---

## 当前状态

**已对真实 PVE 验证**（`192.0.2.10:8006`，仅 TLS + 无认证端点，未发送凭据、未触碰任何 VM）：

- `fingerprint`：拿到 leaf 摘要 `<sha256-fingerprint>`，CN `pve-node.lan`，
  签发者 `Proxmox Virtual Environment`，SAN 包含 `IP Address:192.0.2.10`，有效期至 2028-06
- 握手**只下发 leaf**（链长 1），因此无法从握手引导出 CA
- `tlscheck`：指纹固定生效，`/access/domains` 返回 `pam`/`pve`，往返 41ms

**已离线验证**（`npm test`，23 个用例全绿）：

- **mock PVE 全链路**（真 `bin/pve-cu.js` → 真 Daemon → 真 PveApi/Bridge/Chromium → 假 PVE REST+WebSocket）：
  API Token 与用户密码两种认证、`vncproxy(websocket=1)` 参数、CSRF 头、
  **WebSocket 升级必须带 API 认证**、截图落盘为 PNG、click/right/scroll/drag/key/type/reset、
  401 与坐标越界拒绝、`daemon stop` 清理 socket、VM 停止时不开控制台
- 配置校验、坐标换算（归一化/像素/自定义 space）、按键与组合键 keysym+DOM code 规划、CLI 参数解析
- loopback bridge：页面托管、token 校验、`binary` 子协议、Cookie/Authorization 头透传、双向字节转发
- Daemon：动作串行派发、截图落盘（0600）与按数量裁剪、非法输入在触达控制台前被拒绝
- TLS 固定：正确指纹放行、**连续多次请求仍放行**（TLS 会话复用会隐藏证书，已禁用 session 缓存）、
  错误指纹拒绝且**请求不会发出**、地址（SAN）不符拒绝、`caFile` 完整链校验、
  bridge 的 `wss://` 上游同样受固定保护
- **RFB 端到端**（自建 fake VNC server 承载于 WebSocket，模拟 PVE 的 vncwebsocket）：
  3.008 握手、VNC 认证（type 2，确认密码真的参与了 challenge 响应）、ServerInit/分辨率、
  Raw framebuffer → PNG 截图、PointerEvent 绝对坐标与左右键/滚轮位、
  QEMU Extended Key Event（scancode 0x1d/0x26/0xc8 等）与普通 KeyEvent 回退路径、认证失败可见

**尚缺的一步：真实控制台联调**（需要 API Token 与运行中的 VM）。首次联调建议顺序：

```bash
pve-cu --target windows-vm tlscheck      # 已通过：pinned-fingerprint, realms pam/pve
pve-cu --target windows-vm status        # 认证 + 票据 + RFB 连接
pve-cu --target windows-vm observe       # 看第一张截图
pve-cu --target windows-vm click --x 0.5 --y 0.5
pve-cu --target windows-vm observe       # 确认鼠标绝对定位正确
```

调试日志：`~/.cache/pve-cu/<target>/daemon.log`；`PVE_CU_DEBUG=1` 输出完整堆栈。
