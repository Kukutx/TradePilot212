# Pies

简体中文 · [English](../PIES.md)

Trading 212 的 Pie 是按目标权重配置、由券商保持投入的组合篮子。Trading 212 在 Public API 里把 Pies 接口标为弃用，但仍在提供，TradePilot 覆盖了全部六个接口。

API Key 需要 Pies 读取权限才能用读取工具，需要 Pies 写入权限才能修改。没有相应权限时，Trading 212 返回 403，TradePilot 会说明缺少哪项权限。

<a id="reading-pies"></a>
## 查看 Pies

`list_pies` 显示每个 Pie 的：

- 市值、投入金额、收益金额和百分比，以及 Pie 里待投入的现金；
- 获得的、再投资的和派发的股息；
- 目标和完成进度，以及 Trading 212 给出的状态（超前、正常、落后）；
- 对最新的若干个 Pie（默认 10 个），列出每个成分的目标占比、当前占比、偏离和持有数量，以及 Trading 212 报告的成分问题，例如标的已退市。

偏离是当前占比与目标占比之差的绝对值之和的一半：也就是要和目标一致，Pie 里需要挪动的那部分占比。

`get_pie` 读取单个 Pie 的完整信息。

Trading 212 每 30 秒允许读取一次 Pie 列表，每 5 秒允许读取一次 Pie 详情。TradePilot 把列表缓存 30 秒、每个 Pie 缓存 60 秒，券商客户端遇到限速的读取会等待后重试。传 `fresh: true` 可以跳过缓存。

<a id="changing-pies"></a>
## 修改 Pies

`review_pie_change` 起草四种变更之一，并在界面中打开。它自己从不修改任何东西。

| 操作 | 发送内容 |
|---|---|
| `create` | 新建一个 Pie，包括名称、成分、股息处理方式（再投资或派发），以及可选的目标、截止日期和图标。新建 Pie 不会投入任何资金。 |
| `update` | 现有 Pie 的完整设置。没填的字段保持当前值，成分也一样。 |
| `duplicate` | 复制一个 Pie，成分和设置相同，可以起一个新名字。副本一开始是空的。 |
| `delete` | 删除这个 Pie。它的持仓如何处理由 Trading 212 决定，所以请先在 App 里查看。 |

成分用 ticker、代码或名称对应一个占比来给出。占比会按比例缩放，使总和在四位小数下正好为 1，所以 `{"VUSA": 70, "EIMI": 30}` 也可以。一个 Pie 最多 50 个成分。

在界面里，**检查变更** 会解析 ticker，显示每个成分变更前后的占比，并列出需要注意的地方，比如移除了一个仍有持股的成分。**确认 Pie 变更** 只发送一次。在 Live 上，你还要勾选确认真实资金账户将被修改的复选框，没有勾选，服务器会拒绝这次变更。结果不明时会如实报告，从不重试；请先刷新 Pies 再重试。

新的目标占比只指导今后的投入。除非你在 App 里对这个 Pie 做再平衡，Trading 212 不会卖出现有持仓来匹配目标。

<a id="putting-money-into-a-pie"></a>
## 向 Pie 投入资金

Public API 无法向 Pie 入金。可以用订单篮子（`review_order_basket` 或 `plan_portfolio_rebalance`）买入各个成分，或者在 Trading 212 App 里给 Pie 加钱。
