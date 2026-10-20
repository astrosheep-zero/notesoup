---
id: task/codex-子代理换窗恢复完整验收-c4e8
title: Codex 子代理换窗恢复完整验收
state: open
priority: 2
needs: []
parent: task/codex-plugin-完整接入-含子代理恢复验收-96a9
supersedes: []
relates: []
note: ""
createdAt: 2026-10-20T04:32:57.670Z
updatedAt: 2026-10-20T04:32:57.670Z
---
最终验收硬条件：root与所有支持的child路径换窗后，在恢复任务前能拿到fresh notesoup boot，任务和排队输入不丢，原生档案/seq不乱。当前Codex 0.160.1及已查HEAD跳过child SessionStart(compact/resume)；v2 InterAgentCommunication绕过UserPromptSubmit且direct appserver input受限。只做主会话不算完成。现阶段插件先开发，child PreCompact明确拒绝避免无恢复清空；此Task保持未完成。未批准patch用户Codex、切到v1/daemon限制、模型替代或上游发布。原elite研究被服务内容过滤终止，未换模型/渠道、无PoC通过证据。