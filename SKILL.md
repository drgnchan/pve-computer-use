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
5. **Verify**: 任何改变画面的动作之后，都必须重新截图并 `read` 验证。

```
   pve-cu observe → read <filePath> → 视觉分析与规划 → pve-cu click/type/key → 重复
```

先确认 target：`pve-cu targets`。每个 target 固定绑定一台 VM（endpoint + node + vmid），不要试图"切换当前虚拟机"。

## CLI Reference

### 1. Status

```bash
pve-cu --target windows-vm status
```

返回 `connected`、`width`/`height`、`framebufferUpdates`、`authMethod`、`vmName`、`notes`、`pageErrors`。
`connected: false` 或存在 `failure` 时先排错，不要盲目发送输入。

### 2. Capture Screen Frame

```bash
pve-cu --target windows-vm observe
```

输出：

```json
{
  "frameId": "frame_2026-09-06_19-43-12-000_a1b2c3",
  "filePath": "/home/user/.cache/pve-cu/windows-vm/frames/frame_....png",
  "width": 1920,
  "height": 1080,
  "capturedAt": "2026-09-06T19:43:12.000Z",
  "framebufferUpdates": 42,
  "lastUpdateAt": "2026-09-06T19:43:11.880Z"
}
```

**紧接着必须用 `read` 工具打开 `filePath` 看图**，不要凭想象描述界面。

### 3. Mouse Actions

坐标支持归一化 `0.0~1.0`（左上 `0.0,0.0`，中心 `0.5,0.5`，右下 `1.0,1.0`），
也支持当前 framebuffer 像素，或 `--space` 自定义坐标空间。

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

### 5. Emergency Reset / Reconnect

```bash
pve-cu --target windows-vm reset        # 释放所有按键与鼠标按钮，防止卡键
pve-cu --target windows-vm reconnect    # 票据过期或连接中断后重连
pve-cu --target windows-vm daemon stop
```

## Safety and Operational Rules

1. **总是读取最新截图**：不要基于上一步的预期猜测界面。
2. **一次一个动作**：执行一个有意义的动作（或向已聚焦输入框连续输入），然后立刻观察。
3. **敏感操作必须先确认**：重启/关机/进入 BIOS、删除文件、修改网络与防火墙、输入密码或提交支付。
   暂停并向用户确认后再执行。
4. **卡键恢复**：动作没有预期效果时先 `reset`，再 `observe` 评估。
5. **不要与人抢控制台**：用户自己开着 PVE 网页控制台时，先请对方关闭该标签页，避免输入互相干扰。
6. **不要在命令行里出现任何密钥**：Token/密码只能来自环境变量与配置文件；日志与截图目录权限为 `0700/0600`。

## Operational Gotchas

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

### E. 登录界面密码框不回显
向 Windows 登录界面注入密码后，截图里密码框可能仍是空的。
不要据此判断失败：等几秒后看画面是否进入桌面（成功）或出现"密码错误"（失败）。

### F. 票据与连接会过期
PVE 的 vnc ticket 是短期的，控制台空闲也可能断开。出现 `Console dropped ...` / `failure` 时执行 `reconnect`，
仍失败再检查 `status.authMethod`、权限（需要 `VM.Console`）与 VM 是否 running。

### G. TLS 指纹必须固定
PVE 使用自签证书。首次使用前运行 `pve-cu --target <t> fingerprint` 并把摘要写入配置，
否则 Daemon 会拒绝连接（除非显式设置 `insecureTls`，不建议）。
