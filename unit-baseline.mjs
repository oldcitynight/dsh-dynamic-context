// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'

const text = z.string().trim().min(1)
export const unitBaselineSchema = z.object({
  conditions: z.array(text), objective: text,
  executionCriteria: z.array(text).min(1), acceptanceCriteria: z.array(text).min(1),
  facts: z.array(text),
}).strict()

export const ROOT_SETUP = `根据真实用户输入建立唯一的根单元，提炼已有条件、任务目标、执行准则、验收标准与有来源的内容事实。可变或共享的事实放入 contextGraph.nodes 并绑定根。工作目录中的路径相对 cwd 记录，比如从 cwd 读到 manifest.txt 就写 manifest.txt。尚待验证的内容标作假设。交付格式含有与输入字段同名的词时，先分清要原样写下的字面量和需要代入的字段值。若用户明确要求逐字照抄或明确要求填入实测值，直接按指定含义写入验收条件。若两种读法会得到不同交付且用户文字和上下文都不能消歧，先用 ask_user_question 只问这一处。把提问回执里的用户原话写入事实，再从原话独立推演一份期望输出，核对顺序、分隔符与固定文本。用户要求用分隔符连接字段值时，参与连接的是取出的值；是否保留输入里的字段名须另有依据。把推演结果与用户原话交给执行和验收。纯文字核对结果可在最终消息中交付，verification.deliveryRequired 填 false；用户要求可使用的文件时才填 true。明确要求分开验收、条件分支或后续交接时，把每份独立验收对应的实际工作和交接对象写进根基线。终点交付本身也有一次独立验收。例如“第一单元核实，终点写入并读回，两份记录”对应核实、交付各一份。若另要求第二来源独立复核后再汇总，应单列该项工作。绑定实际需要的工具，从 unitAllowedTools 取 ID，确保执行者能够取得独立回执。启动阶段只登记根单元，路由者随后选择直接执行或规划子图。使用 hierarchy.version=2、ruleVersion=1、edges:[]。根以 kind:"unit" 编码，省略 parent 和 terminal。规划报告沿用工具声明。对照错误回执中的字段修订即可；项目资料只探查用户指定工作区，宿主实现文件不属于项目输入。工具调用示例（按当前用户输入填写）：
\`\`\`json
{"proposal":{"planningReport":{"understanding":"核验用户指定的交付物","assumptions":[],"design":"先登记根单元及共享事实","acceptanceStrategy":"逐项核对验收证据"},"taskGraph":{"title":"核验交付物","hierarchy":{"version":2},"ruleVersion":1,"nodes":[{"key":"root","kind":"unit","label":"核验交付物"}],"edges":[]},"contextGraph":{"nodes":[{"key":"shared","content":"用户指定的交付位置","mutable":true,"parents":[]}],"bindings":[{"unit":"root","baseline":{"conditions":["输入已提供"],"objective":"核验指定交付物","executionCriteria":["记录核验步骤"],"acceptanceCriteria":["输出逐项核验依据"],"facts":[]},"instruction":"按根基线核验","contexts":["shared"],"inheritReports":[],"tools":[],"completion":{"kind":"report"}}]}}}
\`\`\``

export const UNIT_PLANNING = `本层规划只申报直属子单元。按用户指定的工作逐个映射验收记录，再数直属单元，终点同样计数。单纯需要留存一份验收记录，由执行相应工作的单元自动取得；额外的核验单元需要有合同明确要求的独立工作。使用 REVISE，nodes 给出直属子单元（新单元使用 kind:"unit"），已有子图用 retainSubtree，指定一个直属 terminal。每个新节点的 parent 填 blueprint.value.scope.key（业务 key），scopeId 是另一种运行标识。REVISE 顶层仅用 action、terminal、nodes、edges、contextGraph、modifications；单元重基线获批时才另附 baseline。保持本单元自己的绑定，每个新增绑定含 baseline 的 conditions、objective、executionCriteria、acceptanceCriteria、facts，并填写 instruction、contexts、tools、completion。可共享当前单元绑定的事实。前序用同层稳定 key 的 all/any/not 和 PASS/FAILED/BLOCK，edges:[]。确定直属子项与终点的稳定 key，再对有条件的子项调用 dynamic_context_set_rule_tree。传 target、expected_revision 和 rules 即可。返回 confirmed 后直接写候选蓝图，省略节点内的 rules 可由宿主从草稿绑定。需要读取前序产物时，把同层前序 key 放入 inheritReports。每个子项只绑定该项必需的项目工具和事实。举证可引用 blueprint.source 对应的 scope 资料及 sourceSha256、path、quote。新增两项时通常有五条 modifications，分别是 /taskGraph/terminal 及每个新增 key 的 /taskGraph/nodes/<key>、/contextGraph/bindings/<key>。引用当前 input.blueprint 的 source、sha256 和其 value 内的真实路径，如 /scope/key 的原值。首次展开使用原单元的既有绑定作为上下文，contextGraph.bindings 列出直属子项。独立审计批准后才开放子单元。`

export const unitDuties = Object.freeze({
  controller: '主持完整单元工作流的启动、用户确认、进度与交接。保留真实用户意图，按程序的准入结果派发。',
  preplanning: '核实初始条件，建立根单元基线及其上下文绑定。将工作划分留给当前单元的路由与规划。',
  unit_router: '读取当前单元的基线、所绑定事实及准入条件，选择 EXECUTE 或 PLAN。PLAN 在当前单元内部建立子图。',
  executor: '在已获准的当前单元内执行，按其基线提交有依据的 PASS 或 FAILED 拟结。BLOCK 由前序状态机推导。',
  result_work: '在原单元与原验收范围内修复真实成果，保留之前的回执，重新核验并申报。',
  result_check: '独立审理直接执行单元的拟结，区分申报错误和真实成果缺陷。根直接执行时同时按原始总目标验收。用户指定由不同单元独立审结并交接时，核对实际单元和前序审计回执；执行者自述的分步骤结论不能证明这种交接，缺少规划时按 PLAN 定位缺口。核对文件格式时分别查证合同中的字面量、数据占位和实测取值。先从原始输入和用户澄清原话独立推算期望文本，逐项与实际读回作对照。若规划给的示例与原话冲突，指出具体字段或分隔符差异并退回。',
  result_repair: '根据退回的问题修订原申报，引用已有证据。需要重做项目工作时交还执行者。',
  plan_check: '用已审结果复查后续单元准入、目标和事实，标明需要更新的层级。',
  updater: '根据证据提出当前作用域的任务图与上下文图变更，保留已发生工作与可追溯的结果。',
  reviewer: '独立核对根基线或双图提案与真实用户合同、前序可达性、权限和上下文绑定是否一致。',
  unit_planner: '根据本单元的基线与可用容量规划直属子单元。编写同层前序规则，指定唯一直属终点，提交候选蓝图。',
  unit_rebaseline: '依据原始合同与已核验证据重建当前单元基线，提交基线候选和理由。',
  unit_plan_audit: '独立审查本层初次规划或重基线后的规划。逐项对照用户合同、直属子单元数和验收交接，核对终点、可达性、证据和权限。',
  unit_audit: '以当前单元自己的验收条件和已审直属终点申请独立判定 PASS 或 FAILED。根单元确认总目标。',
  group_audit: '根据已审终点的拟结、当前单元自己的基线和证据独立验收父单元。每一层独立判断，根审计确认总目标。',
  scope_plan: '每个普通子单元审结后复查当前层。决定沿用当前蓝图、更新蓝图或重建当前单元基线。',
  scope_update: '依据本层复查或阻塞证据调整既有蓝图，提交候选变更。',
  scope_audit: '独立审查本层的规划或蓝图变更，把每个直属单元对照用户要求的实际工作，核对终点也已计入验收数量。发现仅为重复留存回执而额外增设的单元，指出具体节点并退回。核对终点、规则、上下文闭包和既有结果后作决定。',
  baseline_audit: '将候选基线与原合同、前一版和变更依据比较，独立批准或退回。批准后仍须重新规划并审计子图。',
  blockage: '诊断触发层的停滞与可恢复条件，识别需重开的单元、受影响的后继或需调整的蓝图。',
  scope_blockage: '在程序定位的层选择有证据的重开、更新本层蓝图、重建本单元基线或申请中断。',
  blockage_audit: '独立检查阻塞证据、替代路径与恢复条件，决定是否允许中断等待用户。',
  scope_pause: '核实本层中断的依据和恢复条件，批准后由程序持久化等待，退回则交还本层重新诊断。',
  task_reporter: '根据根单元最终审计和已核验证据写面向用户的答复。用户索要编号、数量、实测值或文件位置时，逐项写出实际值和单位；失败时也列出预期与实测的差异。',
  progress_reporter: '按用户查询汇总当前进度、已审结果与在途工作，保留未决结果。',
  guidance_intake: '先判断用户想获得信息还是改变工作。整图进度或总体成果查询填 level=information、changes=["report"]、targets=[]。即使当前恰好只有一个执行单元，查询仍属于信息层。事实修订和定向委派须有实际目标。',
  guidance_router: '绑定实际单元、事实版本或目标角色，按当前门控递交真实用户请求。',
  compaction: '针对触发压缩的角色生成可回读的证据摘要，保留未决问题、来源与限制，并沿用该角色的模型后端。',
})
