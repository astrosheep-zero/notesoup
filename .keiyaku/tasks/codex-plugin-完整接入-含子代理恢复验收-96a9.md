---
id: task/codex-plugin-完整接入-含子代理恢复验收-96a9
title: Codex plugin 完整接入（含子代理恢复验收）
state: in_progress
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-10-20T04:29:37.187Z
updatedAt: 2026-10-20T06:03:32.242Z
---
用户批准先开发插件，完整验收后置；接受原生 token_budget/new_context/get_context_remaining。可安装阶段已通过独立review并集成：自包含插件、5notes+3history、root boot/native reset/budget接线、当前元数据与原生窗口一致性检查、复制安装包独立运行。类型检查、全套测试、打包检查通过。未安装到用户Codex、未修改其配置、未发布、未验证真实host/model循环。最终child恢复仍为未完成硬缺口；现阶段child PreCompact明确拒绝以免无boot清空，不能把阶段交付当总体完成。后续由child验收子Task继续：要求全部支持的child compact/resume boot闭环，不擅自patch用户Codex或改mode。