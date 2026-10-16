# FlowPilot v0.1 客户需求匹配评估

检索日期：2026-10-16  
评估范围：Upwork 当日可见的 8 条项目管理、创意生产和工作流自动化岗位，与当前仓库实现对照。

## 结论

FlowPilot v0.1 可以作为一个聚焦的产品演示：把一封模拟客户邮件整理成带项目、优先级、负责人和日期的任务草稿，由有权限的人审批，再走完任务状态并在 Activity 中查看审计记录。它展示了“agent 提议、人类决策”的工作方式。

它目前不能作为这些岗位所描述的完整业务系统，也不应演示成 ClickUp、Notion 或 Monday.com 的替代品。样本中 5 条与 FlowPilot 的基础任务流部分吻合，但都缺少客户岗位要求的关键协作能力；另外 3 条的核心需求是现有 SaaS 修复或跨工具自动化，v0.1 不覆盖。这里的 Upwork 岗位主要是在招人做运营工作，能够证明痛点存在，不能证明发帖者正在采购 FlowPilot 这样的产品。

## 当前实现核对

- Web 有 Overview、AI Inbox、Tasks Kanban、Activity、仅 owner/admin 可见的 AI settings 和 Integrations 目录页；后者清楚标出模拟邮件入口及尚未接通的外部服务。任务含负责人、优先级和到期日，可审批并按状态机推进。
- Inbox 入口是模拟邮件。`DeterministicAiProvider` 使用规则分析，不调用 LLM；置信度是演示分析器输出，不代表模型准确率或客户邮件上的生产表现。
- 有审计轨迹、组织范围隔离、MCP scope 与角色权限。Agent 可以请求创建草稿，但没有审批权限。
- Overview 的 Team workload 已按到期周估时与成员周容量对比，并单列没有排入本周的估时；它仍不是自动排期、截止风险预测、跨项目冲突解决或 Sprint 规划。
- 已补充任务估时、本周容量对比、前置依赖和阻塞校验、任务清单、团队评论、HTTP(S) 交付/参考链接、手动工时记录，以及独立于内部审批的客户签收链接。客户链接 14 天过期、token 只存哈希；客户只看到任务标题/项目和交付链接。依赖、清单、客户回馈、工时和普通任务变更进入审计。
- 组织 owner/admin 可在 AI settings 页面选择离线规则，或配置兼容服务的 base URL、model 和 API key；本地开发还可从 `~/.duya/secrets.json` 服务端导入现有密钥。密钥使用 `SESSION_SECRET` 派生密钥加密保存，API 不回传密钥，连接测试只发送合成请求。真实分析会把请求正文和组织候选客户/项目/成员名称发给所选模型。底层响应仍会校验项目/客户/成员 ID 和原文证据。MiniMax CN 的真实连通性已验证，但未保存到组织设置，因此当前 app 仍使用离线规则分析。
- 仍没有真实 Gmail、Slack、ClickUp、Notion、Drive、Figma、Frame.io 或 Hubstaff 连接；没有 OAuth/webhook、附件上传/版本、自动通知、可重用任务模板、定时周报或跨工具同步。Demo 的 Cedar 交付 URL 是 `example.com` 占位链接，客户外发前必须替换。
- 默认本地演示使用 PGlite 时，Web 和独立 MCP 进程的数据库实例不会共享内存态；不要让两个进程并发打开同一个 PGlite 数据目录。双进程演示应改用共享 PostgreSQL；本机演示可把 MCP 客户端连到 Web 的 `/mcp` 路由。

## Upwork 客户岗位样本

以下岗位在 2026-10-16 的读取中均显示为 Active。需求概述来自岗位正文；招聘状态和内容可能随后变化。

| 岗位 | 客户描述的具体工作 | FlowPilot v0.1 匹配度 |
|---|---|---|
| [Agency Operations & Project Manager: ClickUp Production System](https://www.upwork.com/jobs/~022109730854879915864)（10 月 12 日） | 把多客户请求转成 ClickUp 任务，贯穿 brief、设计、文案、审阅、客户审批、上线；需要依赖、模板、优先级冲突、Hubstaff 工时和周报。 | **部分**：现在可以演示依赖阻塞、估时/容量、工时、任务清单和客户签收；仍没有 ClickUp/Hubstaff、可重用模板、自动跟进或周报。 |
| [Project Manager for a scaling design studio](https://www.upwork.com/jobs/~022109442382569447957)（10 月 12 日） | 同时管理 3–6 个项目；合并多个利益相关方反馈，追踪 scope creep、文件和交接；依赖 Notion/ClickUp、Slack、Figma，并提前发现设计师超载。 | **部分**：已补充任务评论、交付链接、容量估算和客户反馈回合；仍没有跨工具同步、文件版本、多人反馈收敛和 scope 变更管理。 |
| [Creative Project Manager](https://www.upwork.com/jobs/~022109431471317734734)（10 月 11 日） | 管理电商创意和网站上线；检查 brief、素材完整性和交付质量，管理 revisions、里程碑、依赖、QA、逾期/停滞和每日/每周进度。 | **部分**：现在能用清单、依赖、交付链接和真正独立的客户签收状态演示 QA/修改往返；没有附件/版本管理、自动逾期提醒、里程碑或周报。 |
| [Build our Bug & Feature Request process from scratch](https://www.upwork.com/jobs/~022110060826589320737)（10 月 13 日） | 请求散落在 Slack、WhatsApp、邮件，Bug 遗失且缺少优先级；希望有多渠道 intake、triage 准则、SOP 和可立即使用的追踪系统。 | **部分**：任务状态与人工审批可做流程原型；只有模拟邮件入口，没有多渠道接入、Bug/Feature 分类规则或可配置 triage/SOP。 |
| [Junior Technical Project Manager / Development Coordinator](https://www.upwork.com/jobs/~022110812591384571701)（10 月 15 日） | 在 ClickUp 维护 backlog、负责人、优先级、期限和状态；持续跟进 blocker、dependency、估时、决策纪要、sprint、QA、release 与风险简报。 | **部分**：现在覆盖 blocker/dependency、估时、工时和 QA 清单；没有 ClickUp、会议决策记录、sprint/release 跟踪或自动风险报告。 |
| [Clickup AI Super Agent Creation](https://www.upwork.com/jobs/~022110432629960163737)（10 月 14 日） | 监控 ClickUp 状态触发，带自定义字段访问外部网站、下载案件文件、回传附件，再根据文件起草待发送邮件。 | **不匹配端到端要求**：MCP 可以准备任务草稿，但没有 ClickUp 触发器、浏览外部网站、文件下载/上传或邮件草稿能力。 |
| [Monday.com Issues](https://www.upwork.com/jobs/~022110796166179004457)（10 月 15 日） | 修复流程日期级联更新，并排查被 @ 提及时收不到通知的问题。 | **不匹配**：没有 Monday.com 连接、日期依赖传播或消息通知系统。 |
| [N8N Workflow for Image Translation](https://www.upwork.com/jobs/~022110679602570609535)（10 月 15 日） | Gmail 收到图片后下载、翻译成 5 种语言、上传 Google Drive，并把最终链接邮件回发。 | **不匹配**：当前没有 Gmail、文件翻译、Drive 上传或发信执行器。 |

“部分”只表示 FlowPilot 覆盖了其中的任务跟踪/审批切片，不表示能够独立交付该岗位要求。按这批样本计算，5 条部分覆盖、3 条不覆盖、没有一条完整满足；这是小样本功能映射，不是市场统计或购买意向评估。

## AI settings 补充验证（2026-10-16）

- 已实现组织级 AI 设置页：owner/admin 可选离线规则或配置兼容 API 的 base URL、model、API key，并做不含客户数据的连接测试。密钥在服务端用 `SESSION_SECRET` 派生密钥做 AES-GCM 加密，设置 API 只返回是否已配置。
- 本地开发环境可从 `~/.duya/secrets.json` 导入密钥；同时兼容嵌套 JSON 与 Duya 实际使用的点号扁平键名。选项列表只返回服务商名称（DeepSeek、MiniMax CN、OpenRouter、GLM CN），密钥留在服务端。
- MiniMax CN 订阅 Key 已做一次真实连通性冒烟：按官方文档调用 `https://api.minimax.cn/v1/chat/completions` 和 `MiniMax-M3.1-Flash-Preview`，返回 HTTP 200 并收到模型响应。请求只含合成连接检查文本；密钥与响应正文未输出，且没有写入组织设置，因此当前 FlowPilot 仍使用离线规则分析器。接口和模型依据：[MiniMax OpenAI SDK 文档](https://platform.minimax.cn/docs/api-reference/text-openai-api)、[MiniMax Chat Completions 文档](https://platform.minimax.cn/docs/api-reference/text-chat-openai)。
- 验证证据：全仓 TypeScript 检查通过；隔离 PGlite 冒烟覆盖密文保存/不回传、保留已有密钥、仅管理员可改、端点校验、租户隔离、离线切换清密钥及合成连接探测；本地凭据发现冒烟只输出服务商名称；另有上述 MiniMax 真实服务商连通性结果。本轮浏览器重新加载 `/settings/ai`、`/overview`、`/tasks` 和 `/activity` 均成功；AI settings 页面显示离线规则配置，未写入 MiniMax 凭据。真实邮件分析、组织内保存后的设置页连接按钮尚未做端到端验证。
- 本轮恢复记录：我在恢复旧服务时强制结束了一个仍在运行的 Next 进程；之后 PGlite 报告 WAL checkpoint 无效。原数据完整保存在 `.data/flowpilot.corrupt-backup-20261016-1444`；应用使用原有迁移和 seed 重建了 Northline 模拟租户。Next.js 15.5.28 当前运行于 `http://localhost:3000`，浏览器看到了 Overview 指标、Tasks 12/12 张卡和 Activity 的 9 条审计事件。此次只重新验证了浏览器关键路由；pnpm/Corepack 下载仍受本机 registry DNS 故障影响，因此没有重新运行完整 Vitest 套件。

## 项目演示判断

**适合作为有实际业务闭环的早期产品演示，主题可扩展为“请求 → 团队执行 → 客户签收 → 可审计”。** 推荐演示顺序：模拟邮件进入 Inbox → 展示规则分析（或在配置模型后展示 LLM 分析）→ 人工审批草稿 → Tasks 中看估时/依赖/QA 清单 → 附交付链接和手动工时 → 客户通过一次性链接请求修改 → 返回任务返工并再签收 → 团队完成任务 → Activity 核对客户意见及每次状态审计 → 用 Overview 看工时容量。

本轮重建后的浏览器核验显示 Overview、Tasks、Activity 和 AI settings 均能读取数据库；Tasks 看板显示 12 张演示卡，Activity 显示 9 条审计事件，AI settings 当前为离线规则模式。原先手工演示的额外状态没有放进新 seed；旧数据目录已完整留档在恢复备份中。上一轮工作记录有 MCP Streamable HTTP SDK 客户端实测。要现场演示 MCP 写入并在网页看见结果，当前 PGlite 配置应使用 Web 的 `/mcp` 入口，或换成两进程共享的 PostgreSQL。本机完整 Vitest 套件尚未在本轮重跑；项目此前的 68 项测试和构建记录来自上一轮验证。

演示时应明确标注“模拟邮件 + 规则分析”，不要称为已连接 Gmail 的 AI 自动化，也不要把任务审批说成客户对创意成品的验收。这样能把可信的工程亮点（统一业务核心、状态机、权限边界、MCP、人类审批、审计）与尚未实现的真实集成区分开。

## 最优先的产品缺口

1. **真实入口与可验证抽取**：先接 Gmail 和 Slack，做好 OAuth、webhook 校验、跨源去重与失败重放；把规则分析替换成结构化 LLM，并对低置信度请求强制人工补全。
2. **生产协作能力**：补齐附件上传与版本、多人客户反馈合并、scope 变更记录、逾期提醒、截止风险预测和自动排期。现在已有任务评论、清单、外部链接、修订回合、依赖阻塞与估时容量，但还不能自动解决跨项目冲突。
3. **管理闭环**：加入可复用 checklist/工作流模板、工时与周期报表、通知/周报自动发送，以及外部项目工具同步（优先 ClickUp），再用真实团队验证它能减少多少人工协调。

本轮已把依赖、客户签收、估时/容量和轻量协作做成 Core + 数据库 + Web/MCP 读面，并以新 PGlite 集成冒烟核过主要业务门槛。完整客户适配还需要真实入口与工具同步、可复用模板、自动通知和报告；这些 Upwork 岗位仍只是需求信号，并非 FlowPilot 购买意向。
