# 0.1.1-rc.62

- Visual inspection: each role chooses up to 5 new images per turn. The model sees the most recent 10 image occurrences; references and original tool records remain available for a fresh read.

- 更新预规划、执行和终审角色，支持工作区只读取证、用户中途引导、权限热更新及检查点恢复。

# 0.1.1-rc.42

- Inherit main conversation permissions by default; hot-update native workers and preplanning, cancel only tools affected by tightening, and preserve partial-effect receipts and task/Plan boundaries.
- Add native Settings controls for future workflow defaults, persist per-workflow preferences, and permit exact authorized old-default migration on explicit continuation.

- Add scoped Skill role-prompt and tool-policy services, with explicit defaults for all 94 current native and plugin tool IDs and an offline coverage check.
- Route human guidance through separate interpretation and dispatch roles at safe tool boundaries; support scoped mid-leaf blueprint suspension and read-only intermediate progress reports.
- Generate structured role reports through checked draft tools, retain templates and local edits, and replay declaration receipts without repeating completed work.
- Stream ZIP evidence beyond the previous 128 MiB limits while retaining read-only identity, member integrity and path checks.
- Keep changes local to the DSH 0.2.1-rc.5 maintenance line. No live profile replacement or publication is implied.

# Unreleased local changes — 2026-11-15

- Directory snapshot receipts, synchronized report schemas and examples, scoped reviewer pointers, precise validation feedback, and selected report repair with exact paused-read replay.
- Keep published version history below unchanged; this local work has not been published.

# 0.1.1-rc.42

- 配套任务图包更名为 `dsh-better-task-grapth@0.3.1-rc.42`。
- 支持运行中直接修订共享上下文，并持久保存版本。

# 0.1.1-rc.32 — DSH compatibility line

- Pin this build to its listed DSH releases and pair it with the other plugin on RC slot 2.
- Use the native Session plugin record API.

# 0.1.0-rc.24 — task-graph prerequisite and graph provenance (2026-11-13)

- Require the live task-graph extension contract; move joint revision implementation out of the base plugin.
- Add per-conversation user mode selection, scoped controls, persisted choices and task contract isolation while retaining global initial guidance.
- Route fresh task-only/context-only proposals through distinct fallback paths. Do not downgrade incomplete replacements of committed graphs.
- Record independent commit witnesses and exact snapshots. Missing historical graphs enter recovery, preserve active attempts, and require explicit consent to restore without execution replay.
- Retain host/CLI mode and direct execution; fake backend is the qualification scope for this candidate.

# 0.1.0-rc.23 — recoverable workspace path rejections (2026-11-13)

- Return a deterministic outside-workspace preflight rejection as a durable NOT_EXECUTED tool receipt, including the rejected path, permitted workspace and exact unexecuted call IDs. The model can correct its request without losing the whole leaf.
- Preserve the workspace boundary for file/search paths and symlink targets. Validate the complete unexecuted suffix before loading directory instructions; do not dispatch rejected calls or replay earlier successful effects.
- Explain where scratch reports should be stored. Private-state access, authority/instruction changes, unknown tool effects and unrelated errors retain their existing failure behavior.
- Cover file/search variants, symlink writes, same-batch path changes, correction and durable pause/resume with fake backends. The installed native-tool regression reproduces a bash-generated /tmp report followed by a rejected read and a workspace correction. No real API call is required for this fix.
- Sealed older A/B environments remain immutable. Active old checkpoints are not silently migrated across the runtime change.

# 0.1.0-rc.22 — report repair precision and historical artifact identity (2026-11-12)

- Explain the exact flat execution-report schema, current-leaf acceptance, artifact-reference scope and host-owned report protocol. Tool observations expose their real receipt IDs without changing the stored output used for quote validation.
- Accept a unique JSON presentation fence or an unambiguous disposition wrapper by lossless extraction; preserve presentation text and original digest. Ambiguous content remains a validation error. Report failures identify the actual field, source or quote to repair.
- Keep immutable accepted report/trace hashes strict, but observe earlier deliverable files as UNCHANGED, CHANGED or MISSING when inherited by later leaves. Normal incremental development no longer fails because an earlier accepted file was subsequently modified. Immediate acceptance and commit-time artifact validation remain strict.
- Require task graph rc.10 for source-pointer feedback, scoped runtime facts and lossless shared-context representation. Native request controls, serial roles and common budget accounting remain unchanged.
- Real and fake test evidence, including failures and measurement limits, is recorded in the workspace report-protocol tuning audit. This package does not replace the sealed formal A/B environment automatically.

# 0.1.0-rc.21 — result reports and distinct review responsibilities (2026-11-12)

- Default supervised workflows to `supervisionContext: reports`; initial submission requires an immutable model-authored planningReport. Explicit `legacy` remains for earlier protocol fixtures and deliberate compatibility use.
- Workers submit executionReport with brief milestones, criterion-linked results, complete declared directory manifests (including empty subdirectories), SHA-256 references, test results and exact receipt citations. Host programs check membership, hashes and quote provenance before model acceptance and recheck before commit.
- Result acceptance receives the current leaf contract, report, static checks and selected test outputs. It no longer receives every tool result or artifact body and does not judge ordinary recovered process errors.
- Plan review compares all accepted result reports, the current graphs and original planning conclusions. Raw tools, failed assemblies and prior audit deliberation are excluded. The revision signal remains directionless.
- Require graph rc.9: the updater submits a point-by-point modificationReport with reasons and source citations; host validation detects omitted/extra changes, fabricated citations and unexplained task-order changes. Independent review receives only the report, actual diff, cited source fields and affected context closures.
- Preserve rc.20 measured window management, native output/thinking controls, common accounting, serial locks and no replay of uncertain calls. Real-model quality of the new role protocol remains to be measured.

# 0.1.0-rc.20 — measured window-aware isolated review roles (2026-11-12)

- rc.19 is retained as an unselected local candidate. Exact v5 input replay showed 651,602 prose-estimated tokens versus 1,016,590 locally tokenized tokens; compaction was not triggered.
- Use the registered input meter throughout role assembly, summary chunk sizing and evidence paging. Without a model meter, use a conservative UTF-8 byte bound instead of the prose ratio. v6 supplies its official tokenizer locally without paid requests or monetary reservations.

- Apply the configured native window, pressure threshold and completion reservation to result check, plan check, report repair, updater and reviewer requests. Small inputs keep the original two-message path.
- Under pressure, archive large supplied evidence without truncation, summarize contiguous full-coverage chunks using the unchanged DSH compaction directive and native 65,536 output, and retain fixed contract/task anchors. All summary and review requests use the same accounting and durable no-replay boundary.
- Permit only role-local read-only evidence pages after compaction; preserve original source hashes/ranges and compact growing inspection history without orphaning tool results. This tool cannot read arbitrary paths, execute work, mutate reports, release a leaf or approve a graph.
- Preserve upstream HTTP status, provider code and diagnostic text. Known response errors no longer lose their context-overflow diagnosis.
- Offline/fake validation covers long evidence, tail counterexamples, source tampering, serial exclusion, final artifact revalidation, unknown summary receipts and native request settings. Real-model quality of the new evidence-summary framing remains unmeasured.

# 0.1.0-rc.18 — minimal supported audit counterexamples (2026-11-11)

- Require task graph 0.3.0-rc.8. Rewrite reviewer guidance to judge each change independently and explain the smallest sufficient supported counterexample, avoiding speculative additions after a valid rejection.
- Preserve native thinking/output settings and the existing JSON verdict schema. Direct execution remains byte-identical to rc.15.
- rc.17 was not selected for packaging: fixed verdicts passed, but its contamination response incorrectly condemned otherwise lawful repair components.

# 0.1.0-rc.17 — audit responsibility boundaries (2026-11-11)

- Require task graph 0.3.0-rc.7. Audit evaluates coverage across leaves and host verification, without assigning global publication byte obligations to every JSON-comparison report leaf.
- Direct execution behavior remains the rc.15 implementation. rc.16 and its observations are preserved.

# 0.1.0-rc.16 — audit-reason grounding (2026-11-11)

- Require task graph 0.3.0-rc.6. Its independent audit distinguishes contaminated production input from an actually weakened verification mechanism, and removes speculative duplicate violations.
- Direct execution behavior is unchanged from rc.15; that sealed package and its real engineering evidence remain preserved.

# 0.1.0-rc.15 — native edit recovery and current-leaf focus (2026-11-11)

- Preserve known native literal-edit rejections as no-write observations, defer the remaining batch, and let the model deliberately read and correct the edit. Unknown errors and external tools remain blocked.
- Pin the current leaf's instruction and completion scope in host facts. Explain that global requirements are delivered across leaves, not all inside the current stage.
- For native Linux bwrap workspace-write commands that already have an isolated writable /tmp, point child TMPDIR there. Parent environment, native mounts and private paths remain unchanged.
- Keep the failed rc.14 engineering trace and packages. Record the post-fix fake and real results separately; a released serial gate or passing model report is not external acceptance.

# 0.1.0-rc.14 — scoped local evidence (2026-11-11)

- Apply artifact citation requirements to artifact completions, explicit local byte/digest checks and submitted exact-byte claims. Do not impose an extra byte-proof obligation on report leaves that only compare complete JSON values.
- Preserve the original failing real samples and paired short/long positive and negative probes. A previously failed optional read does not invalidate later required successful reads.
- Retain the rc.13 host semantics, structural change index and lossless full-snapshot ordering. Require task graph 0.3.0-rc.5. Detailed outcomes and limitations are recorded separately in the workspace deep-tuning audit.

# 0.1.0-rc.13 — grounded audit and stable full-context prefix (2026-11-11)

- Share explicit COMPLETE/BLOCKED/FAILED, artifact/report, edge/context/report-inheritance and recovery semantics across supervised roles.
- Supply program-computed task, prerequisite, context and binding changes to independent revision review. Require objections to identify actual evidence and affected obligations; prior rejected feedback is evidence to reconsider rather than authority to obey.
- Serialize complete stable context nodes before volatile graph status. This preserves all information and permissions; any cache or cost benefit requires measured API results.

# 0.1.0-rc.12 — explicit completion/report semantics (2026-11-11)

- Tell whole-graph review, update and audit that every accepted COMPLETE disposition commits a report, including artifact completions; the required verified file is additional evidence, not a replacement for that report.
- This corrects a false additional objection found in an otherwise correct large-context rejection. Binary verdict accuracy alone does not establish sound audit reasons. The final clarification has offline regression coverage; its paid pressure retest remains pending after the total-budget fuse stopped further requests.

# 0.1.0-rc.11 — actionable artifact citation (2026-11-11)

- Clarify that an artifact reference requests host verification; it does not require a pre-existing host receipt. A digest supplied by an authorized source can support that request without an extra hashing tool.
- Ask local review to return a missing but available citation for repair instead of accepting a spurious blocked outcome. Byte/digest claims in report-based completions should also cite their relevant artifacts.

# 0.1.0-rc.10 — multi-file dispositions and repair feedback (2026-11-11)

- Remove the undocumented three-artifact ceiling from supervised dispositions. Each reference still requires a valid project path and verified SHA-256; configured context and storage budgets remain in force.
- Return the actual invalid field and validation message for malformed disposition schemas, including during report repair, instead of repeating a generic format request.
- Retain rc.9 infrastructure-failure classification and all rc.8 supervision improvements. Intermediate archives and failed live receipts remain preserved.

# 0.1.0-rc.9 — proposal failure classification (2026-11-11)

- Keep infrastructure and unexpected runtime failures visible to the host instead of treating them as model-repairable proposal rejections. Only known terminal syntax, schema and graph validation failures enter revision feedback.
- Retain all rc.8 changes. The intermediate rc.8 archive remains unchanged for its recorded engineering run.

# 0.1.0-rc.8 — recoverable revision and complete evidence (2026-11-11)

- Supply the fixed host contract to every supervised worker and local review independently of selected context nodes.
- Review current artifact text alongside host-verified hashes and ordered tool receipts; distinguish partial reads, later writes and recovered errors.
- Preserve the serial revision gate after a rejected candidate. Resume with hash-bound proposal and rejection feedback, while keeping each new reviewer independent of previous verdicts.
- Expose actual transitive context membership for original and candidate graphs. Preserve immutable history while checking future bindings for contamination.
- Require task graph 0.3.0-rc.4 for the revised coordinator handshake. Unknown API outcomes still require explicit reconciliation.

# 0.1.0-rc.7 — evidence-aware supervision (2026-11-11)

- Give local reviewers and report repair the active leaf's context, actual tool arguments and returned content.
- Expose host-verified artifact hashes to local review, and computed scheduling readiness to whole-graph review and revision roles.
- Require a single JSON disposition object and explain how to cite authorized hashes that the host verifies.
- Keep full-review context nodes in the graph snapshot once, alongside tool receipts and durable execution references.

# 0.1.0-rc.6 — supervised workflow outcomes (2026-11-11)

- Add opt-in structured leaf dispositions and completion evidence, with separate local result review and whole-graph review contexts.
- Commit accepted dispositions and the next scheduling gate atomically. Continue exact review checkpoints, and repair returned reports from recorded evidence on the original attempt.
- Use reason-free signals to start the existing independent updater and auditor. Preserve version checks, executed history, and invalidated report boundaries.

# 0.1.0-rc.5 — reviewed graph and context revisions (2026-11-11)

- Add separate updater and reviewer contexts, serial fresh requests, immutable host task contracts and task-boundary joint revisions with dsh-bettertaskgraphs 0.3.0-rc.3.
- Validate the complete approved candidate, authority, evidence, permissions and current revision before atomic commit; preserve executed tasks, used context closures and append-only history.
- Keep reports bound to their original context version, propagate invalidation and block stale report inheritance. Publish report validity and context version to controllers.
- Persist role requests and decisions; block blind replay of unknown results. A trusted host may archive an unknown role as ABANDONED_UNVERIFIED using verified reconciliation evidence, without changing graphs or releasing monetary reservations.
- Use the pinned provider's native output setting for revision roles and native request controls for the revision tool. Existing worker defaults and Web entry are preserved.

# Native compaction and A/B preparation (2026-11-10)

- Add opt-in `direct.compaction.strategy: dsh-native`: pinned rc.5 summary instruction and framing, native pressure/headroom/retention formulas, code-point tool-result pruning and balanced prefix selection.
- Send summaries through the direct HTTP transport with the same system/task prefix and tool schemas. Include auxiliary usage and partial receipts in tracing and host monetary monitoring; native auxiliary output is 65,536 tokens.
- Keep host task scope immutable, archive removed history, retain resident instructions and verify checkpoints on recovery. Append an approved reminder derived from the original task binding after compression; it cannot widen permissions.
- Support one structured, provider-confirmed context-overflow reduction/retry. Uncertain transport or effects still block replay. Request ordinals include summaries; `taskOrdinal` retains the separate tool-loop position.
- Permit explicit output caps through 393,216 tokens and a host streaming monetary observer. This does not change the small default limits or automatically enable a budget-only formal experiment.
- Correct default-route accounting: official `llm-deepseek` reserves 256,000 output tokens; with the listed 1,048,576 window, native pressure is 727,040 and tail retention is 126,812. The 838,860 threshold applies only when a smaller/no output reservation permits it.
- The cumulative CNY 5 follow-up passes three official-default summary/continuation trials at 24/24 strict checks, including the complete archived tool text (712,597 input tokens in the summary request). Removing only the task reminder from one identical summarized history produces unwanted tool calls and no answer; factual retention in that negative control is unscorable.
- Replace the smoke harness's streamed-byte cutoff with full-window/native-output monetary reservation and final-usage settlement. Preserve the earlier 23/24 diagnostic and unresolved CNY 1 request without replay or release of its hold. This is scoped native-compaction smoke acceptance, not full runtime, release or formal A/B acceptance. Existing rc.4 release artifacts are unchanged. Evidence: `docs/audits/dynamic-context-native-compaction-20261110-cny5/REPORT.md` in the workspace.

- Add explicit nullable experiment limits, durable request-reference traces, native request controls and null-aware recovery/artifact verification. Defaults and sealed release tarballs remain unchanged.
- Add a clean SDK baseline, model-owned joint-graph planner, transparent total-budget relay, actual-entry fake compaction/cutoff checks and frozen offline task/scoring preparation in the repository. These do not claim a formal paid A/B result.

# 0.1.0-rc.4

- Support explicitly configured windows up to 256 requests and 8,388,608 UTF-16 context characters, with unchanged small defaults and independent byte/storage limits. Larger per-node and tool-observation limits support near-window trials.
- Add opt-in `direct.reserveFinalReport`: the final request is report-only, enforced before any unexpected tool effect and preserved across safe resume. A report remains unverified and may describe incomplete work.
- Remove unavailable compression/source-read instructions when compaction is disabled; distinguish full-history persistence from compression.
- Add a requirements/evidence work protocol, targeted investigation guidance and concrete cross-stage handoff guidance.
- Require combinatorial verification size/runtime estimates and an evidence-based stopping point after real tests exposed an unnecessary 8! squared local check and command timeout. A timed-out check remains incomplete evidence.
- Recover definitive native `FS_STALE_VERSION` pre-effect rejections after a fresh native read; registered tools cannot impersonate this path.
- Store each exact request once and reference it from durable checkpoints, validating both file and original body hashes on resume. This is lossless persistence deduplication, without context compaction.
- Pair with task graph 0.3.0-rc.2, which raises its streamed artifact proof limit from 16 MiB to 1 GiB. Single journal files allow 256 MiB and the configured journal quota can reach 8 GiB.
- Protect plugin-private paths and managed DSH credentials by default. Native file tools reject protected paths and aliases; Linux shell/search tools receive per-call private mounts and credential-parent snapshots that also conceal atomic credential refreshes. Other host sessions retain their existing behavior.
- Pin native bwrap profiles to the verified absolute runner, so a project/PATH executable cannot replace the private-mount runner.
- Require state outside the whole project, and prevent registered tools from inheriting native Plan read classifications merely by matching a tool name.
- Frozen real-API v2 engineering and long-context attention evaluations are maintained in the repository audit; scoped results and failures are reported separately.

# 0.1.0-rc.3

- Return a native filesystem `FS_NOT_OBSERVED` rejection as a recoverable, no-effect observation. The model must read before a new write/edit attempt; uncertain effects and permission failures still stop execution.
- Scope filesystem recovery to the actual filesystem module; registered tools with matching names cannot impersonate these recovery conditions.
- Expose model-call limit, used and remaining calls through `dynamic_task_status`, including across safe restarts. A final report consumes a call.
- Permit explicitly configured request windows up to 64, retaining the default of 4 and hard per-task enforcement. Monetary campaign limits remain separate host policy.
- Include a Flash 1017 example without compaction, using a larger streaming reception allowance for long coding responses.
- Real engineering evaluation delivered a SQLite DAG queue with 33 local tests and 31 independent cases over three scheduling seeds. Original request-limit failures and unknown receipts remain preserved; model retrospective is separate from external acceptance.

# 0.1.0-rc.2

- Reuse native DeepSeek account sign-in for direct HTTPS requests without a native model adapter; credentials remain outside payloads and receipts. Sign-out cancels in-flight work.
- Preserve legitimate empty Flash reasoning turns as explicit empty strings; retain sanitized accounting metadata when a completed stream is rejected.
- Add exact head/tail archive retrieval arguments and bounded tail previews to extractive checkpoints, with explicit continuation guidance.
- Apply the history trigger to newly accumulated exchanges; the complete resident request still obeys its absolute size limit.
- Return a definitive native `read` / `FS_NOT_FOUND` observation to the model so it can create a missing file. Permission errors, unknown writes and all other tool failures still stop execution.
- Add scoped real Flash 1017 acceptance and an uncompacted comparison; see the repository API audit for measured quality, cost and remaining limits.

The existing Web entry remains unchanged. This candidate is prepared locally; no public registry upload is performed.

# 0.1.0-rc.1

- Independent GPL-3.0-only DSH Bundle, disabled on installation until explicitly configured.
- Standalone native execution host and an API acceptance CLI with non-network preflight and explicit execution.
- Joint task/context submission, task-scoped direct HTTP/SSE and native tool execution.
- Extractive checkpoints, attempt-scoped original-source retrieval and safe pause/resume.
- Versioned task-graph workflow port with one authoritative joint ledger and commit notifications.
- Trusted host reconciliation closes stopped, unresolved attempts as UNSATISFIED without replay or synthetic success.
- Bounded checkpoint/archive storage and exact-plan collection of unreferenced interrupted-write leftovers.
- Recheck instruction membership between calls in one tool batch and retain reconciliation artifacts during collection.
- DeepSeek thinking/non-thinking controls, exact reasoning round trips, request IDs and streamed usage receipts.
- Optional versioned input-meter port; hard token budgets require an explicitly exact measurement of the actual request.

This is a release candidate. Automated acceptance uses a fake model and real execution services. Real DeepSeek API tuning and quality acceptance are pending. No production Web entry is replaced.

The independently supported route is direct. Native comparison remains optional development diagnostics requiring an external wire hook; a missing hook is rejected before task acquisition.
