# zcode-gift — ZCode 礼包助手（本地 magpie 插件）

多账号额度卡片（各套餐总量/余量）、礼包定时轮询与自动领取、领取记录面板。
**本地插件，不上 npm、不进社区 registry。**

## 功能

- **账号来源**：直接复用 magpie 里 `zcode` 供应商的登录态（`plugin-auth.json` 的 `zcode` / `zcode#*`）。
  本插件**不注册供应商、不提供登录入口、不做 OAuth**——早期版本注册过一个 `zcode-gift` 供应商，已移除；
  若 magpie 的插件卡片上仍显示旧记录，属残留，删掉即可（不影响礼包任务）。
- **额度卡片**：按套餐显示一次性礼包的「余量 / 总量」（万·亿 或 B/M）、周期套餐的用量与重置时间，
  待生效/已过期单独标注，有可领礼包时卡片给出提示行。
- **领取面板（侧栏 › ZCode 礼包）**：账号数、已领取礼包数与总量、成功/失败数、下次执行时间；
  领取记录（时间/账号/礼包/数量/状态/异常原因）；执行间隔（分钟）、单位显示、版本号来源设置。
- **版本号来源**：服务端按请求头 `X-ZCode-App-Version` 过滤活动投递，低于门槛直接返回空
  `deliveries`（code 0、HTTP 200，没有报错）。插件每次请求都取当前最高版本，来源可选：
  `local` 只读本机已装版本 / `github` 直连 GitHub tags / `mirror` 国内加速站。
  远端版本与本地取较大者，取不到时静默回退本地。
- **领取任务**：sidecar 常驻进程按间隔轮询全部已登录账号（默认 10 分钟，可 1–180 分钟），
  有可领礼包即自动领取——人机验证通过隐藏有头 Chrome 走阿里云无痕通道（headless 会被拒）。
  **任务开关默认禁用**，在面板里启用后才会执行。

## 安装

从 GitHub 安装：

```sh
magpie plugin add github:FireLv/magpie-zcode-gift
```

更新：

```sh
magpie plugin update
```

本地开发时也可以直接装目录：`magpie plugin add <项目路径>`。

账号不需要单独登录：任务直接读 magpie 里已有的 `zcode` 供应商登录态。
面板在侧栏 **ZCode 礼包**；领取任务默认禁用，面板中「启用任务」后才运行。

## 数据

- 配置与记录：`%APPDATA%\zcode-gift\`（config.json / records.json / snapshot.json）
- 页面快照：插件目录 `page/data.js`（sidecar 投喂，页面唯一数据来源）

## 版本号来源（config.versionSource）

| 值 | 取值方式 | 说明 |
|---|---|---|
| `local` | 只读 `~/.zcode/v2/runtime/provider/<plat>/<ver>/` | 不联网；只能用本机已装过的版本 |
| `github` | `api.github.com/repos/zai-org/ZCode/tags`（默认） | 匿名限流 60 次/小时，10 分钟一轮只占 6 次 |
| `mirror` | 加速站依次尝试：`gh-proxy.com` → `gh.ddlc.top` | GitHub 直连不通时用；2026-11-04 实测可用 |

远端结果 60 秒节流刷新一次，失败保留上次成功的值（只记 `error`，不倒退），
版本比较取「远端 / 本地」较大者。面板顶部会显示当前生效版本与来源。

## 边界与风险

- 领取接口需要阿里云人机验证 attestation；无痕通过依赖本机 Chrome（`--headless` 会被 F001 拒绝）。
- preview 接口有突发限速（429 + retry-after: 1s），runner 已做单次重试；请勿把间隔调到 1 分钟以下高频跑。
- magpie 上游明确不在官方插件里做自动领取；本插件为本地自用，风险自负。
