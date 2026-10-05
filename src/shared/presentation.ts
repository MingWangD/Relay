import type { Agent, ApprovalPresentation } from "./types.ts";

export function agentStatusText(a: Agent): string {
  const labels: Partial<Record<Agent["status"], string>> = {
    error: "连接异常",
    stopped: "已停止",
    offline: "未连接",
    recovery: "等待恢复",
  };
  if (labels[a.status]) return labels[a.status]!;
  if (a.nativeError) return "模型连接异常";
  if (a.attention || a.status === "waiting") return "等待确认";
  if (a.status === "starting") return a.pid ? "已启动，等待会话确认" : "连接中";
  return a.status === "running" ? "执行中" : "空闲";
}

const tools: Record<string, string> = {
  get_project_state: "读取项目协作状态",
  send_message: "发送协作消息",
  ack_message: "确认协作消息",
  publish_plan: "更新团队计划",
  report_progress: "报告任务进度",
  submit_result: "提交任务成果",
  review_result: "提交评审结果",
  complete_request: "汇总需求结果",
  transfer_coordinator: "移交团队协调",
  ask_user: "向你询问需求",
};
export function approvalPresentation(
  method: string,
  detail: string,
): ApprovalPresentation {
  let p: any;
  try {
    p = JSON.parse(detail);
  } catch {
    return { title: "原生请求需要处理", fields: [], supported: false };
  }
  const fields: ApprovalPresentation["fields"] = [];
  const field = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim())
      fields.push({ label, value });
  };
  if (method === "mcpServer/elicitation/request") {
    const tool = /(?:tool\s+)["']([^"']+)["']/.exec(p.message ?? "")?.[1];
    const title = tool && tools[tool] ? tools[tool] : "使用协作工具";
    for (const entry of Array.isArray(p._meta?.tool_params_display)
      ? p._meta.tool_params_display
      : []) {
      field(entry.label ?? entry.name ?? "操作参数", entry.value);
    }
    return {
      title,
      description: p._meta?.tool_description ?? p.message,
      fields,
      supported:
        p.mode === "form" &&
        p.requestedSchema?.type === "object" &&
        !Object.keys(p.requestedSchema.properties ?? {}).length &&
        !p.requestedSchema.required?.length,
    };
  }
  field("原因", p.reason);
  if (method === "item/commandExecution/requestApproval") {
    field("命令", Array.isArray(p.command) ? p.command.join(" ") : p.command);
    field("工作目录", p.cwd);
    field("网络目标", p.networkApprovalContext?.host);
    return {
      title: p.networkApprovalContext ? "访问网络" : "执行命令",
      fields,
      supported: true,
    };
  }
  if (method === "item/fileChange/requestApproval") {
    field("涉及目录", p.grantRoot);
    if (Array.isArray(p.changes))
      for (const change of p.changes) field("涉及文件", change.path);
    else if (p.changes && typeof p.changes === "object")
      for (const path of Object.keys(p.changes)) field("涉及文件", path);
    return { title: "修改文件", fields, supported: true };
  }
  return {
    title: "原生请求需要处理",
    description:
      typeof p.message === "string" ? p.message : "请在原生终端查看具体操作。",
    fields,
    supported: false,
  };
}
