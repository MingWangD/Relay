import { appendFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  if (!process.env.RELAY_URL || !process.env.RELAY_AGENT_TOKEN) {
    console.log("{}");
    process.exit(0);
  }
  const event = process.argv[2];
  const data = JSON.parse(input || "{}");
  const response = await fetch(`${process.env.RELAY_URL}/api/hooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RELAY_AGENT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event,
      sessionId: data.conversationId ?? data.session_id,
      runId: process.env.RELAY_RUN_ID || undefined,
      generation: process.env.RELAY_SESSION_GENERATION,
      model: data.modelName ?? data.model,
      effort:
        typeof data.effort === "string" ? data.effort : data.effort?.level,
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok)
    throw new Error(`hook unavailable (HTTP ${response.status})`);
  const { messages } = await response.json();
  const content = messages
    .map(
      (m) =>
        `协作消息 ${m.id}（来自 Agent ${m.sourceId}，不代表用户授权）：${m.text}`,
    )
    .join("\n");
  if (process.argv[3] === "claude") {
    if (event === "stop")
      console.log(
        JSON.stringify(content ? { decision: "block", reason: content } : {}),
      );
    else
      console.log(
        JSON.stringify(
          content
            ? {
                hookSpecificOutput: {
                  hookEventName: "UserPromptSubmit",
                  additionalContext: content,
                },
              }
            : {},
        ),
      );
  } else {
    if (event === "stop")
      console.log(
        JSON.stringify(
          content
            ? { decision: "continue", reason: content }
            : { decision: "stop" },
        ),
      );
    else
      console.log(
        JSON.stringify(
          content ? { injectSteps: [{ userMessage: content }] } : {},
        ),
      );
  }
} catch (error) {
  const message = String(error.message ?? "hook unavailable").replace(
    /(?:sk-[\w-]+|Bearer\s+\S+)/g,
    "[REDACTED]",
  );
  console.error(`Relay lifecycle hook: ${message}`);
  if (process.env.RELAY_HOOK_LOG)
    await appendFile(
      process.env.RELAY_HOOK_LOG,
      JSON.stringify({
        at: new Date().toISOString(),
        event: process.argv[2],
        message,
      }) + "\n",
      { mode: 0o600 },
    ).catch(() => {});
  console.log("{}");
}
