# dsh-wrainrock-daemon — DeepSeek Harness 的开机自启与看护插件

一个 Harness 插件（Host 半边 + Client 半边），用 systemd 用户服务实现三件事：

| 需求 | 实现 |
| --- | --- |
| 1. systemd 开机自启动 | `dsh-wrainrock-daemon.service`（用户级 unit，无需 root）+ `loginctl enable-linger` 使其在开机（而非登录）时启动 |
| 2. 崩溃 / 损坏自恢复，多次失败进安全模式并汇报 | 看护脚本 `supervisor.sh`：启动前校验配置（损坏则从最近一次正常快照恢复）→ 运行 `dsh` → 统计滚动窗口内的快速失败次数 → 达阈值切换干净的安全 profile `dsh-safe`，写事故报告并弹桌面通知；systemd 的 `OnFailure=` 作为第二道防线。另有两道**环境守卫**：profile+端口级看护锁（同一个 unit 被两个 systemd 用户管理器各拉起一次时，第二个待命而不是再抢端口）、以及「端口已被同类实例占用」识别（记 `peer-port` 报告并等待，**绝不**升级安全模式）；安全模式另用独立端口启动，保证它一定起得来 |
| 3. 手动“重启”按钮 | Client 半边在输入框下方的 composer dock 中渲染 **重启** 按钮（点两次确认），调用 Host 的 HTTP 接口完成重启 |

## 项目改名

本项目改过两次名：`dsh-autostart` → `dsh-ian-daemon` → 现定名 **dsh-wrainrock-daemon**。除名称外行为不变，但**已安装的机器会自动迁移**（两代旧名都认）：

| 项目 | 旧 | 新 |
| --- | --- | --- |
| 包名 / 插件行 | `@local/dsh-autostart`、`@local/dsh-ian-daemon` | `@local/dsh-wrainrock-daemon` |
| 主 / 安全模式 / 自测单元 | `dsh-harness.service` 等、`dsh-ian-daemon.service` 等 | `dsh-wrainrock-daemon.service` / `-safemode` / `-selftest` |
| 数据目录 | `~/.dsh/autostart`、`~/.dsh/ian-daemon` | `~/.dsh/wrainrock-daemon` |
| 接口前缀 / 请求头 | `/dsh-autostart`、`/dsh-ian-daemon` | `/dsh-wrainrock-daemon` / `x-dsh-wrainrock-daemon` |
| 环境变量前缀（测试钩子） | `DSH_AUTOSTART_*`、`DSH_IAN_DAEMON_*` | `DSH_WRAINROCK_DAEMON_*` |

迁移在插件激活时自动完成：先把**最新一代存在的那一个**旧数据目录搬进新目录（新目录已存在就完全不动），
再写新单元、`daemon-reload`、**停用并删除旧单元**、启用新单元，保证任何时刻只有一个单元处于 enabled。
旧名清单可用 `legacyUnitNames` / `legacyHomeDirs`（单数 `legacyHomeDir` 仍作为显式覆盖生效）改写；
`node tests/migration.mjs` 对两代旧名各跑一遍（数据搬没搬、旧单元删没删、只有新单元 enabled）。
只会动带本项目标记（`@local/dsh-wrainrock-daemon` / `@local/dsh-ian-daemon` / `@local/dsh-autostart`）的单元；
不认识的文件一律不碰。

## 使用

安装后插件会自动完成安装与启用（`installOnActivate`、`startAtBoot` 默认 `true`）。
它**不会**立刻启动服务——当前手动运行的实例仍占着端口；下次开机（或点“重启”）时由 systemd 接管。

> 交接注意：**不要**在手动实例还占着端口时直接 `systemctl --user start dsh-wrainrock-daemon.service`，
> 那会连续启动失败并升级为安全模式（安全模式是粘性的）。正确做法是点一次「重启」——
> 助手会等旧进程退出后再 `systemctl --user restart`，不会抢端口；或者先退出手动实例再 start。

- **重启按钮**：同时出现在两个位置，任一位置不可见都不影响另一个：
  - **侧边栏底部、设置（Settings）上方那一行**：↻ 图标 + `重启`（侧栏收起时只显示 36×36 图标按钮，悬停有提示）；
  - **输入框下方那一排状态条**中：一个小胶囊按钮 `重启`。
  第一次点击变为 `确认重启？`（6 秒内），第二次点击执行；重启中显示 `重启中…`，新进程起来后页面自动刷新。
  上次启动进入过安全模式时，按钮带橙色边框与提示点。
  按钮整体包在 `SafeBoundary` 里：即使花哨版本渲染崩溃，也会退化成不带样式的普通 `重启` 按钮，不会出现空白格。
  - 若当前进程由 systemd 托管 → `systemctl --user restart dsh-wrainrock-daemon.service`；
  - 若当前是手动运行 → 派发一个脱离终端的助手脚本，等旧进程退出后接管（已启用自启动则交给 systemd，否则原样重新拉起命令行）。

  页面在没有手动刷新的情况下通常会通过客户端 HMR 拿到新代码；若插件刚安装完仍看不到，`Ctrl+Shift+R` 硬刷新一次即可。

  重启流程本身跑在**模块级**而不是组件里：服务端一断，会话级 slot 会塌、组件会 unmount，
  组件清理绝不能把已经在飞的重启流程掐死。流程规则是「证明页面已经过期才刷新」——
  POST 抛错（服务端先死、响应丢失）不再放弃；服务端 pid 变了、或观测到「断开又回来」就刷新页面；
  一直没起来则给出提示让你手动刷新。每一步都会回执到 `/dsh-wrainrock-daemon/event`。
  刷新前会等 harness 自己报告**已就绪**（`appReady`）：在此之前页面真正需要的 `/api` 传输通道还没注册，
  过早刷新会刷进一个连不上后端的壳（这正是 2026-10-06「卡住」的原因）。
  整个交接刻意做薄：`POST /restart` 应答后 **250ms** 就执行（只为让 202 到达浏览器），
  重启期间轮询间隔 **500ms**，按钮上显示 `重启中… Ns` 让你看到进度而不是像卡死。
  本机实测（Bazzite 44 / systemd 259 / DSH 0.2.0-rc.2 / 34 个插件）：`preflight` 0.10s、
  systemd 停+起 <1s、插件挂载→`ready` ≈2.0s，即「点击→服务就绪」≈2.5s；其余是页面重载与 SPA 启动。
- **状态与日志接口**（仅本机可访问，写操作需带 `x-dsh-wrainrock-daemon: 1` 头）：

  ```
  GET  /dsh-wrainrock-daemon/url          # {ok,current,authenticated,entry,mode,port}：令牌链接与稳定入口
  GET  /dsh-wrainrock-daemon/enter        # 稳定入口：服务端完成 token→cookie 交换后 303 到 ./
  GET  /dsh-wrainrock-daemon/status       # systemd / 看护 / 事故 / 路径 全量状态
  GET  /dsh-wrainrock-daemon/log?lines=200&source=dsh
  GET  /dsh-wrainrock-daemon/port         # 端口快照（同 status.port：current/source/next/nextSafe/override/pending）
  POST /dsh-wrainrock-daemon/restart      # 同“重启”按钮
  POST /dsh-wrainrock-daemon/port?port=N[&safePort=N][&restart=1]   # 设定“下次启动端口”（restart=1 先回 202，约 250ms 后重启）
  POST /dsh-wrainrock-daemon/install      # 重写脚本与 unit、daemon-reload、enable
  POST /dsh-wrainrock-daemon/uninstall    # 反注册并删除 unit（报告保留）
  POST /dsh-wrainrock-daemon/repair       # 立刻做一次配置校验/恢复
  POST /dsh-wrainrock-daemon/reset?restart=1   # 清除安全模式（并可立即重启）
  POST /dsh-wrainrock-daemon/selftest     # 验证本会话能启停 systemd 用户 unit
  POST /dsh-wrainrock-daemon/event        # 页面回执（重启生命周期/UI 崩溃），写入 state/client-events.jsonl
  ```

  `/status` 里的 `ready` / `readyAt` 表示 harness 是否已完成启动审计，`clientHeartbeat` 是页面轮询心跳
  （最多 20 秒记一次，用来判断页面是否还活着，curl 不会污染它）。
  `/status` 里的 `health` 是自检结论：解析**生成的**脚本，报告其中烘焙的 node/dsh 路径是否仍然存在
  （`health.ok=false` 说明自启动"看起来装好了"但实际起不来）；`lastInstall` 是最近一次安装结果。
  `/status` 里的 `port` 对象是端口快照：`current` 是**正在监听**的端口，`source` 说明它从哪来
  （`live` = 运行实例上报 / `override` = `state/port.json` / `config` = 配置烘焙；只要实例上报了端口就是 `live`），
  `next` / `nextSafe` / `safePort` 是**下一次启动**会用的主端口与安全端口（`nextSafe` 与 `safePort` 同值，
  没写安全端口时默认取 `next + 1`），`override` 是**布尔**——表示存在 `state/port.json` 覆盖，
  哪怕它写的端口恰好就是当前端口；`requestedAt` / `requestedBy` 是那次写入的时间与来源（`cli` / `ui`）；
  `pending` 表示「下次启动端口 ≠ 当前端口」，也就是这份改动还没生效、要重启一次才应用。
  `POST /port` 和其余写操作一样要带 `x-dsh-wrainrock-daemon: 1` 头，并接受 `&by=cli`（`dwd` 自己会带）；
  端口非法时返回 400（`{ok:false,error:'invalid-port'|'invalid-safe-port',…}`）且不写文件，
  成功时回 `changed` 列出实际改动的字段；带 `restart=1` 时先回 202、约 250ms 后重启。

### 命令行：`dwd`

插件把命令行工具写到 `<homeDir>/bin/dwd`（默认 `~/.dsh/wrainrock-daemon/bin/dwd`），并在 `cliDir`
（默认 `$HOME/bin`，本机登录 shell 的 PATH 首位）里建 `dwd` 与 `dsh-wrainrock-daemon` 两个软链接：

```bash
dwd status                 # 当前端口、设置的下次启动端口与 daemon 状态
dwd rp 3081                # 把「下次启动端口」设为 3081（别名：dwd report 3081），随后自动重启使其立刻生效
dwd rp 3081 --no-restart   # 只改「下次启动端口」，现在不重启
dwd rp 3081 --safe-port 3099   # 顺带指定下次启动的安全模式端口
dwd restart                # 现在就重启（同面板「重启」按钮）
dwd url [--open]           # 打印/打开当前进程的带 token 链接（只用于当场调试；重启即作废）
dwd enter [--open]         # 打印/打开稳定入口 /dsh-wrainrock-daemon/enter
dwd help                   # 用法
```

`dwd rp <port>` 改的是**下一次启动**的端口，不带 `--no-restart` 时会紧接着重启一次让新端口马上生效
（等价于设置页的「保存并重启」）。`--no-restart` 则只落盘，下次开机/重启时才用新端口。
它优先调本机的 `POST /port`（因此端口来源记成 `cli`）；守护进程没在跑时自己把 `state/port.json`
原子写下来，再交给 systemd（或提示你手动重启）。`dwd status` 同理：进程没应答时退化为直接读
`state/runtime.json` / `state/port.json`，并把端口来源标成 `offline`。
若 `$HOME/bin` 不在 PATH 上（或想换地方），把 `cliDir` 指到一个已经在 PATH 里的目录，或者自己加进去：

```bash
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc   # bash 用 ~/.bashrc
```

## 生成的文件

```
~/.config/systemd/user/dsh-wrainrock-daemon.service            # 开机自启 + 看护（enabled）
~/.config/systemd/user/dsh-wrainrock-daemon-safemode.service   # OnFailure= 兜底，不随开机启用
~/.config/systemd/user/default.target.wants/dsh-wrainrock-daemon.service -> ../dsh-wrainrock-daemon.service
~/.dsh/wrainrock-daemon/bin/supervisor.sh                    # 看护脚本（由插件生成，勿手改）
~/.dsh/wrainrock-daemon/bin/relaunch.sh                      # 手动实例的接管助手
~/.dsh/wrainrock-daemon/bin/dwd                              # 命令行工具（cliDir 里的 dwd / dsh-wrainrock-daemon 软链接指向它）
~/.dsh/wrainrock-daemon/bin/mover.mjs                        # 旧端口上的搬家提示服务（只回 302，见「改了端口以后会怎样」）
~/.dsh/wrainrock-daemon/state/                               # mode / failures / last_exit / incident.json
~/.dsh/wrainrock-daemon/state/port.json                      # 「下次启动端口」唯一事实来源：{port, safePort, at, by}
~/.dsh/wrainrock-daemon/state/runtime.json                   # 当前运行实例：{pid, port, safePort, unit, profile, at}
~/.dsh/wrainrock-daemon/state/last-port.json                 # 上次激活时监听的端口：{port, at}
~/.dsh/wrainrock-daemon/state/movers.json                    # 留在旧端口上的搬家服务：{movers:[{from, pid, at}]}
~/.dsh/wrainrock-daemon/state/entry.json                     # key 模式的入口密钥：{key, at}（缺失/非法则入口拒绝 key 请求）
~/.dsh/wrainrock-daemon/state/supervisor-<profile>-<port>.lock   # 看护单例锁（flock，进程退出即释放）
~/.dsh/wrainrock-daemon/backup/                              # 最近一次能正常组合的 profile 配置快照
~/.dsh/wrainrock-daemon/reports/                             # 事故报告（incident-*.md、latest.md、broken-*/）
~/.dsh/wrainrock-daemon/logs/                                # supervisor.log、dsh.out.log、relaunch.log（重启助手）
```

开机后 GUI 地址（带 token）写在启动日志里：

```bash
systemctl --user status dsh-wrainrock-daemon.service
grep -o 'http://127.0.0.1:[0-9]*/?token=[^ ]*' ~/.dsh/wrainrock-daemon/logs/dsh.out.log | tail -1
```

不想翻日志就用 `dwd url`（当前令牌链接）或 `dwd enter`（稳定入口）——两者的区别见「登录与入口」一节。

## 端口状态（state/port.json / state/runtime.json）

「下一次启动监听哪个端口」以状态文件为准，不必改配置：

```
~/.dsh/wrainrock-daemon/state/port.json      # {port, safePort, at, by} —— 下次启动端口
~/.dsh/wrainrock-daemon/state/runtime.json   # {pid, port, safePort, unit, profile, at} —— 当前运行的实例
```

- `state/port.json` 是「下次启动端口」的**唯一事实来源**；文件不存在时用配置里的 `port`。它由
  `dwd rp`、`POST /port` 与设置页写入（原子替换），`at`/`by` 记录写入时间与来源（`cli` / `ui`）。
- `state/runtime.json` 描述**正在跑**的那一份：`{pid, port, safePort, unit, profile, at}`，
  其中 `port` 是当前端口、`safePort` 是本次算出的安全端口（同 `/status.port.nextSafe`）。
  它供 `dwd status`、设置页与 `/status.port.source=live` 读取。
- 看护脚本只用 `grep`/`sed` 读 `port.json`（**不依赖 jq**）；文件缺失、JSON 坏掉或端口越界时一律忽略，
  退回烘焙进脚本的配置端口——手改坏一份状态文件不会让服务起不来。
- 生成的看护脚本取端口的优先级是：**显式环境变量 `DSH_WRAINROCK_DAEMON_PORT` >
  `state/port.json` > 烘焙进脚本的配置端口**。也就是说 `dwd rp` 设过的值不会被重新生成的脚本覆盖，
  而临时 `DSH_WRAINROCK_DAEMON_PORT=… systemctl --user restart …` 又能压过两者（安全模式同理走 `safePort`）。
- 安全模式端口同样按这套优先级取 `safePort`；`state/port.json` 里没写安全端口时默认取「下次启动端口 + 1」。

## 登录与入口：为什么裸端口打不开

直接访问 `http://127.0.0.1:3080/` 会拿到 `401 dsh web authentication required; reopen the URL printed by dsh web.`
——这不是故障，而是 DSH 网页端**有意为之**的鉴权：GUI 只认「带 token 的地址」或「此前交换来的 cookie」。
理解这两步，才能理解为什么需要一个**稳定入口**。

机制分两步：

1. **每进程一个 launch token**：`dsh web` 每次启动都随机生成 32 字节、base64url 编码的 token，只印在启动日志里
   （`dsh web: http://127.0.0.1:<port>/?token=<token>`）。它**重启即换**，不落盘，所以没法长期收藏。
2. **一次 token → cookie 交换**：`GET /?token=<token>`（路径恰为 `/`、只带这一个 token 参数）会回 `303` 跳到 `./`，
   并 `Set-Cookie: dsh-auth-<base64url(sha256(host:port))>=v1…`；cookie 为 `HttpOnly` / `SameSite=Strict` / `Path=/`，
   默认 30 天（`cookieMaxAgeDays`）。签名密钥持久化在 credentials 记录 `client-connection/browser-session` 里，
   所以**重启不会失效**；但 **cookie 名绑定 authority**（`host:port`），**换端口即失效**，得重新走一次 token 交换。

本机实测（`127.0.0.1:3080`）：

| 请求 | 结果 |
| --- | --- |
| 裸 URL `GET /`（无 cookie、无 token） | `401 dsh web authentication required; reopen the URL printed by dsh web.` |
| `GET /?token=<正确 token>` | `303` → `./`，`Set-Cookie: dsh-auth-VPhEEcL…; Max-Age=2592000` |
| 带该 cookie `GET /` | `200` |
| `GET /?token=<错误 token>` | `401` |

**关键前提**：登录凭据绑在 `host:port` 上，而 token 每次重启都换 —— 所以「收藏带 token 的地址」和
「收藏裸端口」都留不住。本机实测过这一点：`logs/dsh.out.log` 里同一个端口 26117 前后出现过**两行不同的 token**，
其中旧的那一行不管端口对不对，一律回 `401 dsh web authentication required; reopen the URL printed by dsh web.`，
只有**当前这个进程**打印的那一行能换到 cookie（`303`）。也就是说：把带 token 的链接留在地址栏里刷新必然 401，
改端口、崩溃重拉、`systemctl` 重启都会让它当场作废。

所以**给人用的主链接是稳定入口，不是带 token 的链接**。daemon 提供 `GET /dsh-wrainrock-daemon/enter`：
由服务端自己完成上面那次 token 交换（**每次请求都向 DSH 现取一个新 token**、把 `Set-Cookie` 透传给浏览器）
再 `303` 到 `./`。浏览器地址栏里**不出现 token**，可以长期收藏；换端口时只改 URL 里的端口这一个数字
（或者干脆用下面「改了端口以后会怎样」里的搬家提示服务），cookie 由入口自动续上。带 token 的地址只当
**当场调试用**：它等价于日志里那一行，重启即失效，别存进书签。

另有 `GET /dsh-wrainrock-daemon/url` 回
`{ok:true, current, authenticated|null, authenticatedSource, entry, mode, port, gate}`：`current` 是干净的界面地址
（形如 `http://127.0.0.1:<port>/`），`entry` 是上面那个稳定入口，`authenticated` 是本进程可用的带 token 链接
（拿不到时为 `null`），`authenticatedSource` 说明它从哪来 —— `connection` 表示由 DSH 的 connection 服务直接给出
（可靠），`log` 表示是从 `logs/dsh.out.log` 里捞的、**可能已经过期**，`null` 表示没有；`gate` 是入口对**本次请求**
的判定（`ok` / `not-loopback` / `key-missing` / `key-invalid`）。

命令行两条路：

```bash
dwd url                    # 打印当前进程的带 token 链接（只用于当场调试；重启后作废）
dwd url --open             # 直接打开它
dwd enter                  # 打印稳定入口 http://127.0.0.1:3080/dsh-wrainrock-daemon/enter
dwd enter --open           # 直接打开稳定入口
```

入口的放行策略由配置 `enterMode` 决定（默认 `loopback`）：`loopback` 只服务直连回环、且不带
`x-forwarded-for` / `cf-connecting-ip` / `x-real-ip` / `forwarded` 任一转发头的请求；
`key` 模式额外要求 URL 查询参数 `k` 等于密钥（密钥来自 `state/entry.json`，入口 URL 形如 `…/enter?k=…`）；
`open` 模式不做来源限制（**只在已有别的访问控制时才用**，例如 Cloudflare Access）。
被拒绝时回 `403`。把它转发到公网域名的思路见下文「转发到域名（实验性）的思路」。

## 设置 → Daemon 页

面板的 **设置 → Daemon** 页把端口收在一处：

- **当前端口**：正在监听的端口（优先读 `GET /port`，进程没应答时退回 `state/runtime.json`），只读，
  并标明来源（实际运行中 / 来自下次启动覆盖 / 来自配置）；
- **下次启动端口**：填入要写的值，两个按钮——
  - `保存`：写 `state/port.json`，下次启动生效（等价 `dwd rp <port> --no-restart`）；
  - `保存并重启`：写完立刻重启，新端口马上生效（等价 `dwd rp <port>`）。
- **转发至 Cloudflare 域名** 一行：实验性占位，见下。

### 实验性功能

**「转发至 Cloudflare 域名」是实验性·开发中，目前只是一个占位行：不可点击，也不做任何事**——
不会建隧道、不改配置、不联网。它只是先把「把本机 GUI 暴露到某个 Cloudflare 域名」这个方向摆在设置页上，
等真正实现后才可用；现在请勿据此排查连通性问题。

### 转发到域名（实验性）的思路

方向是清楚的，实现时要顺着「登录与入口」那套机制走：

1. 用 cloudflared 隧道把本机端口暴露出去（`cloudflared tunnel --url http://127.0.0.1:<port>`），
   并把公开地址设成域名：`--public-url https://<域名>`（连同 `--trusted-host <域名>` 一起写进 `extraAppArgs`，
   否则 DSH 的 Host/Origin 校验会拒掉带域名的请求），让 daemon 打印的链接与入口都以它为准；
2. 入口 URL 随之变成 `https://<域名>/dsh-wrainrock-daemon/enter`；
3. **但隧道的请求一定带 `CF-Connecting-IP` / `X-Forwarded-For`**，所以默认的 `enterMode: 'loopback'` 会一律拒绝 ——
   必须改成 `enterMode: 'key'`（入口 URL 带 `?k=…`），或者 `enterMode: 'open'` 并**同时**在外层套 Cloudflare Access；
4. 别忘了 cookie 会绑定**公网 authority**：换域名、换端口都会让已交换的 cookie 失效，需要重新走一次入口。

## 改了端口以后会怎样（端口搬迁）

**问题**：端口从 A 改到 B 重启后，旧进程已经退出，旧地址（A 端口）直接 `connection refused`——
浏览器只给你一句「无法访问此网站」，不告诉你新端口在哪；手边存的书签、还开着的旧标签页于是都成了死路，
用户被卡在中间。上一次「登录与入口」的两个坑也在同一时刻爆发：旧 token 链接重启即 401，cookie 名绑定的
authority 从 `127.0.0.1:A` 变成 `127.0.0.1:B` 后同样失效。

**现在**：只要端口真的变了，daemon 会在**刚被放弃的旧端口**上留一个极小的「搬家提示服务」
（`bin/mover.mjs`）。它只做一件事：对任何请求回 `302` 到
`http://127.0.0.1:<当前端口>/dsh-wrainrock-daemon/enter`——当前端口每次请求都现读 `state/runtime.json`
（读不到就退回启动参数 `--to`）。于是任何旧地址——书签、旧标签页刷新、手输的旧端口——都会被自动送到
**新端口**的登录入口；入口再向 DSH 现取一个 token、种下绑定新 `host:port` 的 cookie。用户全程不需要
知道新端口号。搬家服务不复用任何旧凭据，两个坑因此一起绕过了。

设置页改端口时也会配合：点「保存并重启」后页面显示 `端口已改为 {port}，正在等待新地址…` 并开始轮询
新端口的入口，新进程一应答就自动跳到新地址；万一没等到，横幅里还留着一个手动打开的链接
（具体实现见 `client.js` 的 `moveWaiting` 文案）。

状态与开关：

- `state/movers.json` = `{ "movers": [ {"from":<int>,"pid":<int>,"at":"<ISO>"} ] }`：记录当前留在哪些旧端口上、
  分别是哪个进程。守护进程每次启动都据此收敛一次——该杀的杀、该补的补（例如同一旧端口重复记录只留一个，
  已被当前进程占用的旧端口记录直接清掉）。
- `state/last-port.json` = `{ "port":<int>, "at":"<ISO>" }`：上次激活时实际监听的端口，用来判断「这一次
  是不是真的换了端口」以及该在哪个旧端口上补搬家服务。
- 配置 `moverOnPortChange`（默认 `true`）：关掉后不再起新的搬家服务，并把已记录在案的都杀掉；此后旧地址
  就真的打不开了。

安全边界：搬家服务只绑 `127.0.0.1`，不对局域网或公网暴露；**只回一个 `302` 跳转**（连转发目标都没有时
回一句 `503`），不提供任何内容，也不碰 DSH 的鉴权面；旧端口若已被别的进程占用，它当场静默退出，绝不抢端口；
`moverOnPortChange: false` 或插件卸载时会把它停掉。`state/movers.json` 只是一份普通文件，所以停掉之前
都要确认那个 pid 真的是 `mover.mjs`（`/proc/<pid>/cmdline`）——文件损坏时也绝不会杀到无关进程。

如果 daemon 后来**又要回自己曾经放弃的端口**（例如用户把端口改回去），看护会在启动前先让路：它读
`state/movers.json`，把占着它要用的那个端口的墓碑停掉，日志里留一句
`port tombstone on <端口> (pid <pid>) stopped: this run wants that port`，否则墓碑会让子进程
`EADDRINUSE` 崩掉、白白计一次失败。

排查时可以手动起一份：

```bash
node ~/.dsh/wrainrock-daemon/bin/mover.mjs --from 3080 --to 3081 --home ~/.dsh/wrainrock-daemon
```

## 恢复阶梯

1. **启动前校验**：`dsh --profile web --dump-config`。失败 → 把坏配置留档到 `reports/broken-*`，用 `backup/` 里的快照恢复并继续启动；恢复后仍不行 → 直接进安全模式。
2. **快速失败计数**：每次运行存活不足 `healthySeconds`(120s) 记 1 次失败；滚动窗口 `failureWindowSeconds`(600s) 内累计到 `failureThreshold`(3) → 进入安全模式。
   **例外（环境守卫，2026-10-15 加入）**：若失败原因是端口被**本项目的另一个实例**占用（`EADDRINUSE` 且那个端口确实由同类实例持有），则记 `peer-port` 报告并等待它退出，不计失败、不升级——服务其实已经由同伴提供。
3. **安全模式**：首次使用时用官方模板创建 `dsh-safe` profile（只含随 dsh 发布的 bundle），随后一直用它启动；**安全模式是粘性的**，需要显式复位。安全模式默认监听 `safePort`（主端口 + 1），这样即使常规 profile 的实例还占着主端口，安全模式也能起来：

   ```bash
   curl -X POST -H 'x-dsh-wrainrock-daemon: 1' 'http://127.0.0.1:3080/dsh-wrainrock-daemon/reset?restart=1'
   # 或：rm -f ~/.dsh/wrainrock-daemon/state/{mode,failures} && systemctl --user restart dsh-wrainrock-daemon.service
   ```
4. **汇报**：写 `reports/incident-<时间>.md` + `state/incident.json`，并发 `notify-send` 桌面通知（`notify` 可关）；`/dsh-wrainrock-daemon/status` 会把事故回传给按钮。
5. **systemd 第二道防线**：若看护脚本自身反复死掉（`StartLimitBurst=5/90s`），主 unit 进入 failed 并触发 `dsh-wrainrock-daemon-safemode.service`，它用 `--force-safe` 启动安全模式并同样写报告。

## 配置（profile 的 `cordis.patch.yml` 该行 `config`）

`unitName`、`safeUnitName`、`safeProfile`、`safeTemplate`、`failureThreshold`、`failureWindowSeconds`、
`healthySeconds`、`maxBackoffSeconds`、`port`、`safePort`、`portGuard`、`host`、`extraAppArgs`、`cliPath`、`nodeBin`、
`cliDir`、`homeDir`、`unitDir`、`installOnActivate`、`containerOnly`、`startAtBoot`、`enableLinger`、`notify`、
`enterMode`、`entryKey`、`moverOnPortChange`。

`enterMode` 控制稳定入口 `GET /enter` 的放行策略：`loopback`（默认，只服务直连回环且无转发头）、
`key`（额外要求 `?k=` 等于入口密钥）、`open`（不限制来源，仅在另有访问控制时使用）。`entryKey` 是 key 模式
使用的密钥，留空/非法时以 `state/entry.json` 里那份随机密钥为准（见「登录与入口」一节）。

`moverOnPortChange`（默认 `true`）控制端口变更后是否在旧端口留一个只回 `302` 的搬家提示服务；设成 `false`
则不再新建、并把已有的都停掉（见「改了端口以后会怎样」一节）。

`cliDir`（默认 `$HOME/bin`）是放置 `dwd` / `dsh-wrainrock-daemon` 两个软链接的目录，改它不会移动
`<homeDir>/bin/dwd` 本体，只换链接位置。

`safePort` 默认是主端口 + 1（安全模式专用）；`portGuard`（默认 `true`）控制「同伴端口识别 + 等待而不升级」这套守卫。
`containerOnly` 默认在容器里为 `true`：distrobox/podman 下宿主机和容器各有一个 systemd 用户管理器，而它们读的是
**同一份** `~/.config/systemd/user`——不加限制就会各起一份 unit，容器里的 `systemctl --user` 只看得到自己那份，
另一份成了看不见的「同伴」。开启后 unit 带 `ConditionVirtualization=container`，宿主机那份直接跳过，只剩容器这一份
（也就没有双管理器重启的问题）。真想让宿主机也跑，把它设成 `false`。

插件没有声明 Config schema（因此插件管理页不显示配置表单），改动请直接编辑补丁行；每次插件激活都会按当前配置重写脚本与 unit。

## 卸载

```bash
curl -X POST -H 'x-dsh-wrainrock-daemon: 1' http://127.0.0.1:3080/dsh-wrainrock-daemon/uninstall
rm -rf ~/.dsh/wrainrock-daemon              # 需要时连报告一起删
loginctl disable-linger "$USER"      # 若不再需要免登录启动
```

## 测试

```bash
bash tests/ladder.sh
```

用桩命令在 `.selftest/` 里跑完整阶梯（18 组断言组）：崩溃升级到安全模式、健康运行清零、
干净退出改为重启而不是停服、坏配置隔离+恢复、接管助手两条分支、
**瞬时 0 退出算启动失败而不是正常退出**、**命令行为空时报错而不启动**、
**从已安装布局自动修复 node/dsh 路径**、**收到 stop 信号立刻退出**、
**改名迁移（两代旧名）**、**同伴端口等待 / 锁待命 / 端口竞争不计失败 / 安全模式独立端口**、
**停掉一个看护会停掉另一个管理器的同伴**、**systemd-kill helper 会停掉所有看护并重新拉起 unit**。
不触碰真实 profile 与真实 unit。另有 `node tests/restart-plan.mjs`（重启决策）、`node tests/migration.mjs`（改名迁移）、
`node tests/port-state.mjs`（端口取值解析、`state/port.json` 覆盖文件的读取、端口快照 `current/next/pending/source` 优先级）
与 `node tests/entry-state.mjs`（登录入口纯函数：`peerIsDirectLoopback` 的回环/转发头判定、`entryGate` 三种 mode、
`buildEntryUrl` 的拼法、`entryKeyOf` 对 `state/entry.json` 的读取）、
`node tests/mover-state.mjs`（端口搬迁纯函数：`state/movers.json` 的读取容错、`planMovers` 的 kill/spawn/keep 决策）、
以及 `node tests/entry-flow.mjs`（登录入口端到端：伪造的 `dsh web` 鉴权面与守护进程自己的路由跑在同一个端口上，
验证裸路径 401、`/url` 的三个地址、`/enter` 的 `303` + 真实 `Set-Cookie`、经代理时 403、`enterMode=key` 的密钥校验、
拿不到 cookie 时回退 `302`，最后真装一份 `dwd` 跑 `url` / `enter` / `status`），
以及 `bash tests/tombstone-supervisor.sh`（端口墓碑真进程实测：起一个真的 `mover.mjs` 占住旧端口，
再让真的 `supervisor.sh` 回到那个端口，验证它先停掉墓碑再启动、启动命令行用的是覆盖后的端口，
并且损坏的 `state/movers.json` 里写着的无关进程不会被杀）。

## 修复记录

**2026-11-02 — 「重启之后服务没回来，面板一直显示未运行」**。症状：13:57 点「重启」，页面再没回来；
`state/client-events.jsonl` 里 `restart:result` 写着 `ok`，unit 却从那一刻起一直是 `inactive`，
后来那份 `dsh web` 是手动起的，一直跑到晚上。

根因：`systemd-kill` 助手就住在它要拆的 cgroup 里。它由 unit 内的 web 进程 spawn，天然继承
`dsh-wrainrock-daemon.service` 的 cgroup；它按设计先 `TERM` 看护（unit 的 `MainPID`），systemd 随即按
`KillMode=control-group` 清空整个 cgroup——助手被一起收走，脚本末尾那句 `systemctl --user start` 根本没跑到。
看护是干净退出（`code=0`），`Restart=on-failure` 不会拉起，于是 unit 永远停在 inactive。

三处改动：

1. `relaunch.sh` 在 `systemd-kill` 开头把自己 `re-exec` 进 `systemd-run --user --scope` 的新 scope
   （先用 `/bin/true` 探一次，systemd-run 不可用就原地跑），它要拆的 cgroup 里不再有自己。
2. 助手把过程写进 `logs/relaunch.log`（不再 `stdio: ignore` 丢掉），`start` 之后轮询 `is-active`
   两测一秒，unit 没起来就记日志并 `exit 1`——同类问题下次能直接看到原因，而不是只剩一个 `ok`。
3. 插件激活时自愈：unit 已 enabled 却没在跑（上次重启没回来、或 web 是手动起的），直接 `StartUnit`
   重新武装；状态是 `failed`（`StartLimitBurst`）时先 `reset-failed`。看护起来后看到端口被本进程占着，
   只报告 peer 并待命，不会抢端口。

`tests/ladder.sh` 18/19 组加了 `systemd-run` 桩：断言助手先跳出 scope、并且 `start` 后确实做了 `is-active`
校验；5/6 组断言 `relaunch.log` 落盘。46 个断言全绿。

补充（同日）：那两份管理器其实是 distrobox/podman 的宿主机 + 容器各一份，不是配置错误。插件现在给 unit 加
`ConditionVirtualization=container`（配置项 `containerOnly`，容器里默认开），宿主机那份直接跳过，只剩容器这一份；
提示文案也改成解释这个布局，不再叫用户「停掉多余的管理器」。`tests/manager-advice.mjs` 锁住这段文案。

**2026-10-17 — 「重启又失败了，他一直不重启」**。症状：点「重启」后页面回 `202`、`state/client-events.jsonl` 里
`restart:plan` / `restart:result` 都写着 `ok`，但服务实际没动——`systemctl --user show -p MainPID` 前后是同一个 pid，
正在服务的看护进程（`…/wrainrock-daemon/bin/supervisor.sh`）也好端端地活着。

根因是 2026-10-15 那个环境问题的**另一面**：两个 systemd 用户管理器各跑一份 unit，而 `systemctl --user` 只连到
持有会话总线的那一个（`user@ian.service`）。于是：

1. unit 的 `MainPID` 是**待命实例**的看护（它拿不到单例锁，在 `standby` 里等）；
2. 真正服务的那份跑在 `user@1000.service` 的 cgroup 里，`systemctl --user restart` 从头到尾没碰它；
3. 待命实例收到 TERM 后按「干净退出」走，`Restart=on-failure` 不会拉起它，而服务的实例也没被要求重启
   → 重启变成永久空操作（面板还诚实地报告成功，因为 `systemctl` 确实返回 0）。

现在两条路都堵上（`tests/ladder.sh` 第 17–18 组、`tests/restart-plan.mjs` 锁住）：

1. **看护互相停止**：任一 `supervisor.sh` 收到 `TERM`/`INT` 正常退出时，会 `TERM` 掉同一安装（同一 `$SELF`
   路径）的其它看护；它们在 unit 里以 0 退出，`Restart=on-failure` 不会重启——于是「停」真的是停，
   多余实例自然收敛为一份。
2. **重启决策识别「unit 不在自己名下」**：`/restart` 先读 unit 的 `MainPID` 与当前看护 pid，若二者不同
   （unit 被另一个用户管理器持有），不再做无用的 `systemctl --user restart`，而是交给 detached helper：
   结束所有看护 → 等端口释放 → `systemctl --user start` 单元。`MainPID` 与看护 pid 一致时仍走原来的直连
   `systemctl restart`（单管理器环境的行为完全不变）。

脚本与 unit 的写入改成「临时文件 + rename」原子替换：这个修复必须能在旧看护仍在运行时部署，而 bash 是
惰性读取脚本的，就地截断会让正在运行的看护执行到半截文件。

逃生口（面板完全无响应时）：

```bash
pkill -f "$HOME/.dsh/wrainrock-daemon/bin/supervisor.sh"
systemctl --user start dsh-wrainrock-daemon.service
systemctl --user show dsh-wrainrock-daemon.service -p MainPID --value   # 应等于活着的看护 pid
```

**非目标**：本项目不会尝试「修好」重复的用户管理器本身（那要 root 改系统/登录配置），只保证在这种环境里
停、启、重启都不再是空操作；多余的管理器仍应人工清掉。

**2026-10-15 — 「疑似进了安全模式，但不是本项目进的」**。现场：`~/.dsh/wrainrock-daemon/state/mode` 为 `safe`、事故类型是 `safe-mode`，而 `preflight` 一直 ok、`preflight.err` 为空——也就是说 `web` profile 本身没坏。子进程的真实退出原因是
`listen EADDRINUSE: address already in use 127.0.0.1:3080`。

根因不在 profile，而在环境：这台机器上同一个账号同时存在**两个 systemd 用户管理器**——
`user@1000.service`（slice `user-1000.slice`，logind 记录的正主、`Linger=yes`）和 `user@ian.service`（slice `user-ian.slice`，登录 / `su -m` 那条路拉起来的）。`dsh-wrainrock-daemon.service` 是 enabled 的，于是**两个管理器各启动了一份**：两个 `supervisor.sh`、两个 `dsh web --port 3080`。先抢到端口的活着，另一份 2 秒内以 1 退出；看护脚本把它读成「profile web 起不来」，3 次快速失败后升级到粘性安全模式。更糟的是旧版安全模式沿用同一个 `--port 3080`，两份实例于是继续为一个端口互抢：赢的那份常驻 `dsh-safe`，输的那份每 120s 空转一次，`mode`/`failures` 还被两份看护互相覆盖，永久卡死。这也解释了为什么插件自己的「复位并重启」按钮救不回来——它所在的进程走 `user@ian.service` 的 bus，`systemctl --user restart` 重启的是**输的那一份** unit，占着端口的那份不会被停掉。

现在三层都堵上了（`tests/ladder.sh` 第 13–15 组断言锁住）：

1. **看护单例锁**：`state/supervisor-<profile>-<port>.lock`（`flock`，进程退出自动释放）。同一 profile+端口只允许一个看护脚本运行；第二个进待命循环，持有者退出后接管。它不会启动第二个 dsh，也不会把同伴的端口算成自己的失败。
2. **同伴端口识别**：启动前若端口已被同类实例持有（`/proc/*/cmdline` 里带该端口的 dsh 进程，或对端能应答本插件的 `/dsh-wrainrock-daemon/status`），就写一条 `peer-port` 报告并等待，**不计失败、不升级**；端口竞争的失败在子进程退出后也会被同样归类。
3. **安全模式独立端口**：安全模式默认监听 `safePort`（主端口 + 1），不会再和常规 profile 抢同一个端口；`safePort`、`portGuard` 可配置。

另外插件现在会**检测重复的用户管理器**：`/status.managers`、安装结果 `warnings`、看护启动日志与事故报告的 `## Environment` 小节都会指出「N 个 systemd 用户管理器」并给出建议。守卫能让这个故障不再发生，但重复的管理器本身是环境问题，值得单独清掉（`loginctl list-sessions` 看 CLASS 为 `manager` 的那几个，多出来的那个通常来自多余的登录方式或 linger 配置；`loginctl list-sessions` 没有 `--class` 选项，看护脚本与插件都是在输出里匹配 CLASS 列）。

**2026-10-05 — "点重启后关掉但没起来"**。根因有两层：

1. 生成的 `supervisor.sh` 里 `DSH_CLI` 为空（是上一轮为了热重载而做的插件开关操作，让仍在运行的**旧模块**重新激活并覆盖了正确脚本）。空路径下执行的是 `node "" web …`，Node 把它当成"没有脚本"进入 REPL，stdin 是 `/dev/null` 立刻 EOF，于是**以 0 退出**；
2. 看护脚本把这次瞬时 0 退出当成"正常退出"，于是自己收工，systemd 的 `Restart=on-failure` 也不会重启 → 服务停在那里。

现在三层都堵上了：生成端拒写坏命令行（`cliPath`/`nodeBin` 解析不到就报错不写）、
看护端启动前自检并按已安装布局自动修复 node/dsh 路径（修不了就写报告重试，绝不当作正常退出）、
退出语义改为"只有当子进程存活够久才算健康；瞬时 0 退出按失败计数并升级安全模式；
干净退出也照样重启，只有 `systemctl stop` 才结束服务"。

**2026-10-06 — "systemd 托管时点重启，服务回来了但页面不回来"**。服务端侧证据表明重启是成功的
（新实例起来并打印了 URL、一直存活；`~/.dsh/logs` 里那份 `EADDRINUSE` 启动失败日志是**另一个** dsh 进程，
看护脚本并未参与）。问题在页面侧：客户端重启流程有两个缺陷 —— ① `POST /restart` 一旦抛错就整体放弃
（而服务端先死、响应丢失恰恰是常态），既不再轮询也永不刷新；② 流程挂在 dock 里的组件上，
服务端一断会话级 slot 塌掉、组件 unmount，`cleanup` 就把流程掐死了。现在整个生命周期移到模块级
（与 React 挂载无关），POST 失败继续观察，并用 `tests/restart-flow.mjs` 的 17 条断言锁住这条回归。

**2026-10-06（第二次）— "点重启后页面卡住"**。`/status` 在本插件挂载时就能应答，但页面真正需要的
`/api` 传输通道要等整棵树挂载完、`appReady.commit()` 之后才注册（`@deepseek-ai/dsh-api-gateway` 的既定行为）。
实测那次点击：`restart:click` 00:32:02.618 → `restart:reload` 00:32:06.297，**刷新发生在就绪之前**，
页面于是刷进一个连不上后端的壳。现在刷新前先等 `ready=true`，期间只投一次 `restart:waiting-ready`，
等待时长记进 `restart:reload.readyAfterMs`，一直不就绪则提示「服务仍在启动」而不是盲刷；
同时补回了 `/mounted` 页面存活回执与轮询心跳。另外看护脚本现在会记录 `preflight ok in Nms`，
便于判断重启耗时到底花在哪。

**2026-10-06（第三次）— "点重启好慢"**。把耗时拆开测：`preflight`(组合配置) 0.10s、systemd 停+起 <1s、
插件挂载→`ready` 2.0s —— 服务侧本身约 2.5s；而我在链路里自己加了 700ms 固定延迟（只为等 202 到达浏览器，
其实 250ms 足够）和 1.2s 轮询间隔，约 1.9s 是自找的，现已砍到 250ms / 500ms，并在按钮上显示 `重启中… Ns`。
另外 `restart:reload` 回执过去常丢失：它发出后页面立刻跳转被浏览器掐断；现在用
`fetch(..., { keepalive: true })` 让它活过跳转，诊断不再缺环。

## 已验证 / 未验证

已在本机（Bazzite 44 / systemd 259 / DSH 0.2.0-rc.2）实测通过：

- 插件行激活、Client slot 注册（`conversation.composer.dock` 与 `sidebar.footer.action` 中 `dsh-wrainrock-daemon`，active）；
- HTTP 接口：`/status`、`/repair`、`/selftest`（真实启停 systemd 用户 unit）、`/mounted`，写操作鉴权（无头 403、GET 405）；
- unit 语法 `systemd-analyze --user verify`、`systemctl --user is-enabled` = `enabled`、`loginctl` linger；
- 看护阶梯 **18 组断言全绿**（`bash tests/ladder.sh`，含「冗余用户管理器时第二个看护待命」「安全模式走独立端口」
  「停掉一个看护会停掉同伴」「systemd-kill helper 重新拉起 unit」四组新断言）
  + 重启决策测试（`node tests/restart-plan.mjs`）+ 改名迁移测试（`node tests/migration.mjs`，对 `dsh-ian-daemon` 与 `dsh-autostart` 两代旧名各跑一遍）
  + 端口状态测试（`node tests/port-state.mjs`：解析 `0`/`65536`/`-1`/`'abc'`/`''`/`null`/`3080`/`'3080'`/`' 3080 '`/`'3080.5'`，
    `state/port.json` 缺失/合法/坏 JSON/越界/`safePort:null`，以及快照 `live > override > config` 的优先级与 `pending` 判定）
  + 登录入口测试（`node tests/entry-state.mjs`：回环 peer 与各转发头、三种 `enterMode`、入口 URL 拼接与 `state/entry.json` 读取）
  + 端口搬迁测试（`node tests/mover-state.mjs`：`state/movers.json` 缺失/坏 JSON/非数组/非法条目/多条记录，
    `planMovers` 在 `moverOnPortChange=false`、旧端口重复记录、`previousPort` 非法（`0`/`65536`/`'abc'`）或等于当前端口、
    以及正常搬迁时的 kill/spawn/keep）
  + 登录入口端到端测试（`node tests/entry-flow.mjs`），并对着**本机真实运行的 3080 实例**验证过：
    `GET /dsh-wrainrock-daemon/enter` → `303 location: /`，拿到的 `dsh-auth-…` cookie 名正好等于
    `b64url(sha256(浏览器看到的 authority))`（即端口/域名换了就得重新从入口进）；token 不对时回退 `302` 到带 token 的地址；
- 用与 `ExecStart` 完全相同的命令行真实启动过 Harness；
- **真实重启电脑后自动起来**（开机 15 秒内拉起，无需登录），关机时看护脚本干净退出；
- 手动「重启」按钮点击后成功由 systemd 接管；
- **家目录含空格**（`/var/home/u/Distrobox/deepseek harness`，2026-10-31 修复）：
  unit 的 `ExecStart=`/`Environment=` 现在按 systemd 规则加引号，此前会把监督脚本路径
  拆成两个词、`/bin/bash /var/.../deepseek` 退出 127，再触发 `StartLimitBurst` 与
  `OnFailure=` 安全模式循环；`node tests/unit-quoting.mjs` 覆盖这条回归。

未验证：不同发行版/桌面环境下的表现；非 fnm 安装 node 的路径布局；端口搬迁提示服务在真实改端口
链路里的端到端行为（`tests/mover-state.mjs` 覆盖的是纯函数，搬家服务本身只做了「只绑回环、只回 302」的代码审查）。

## 安装（从 GitHub）

```bash
dsh plugin --profile web add github:Wraindrock/dsh-wrainrock-daemon
```

或在 Harness 的插件管理页里用同一 spec 安装。装好后插件会自动写 unit、enable 并开启 linger；
当前手动运行的实例要等下次开机或点一次「重启」才由 systemd 接管。

### 升级

每个发布版本都打 tag（当前 `v0.3.2`，与 `package.json` 的 `version` 一致）并发布为 GitHub Release。
升级有两条路：

**1. 市场（dshmarket）里一键升级。** 对 `github:` spec 的安装，市场比较「默认分支 HEAD 上
`package.json` 的 `version`」与「已安装版本」：HEAD 版本变新才出现「有新版本 x.y.z」并提供更新。
这个比较有 30 分钟缓存，刚发完版可以点界面上的「重新检查」立刻刷新。

> 如果那里显示的是**「有新提交（未发版）<sha>」**而不是「有新版本」，说明市场读到的 HEAD 版本
> 还没有前进（`raw.githubusercontent.com` 有缓存，或版本号提交尚未推上去）。按市场自己的规则
> （见 dshmarket `lib/updates.js` 的 `gitVersionUpdate`、其 `unreleasedCommit` 字段），
> 它只安装**正式版本**，不会自动装未发版的提交；等版本号前进或点「重新检查」即可。

**2. 命令行重新安装。** 同一个 spec 再装一遍，会重新解析到默认分支的最新提交并更新锁定：

```bash
dsh plugin --profile web add github:Wraindrock/dsh-wrainrock-daemon
```

要钉住某个发布版本，把 tag 写在 spec 后面：

```bash
dsh plugin --profile web add github:Wraindrock/dsh-wrainrock-daemon#v0.3.2
```

两条路装完都要点一次界面上的「重启」（或等下次开机），运行中的实例才会换成新版。

> 注意：Harness **自带**的插件管理页（`dsh-plugin-manager`）的「升级」只对从 npm registry 安装、
> 且包名相同的第三方包可用——其 `updateRefusal()` 会以「不是从同名 registry 安装」拒绝 `github:`
> 这类来源。本插件用的是 GitHub spec，所以那条路走不通，用上面的市场或命令行。

## License

MIT © 2026 Grant-Felix — 见 [LICENSE](LICENSE)。

## 已知边界

- 服务绑定默认回环地址；`dsh web` 的 GUI 需要带 token 的 URL，见上文日志取法；日常请用稳定入口
  `GET /dsh-wrainrock-daemon/enter`（`dwd enter`），见「登录与入口」一节。
- 同一账号上有多个 systemd 用户管理器时，unit 会被启动多份：看护用单例锁+同伴端口识别把服务收敛成一份，
  停/启/重启也不会再是空操作（见 2026-10-17 修复记录）；但管理器本身是环境问题，本项目不清、也不该清。
- 服务在开机时若端口被**非本项目的**进程占用，仍会按快速失败计数升级到安全模式（此时安全模式用 `safePort` 启动，依然可用）；若占用者是**本项目的另一个实例**，则认定成同伴、等待它退出，绝不会因此升级。
- 只接管自己写过的 unit：若 `~/.config/systemd/user/dsh-wrainrock-daemon.service` 已存在且不含本插件标记，会先备份为 `*.pre-dsh-wrainrock-daemon` 再覆盖。
- `package.json` 里的 `private: true` 只用于避免误发到 npm registry；从 GitHub 安装不受影响，要发布到 npm 时删掉它即可。
- 「转发至 Cloudflare 域名」（设置 → Daemon）是**实验性·开发中**的占位行：不可点击、不做任何事，见上文「实验性功能」。
- `state/port.json` 只影响**下一次启动**：写完不重启（`--no-restart` / 只点「保存」）时，当前进程仍监听旧端口，
  此时 `/status.port.pending` 为 `true`；`dwd status` 会区分「当前端口」与「下次启动端口」。
