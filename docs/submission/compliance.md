# Day0 GOAI semi-final — data sources and compliance statement

- Status: final submission statement, 1 September 2026
- Scope: hosted `mock` demonstration, controlled mock-mode evaluation and local
  `real (local)` verification
- Intended use: a synthetic demonstration of onboarding and bounded operational
  work; not a production service

## Data inventory, source and authority

| Data | Source and authority | Processing and submission use | Privacy / synthetic status |
|---|---|---|---|
| Seeded mock office | Operator-authored fixtures in the repository: team documents, runbooks, spreadsheet rows, Slack-like messages, tickets and a social feed | Seeded separately for each agent; used by the hosted demo and both arms of the controlled evaluation | Fully synthetic; no production customer, employee or personal data |
| Evaluation tasks and onboarding fixture | Versioned `evaluation/tasks/semifinal.json` and `evaluation/onboarding/day0.json` in the repository | Fifteen fixed unfamiliar tasks, three runs per task and two arms. The onboarding fixture is a deterministic reconstruction, not a verbatim transcript | Fully synthetic; task answers live in the seeded office, not in task prompts or product instructions |
| Real-mode team documentation | Operator-authored local folder and operator-owned Notion demonstration workspace, explicitly linked by the operator | Read-only sync, system discovery, runbook loading and connection-route evidence | Synthetic demonstration content. Detected credentials are removed before document persistence as described below |
| Linear work surface | Operator-owned `REVOPS` demonstration project and scoped operator-provided service credential | Local real-mode discovery, probe, intake, exact-action review, synthetic issue reads and writes | Fully synthetic issues; no production project or customer record |
| Slack work surface | Operator-owned demonstration workspace and scoped bot/OAuth credential | Local real-mode connection probe and bounded synthetic message work | Fully synthetic workspace content; no production conversation |
| Browser-driven Looker tile | Operator-hosted local demonstration page and login described in the synthetic documentation | Local real-mode browser-floor discovery, probe, read and refresh verification | Synthetic page and values; not a real analytics deployment |
| Northstar CRM | Operator-authored documentation describing a fictional system | Used to verify the explicit `absent` state and deferral when no approved route exists | No endpoint, credential or CRM record is connected |
| Model inputs and outputs | Synthetic fixtures and approved runtime artefacts sent either to the local `qwen3:8b` endpoint or, in the hosted beds, to the configured OpenAI endpoint | Charter, planning and execution outputs. The three frozen evaluation beds are `qwen3:8b`, `gpt-5.6-terra` and `gpt-5.6-sol` | Hosted beds transmitted synthetic evaluation content only. Provider-side processing and retention follow the operator's provider account terms and were not independently audited by Day0 |
| Day0 and evaluation evidence | Day0 state transitions, gate verdicts, approved literal action payloads, redacted provider identifiers/outcomes, timing and value-free action digests | Reproducibility, result verification, revocation evidence and audit | Derived from the authorised synthetic sources. Exports redact personal addresses and token-shaped values |

The operator owns or administers every demonstration workspace and authored every
source record. No production, customer, employee or personal data is required to
reproduce the submission. Any use with another organisation's information requires
that organisation to establish its own lawful basis, access authority, retention
rules and provider agreements; this demonstration does not supply them.

## Evaluation provenance and claim boundary

The submitted controlled comparison ran in mock mode so both arms received the
same immutable seeded office and could be reproduced without third-party accounts.
Each of the three frozen beds used both arms, the same 15 tasks, three repetitions
per task, temperature 0.4 and a parity-asserted shared harness. No LLM judge
contributes to any score: deterministic graders read terminal state, adapter state,
the ledger and seeded mock surfaces.

The real path was verified locally against operator-controlled Notion, Linear and
Slack demonstration accounts plus the local browser-driven Looker tile. This proves
the connection, authority, transport and result-verification path at demonstration
scale; it is not a production deployment, security certification or claim that the
mock evaluation estimates all workplace tasks. Earlier evaluation directories are
retained as superseded audit history and are not final evidence.

A complete real-mode walkthrough was recorded on 3 September 2026 from a fresh
clone set up by the README's real-mode route on `gpt-5.6-terra`: documentation
linked from an operator-owned folder and Notion workspace, three systems
connected through the approval cards, work completed against the operator's own
Linear and Slack demonstration workspaces and the local browser-driven Looker
tile, a held action rejected with a written reason and revised, and a write
refused after its grant was revoked. The supervision counts quoted in the
proposal are the counts that run's own ledger recorded. It is one demonstration
observation on synthetic content, not a controlled result and not a production
deployment.

## Credential and documentation boundary

- Documentation credentials and manually landed surface credentials are accepted
  only by server actions through write-only password inputs. The input is cleared
  immediately; plaintext is not persisted in React state.
- Stored credentials use AES-256-GCM with a fresh 12-byte IV and authentication tag.
  The encryption key is a server environment secret. Public queries return only a
  safe label and source reference; no query returns ciphertext or IV.
- Redaction is the first documentation persistence boundary. Detected token/key
  values are encrypted into the `credentials` table, while `docPages` and mirrored
  documents receive only a marker such as `<credential: linear service token,
  stored>`. Removing the discovered value on a later sync revokes that credential.
- Plaintext exists only inside the current server-side action that connects to the
  authorised provider. Credentials are not returned to clients or placed in task
  fixtures, skill bodies, literal work-action payloads, events or the audit ledger.
- Provider-returned effects, identifiers and errors are redacted before persistence,
  including literal, JSON-escaped and URL-encoded credential echoes. Retained
  request metadata excludes bodies, headers and credentials.
- A surface is not `connected` until its evidence-backed route and credential request
  receive the required approvals and a server-side probe succeeds. Provider
  endpoints and tool allowlists are bounded rather than accepted from arbitrary
  documentation text.

These controls reduce accidental disclosure; they do not replace an organisation's
secret manager, key-rotation process, access review or incident-response programme.
Shared credentials found in documentation carry a governance warning and should be
rotated into an approved vault.

## External effects, permissions and human control

- Documentation bindings are read-only. Discovered system names and routes remain
  evidence, not authority.
- Manager and IT decisions govern connection setup; credential landing and a
  successful liveness probe are separate steps.
- Every proposed effect is materialised as a literal action before the exact-action
  gate. With autonomous actions off, writes are held. With it on, only actions that
  satisfy current standing grants and policy may apply automatically; boundary
  actions are held and out-of-policy actions are refused. Public posts remain held.
- Authority is re-read after credential access and immediately before transport.
  Revoked grants, disabled autonomy, a stale/dead surface or a deleted agent stop
  the provider call. A separately manager-approved literal action remains its own
  declared authority boundary; revoking standing scope is not represented as
  cancelling that exact approval.
- A landed effect is verified from provider state and recorded with redacted provider
  identifiers and outcomes. Model narration alone is not accepted as evidence that
  an action happened.
- The manager remains responsible for approving held actions, rejecting unsuitable
  work, controlling credentials and resolving work when documentation records no
  usable surface.

## Retention, deletion and privacy protection

- `api.reset.deleteMyData` removes the current agent's Day0 records. Documentation
  unlink removes its stored pages and mirrors; credential revoke/rotation makes the
  previous stored credential unavailable.
- Local self-hosted data and model logs remain in operator-controlled volumes/files
  until the operator deletes them. External provider objects and provider-side
  records must be deleted under those providers' controls; Day0 reset cannot erase
  an already-landed external effect.
- The repository retains synthetic fixtures and frozen evaluation evidence needed
  for reproducibility. Value-free action audits retain field names and SHA-256
  digests rather than model-produced values. The submission's private working notes
  are gitignored and are not part of the public repository.
- Do not enter production secrets, personal data or regulated records into the
  demonstration stack. If the system is adapted for real organisational use,
  minimise fields, define retention/deletion periods, review provider terms, obtain
  required consent or authority and perform the appropriate security and privacy
  assessment first.

## Industry and professional limits

Day0 performs bounded operational work under an approved charter. It does not make
financial, employment, legal, medical, safety-critical or customer-credit decisions,
and it does not replace a qualified professional, manager or institution. Requests
outside the approved role, permissions or connected systems must be refused,
deferred or escalated. A human remains accountable for final decisions and external
effects, especially in higher-risk domains.

## 中文版：Day0 GOAI 半决赛数据来源与合规声明

- 状态：最终提交版本，2026 年 9 月 1 日
- 范围：托管的 `mock` 演示、mock mode 受控评测，以及本地 `real (local)` 验证
- 预期用途：使用合成数据演示 Agent 入职和受约束的运营工作，不是生产服务

### 数据清单、来源与授权

| 数据 | 来源与授权 | 处理方式和提交用途 | 隐私 / 合成状态 |
|---|---|---|---|
| 预置 mock office | 仓库中由操作者编写的固定数据，包括团队文档、操作手册（runbook）、表格行、类 Slack 消息、工单和社交信息流 | 为每个 Agent 单独写入；供托管演示和受控评测的两个实验组使用 | 完全合成；不含生产客户、员工或个人数据 |
| 评测任务和入职固定数据 | 仓库中版本化的 `evaluation/tasks/semifinal.json` 和 `evaluation/onboarding/day0.json` | 15 项固定陌生任务，每项运行三次，两个实验组。入职数据是确定性重建，不是逐字访谈记录 | 完全合成；任务答案位于预置 mock office，而不在任务提示或产品指令中 |
| Real-mode 团队文档 | 操作者编写的本地文件夹和操作者拥有的 Notion 演示工作区，由操作者明确链接 | 只读同步、系统发现、操作手册加载和连接路径取证 | 合成演示内容；检测到的凭据会在文档持久化之前移除 |
| Linear 工作 surface | 操作者拥有的 `REVOPS` 演示项目和作用域受限的服务凭据 | 本地 real-mode 发现、连接探测、工作接入、精确操作审批，以及合成工单读写 | 完全合成的工单；不含生产项目或客户记录 |
| Slack 工作 surface | 操作者拥有的演示工作区和作用域受限的 bot/OAuth 凭据 | 本地 real-mode 连接探测和受约束的合成消息工作 | 完全合成；不含生产对话 |
| Browser-driven Looker tile | 操作者在本地托管的演示页面，以及合成文档中描述的登录信息 | 本地 real-mode browser-floor 发现、连接探测、读取和刷新验证 | 合成页面和值，不是真实分析系统 |
| Northstar CRM | 描述虚构系统的操作者自编文档 | 用于验证没有获批路径时明确进入 `absent` 并延后处理 | 未连接 endpoint、凭据或 CRM 记录 |
| 模型输入与输出 | 合成固定数据和获批运行时 artefact，发送给本地 `qwen3:8b` endpoint；托管评测环境则发送给配置的 OpenAI endpoint | 生成章程、计划和执行输出。三个冻结评测环境为 `qwen3:8b`、`gpt-5.6-terra` 和 `gpt-5.6-sol` | 托管评测只发送合成评测内容。服务商侧的处理和保留遵循操作者账户条款，Day0 未独立审计 |
| Day0 与评测证据 | Day0 状态转换、gate 判定、已批准的 literal action payload、已脱敏 provider id/outcome、时间和不保留值的 action digest | 用于复现、结果验证、撤权证据和审计 | 派生自已授权的合成数据源；导出会脱敏个人地址和 token-shaped 值 |

操作者拥有或管理所有演示工作区，并编写了全部源记录。复现本次提交不需要任何生产、客户、员工或个人数据。若使用其他组织的信息，该组织必须自行确认合法处理依据、访问授权、保留规则和服务商协议；本演示不提供这些授权。

### 评测来源与结论边界

提交的受控比较在 mock mode 中运行，因此两个实验组获得相同且不可变的预置 office，评审无需第三方账户即可复现。三个冻结环境都运行两个实验组、相同的 15 项任务、每项三次、`temperature` 0.4，并使用已断言两组配置一致的共享 harness。任何得分都不使用 LLM judge；确定性评分器读取终止状态、adapter state、ledger 和预置 mock surfaces。

Real path 在本地通过操作者控制的 Notion、Linear 和 Slack 演示账户以及本地 browser-driven Looker tile 完成验证。这证明了演示规模下的连接、授权、传输和结果验证路径；它不是生产部署或安全认证，也不表示 mock 评测能够估计所有工作场景。更早的评测目录仅作为已取代的审计历史保留，不作为最终证据。

2026 年 9 月 3 日记录了一次完整的 real mode 全流程：从全新 clone 按 README 的 real
mode 路线搭建，模型为 `gpt-5.6-terra`；文档来自操作者自有的本地目录与 Notion
workspace，三个系统经审批卡片连接，工作在操作者自有的 Linear、Slack 演示 workspace
和本地 browser-driven Looker tile 上完成，其中一项被拦截的操作因书面理由被驳回并修订，
另有一次写入在权限撤销后被拒绝。提案中引用的监督计数即来自该次运行自身的 ledger。
这是一次基于合成内容的演示观察，不是受控实验结论，也不是生产部署。

### 凭据与文档边界

- 文档凭据和手工写入的 surface 凭据只由 server action 通过 write-only password input 接收。输入会立即清空，明文不会保存在 React state 中。
- 存储使用 AES-256-GCM，每条记录使用新的 12-byte IV 和 authentication tag。加密 key 是服务端环境机密。公开 query 只返回安全 label 和 source reference，不返回 ciphertext 或 IV。
- 脱敏是文档持久化的第一道边界。检测到的 token/key 值会加密写入 `credentials` table；`docPages` 和镜像文档只收到 `<credential: linear service token, stored>` 一类 marker。后续同步若移除该值，相应凭据会被撤销。
- 明文只在当前连接已授权 provider 的 server-side action 中存在。凭据不会返回 client，也不会进入 task fixture、skill body、literal work-action payload、event 或 audit ledger。
- Provider 返回的 effect、identifier 和 error 在持久化前会脱敏，包括 literal、JSON-escaped 和 URL-encoded credential echo。保留的 request metadata 不含 body、header 或凭据。
- Surface 只有在 evidence-backed route 和 credential request 取得所需批准，并且服务端 probe 成功后，才进入 `connected`。Provider endpoint 和 tool allowlist 受到边界约束，不会直接接受文档中的任意文本。

这些控制用于降低意外泄露风险，但不能替代组织自己的 secret manager、key rotation、access review 或 incident-response programme。若在共享文档中发现凭据，系统会显示 governance warning；该凭据应轮换到获批 vault。

### 外部操作、权限和人工控制

- 文档连接为只读。发现的系统名称和路径只是证据，不自动构成权限。
- 管理者和 IT 共同控制连接设置；凭据写入与成功的存活探测是两个独立步骤。
- 每个外部操作在 exact-action gate 之前都会具体化为 literal action。关闭自主操作时，写操作会被 hold；开启后，只有满足当前现行授权（standing grant）和 policy 的 action 才能自动执行，边界 action 会被 hold，越权 action 会被 refuse。公开发布始终保持 hold。
- 系统在读取凭据之后、发出传输请求之前重新读取授权状态。Grant 已撤销、autonomy 已关闭、surface stale/dead 或 Agent 已删除时，provider call 会被阻止。由管理者单独批准的 literal action 构成独立的授权边界；撤销 standing scope 不等同于取消该精确批准。
- 已落地操作通过 provider state 验证，并记录脱敏后的 provider identifier 和 outcome。仅有模型叙述不能证明 action 已发生。
- 管理者仍负责批准 held action、拒绝不合适的工作、控制凭据，并在文档没有可用 surface 时处理后续决策。

### 保留、删除和隐私保护

- `api.reset.deleteMyData` 删除当前 Agent 的 Day0 记录。Documentation unlink 会删除已存页面和镜像；credential revoke/rotation 会使之前的 stored credential 不再可用。
- 本地自托管数据和模型日志会保留在操作者控制的 volume/file 中，直至操作者删除。外部 provider object 和 provider-side record 必须使用相应服务商的控制项删除；Day0 reset 无法撤销已经落地的外部操作。
- 仓库保留复现所需的合成 fixture 和冻结评测证据。不保留值的 action audit 保存 field name 和 SHA-256 digest，而不是模型生成值。提交使用的私有 working notes 已被 gitignore，不属于公开仓库。
- 不应把生产 secret、个人数据或受监管记录输入演示 stack。若将系统改造用于真实组织，应先执行字段最小化、定义保留/删除周期、审查 provider 条款、取得必要同意或授权，并完成适当的安全和隐私评估。

### 行业与专业边界

Day0 只在获批章程内执行受约束的运营工作。它不作出财务、雇佣、法律、医疗、安全关键或客户信用决定，也不替代合格专业人士、管理者或机构。超出已批准角色、权限或已连接系统的请求必须被拒绝、延后或升级处理。人工始终对最终决定和外部操作负责，尤其是在高风险领域。
