// Minimal stand-in for the Copilot SDK's joinSession(), driven over the fork IPC channel.
// FAKE_SDK_CONFIRM=yes|no gives the session confirm dialogs that answer that way; unset, it has none.
export async function joinSession({ tools = [] } = {}) {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    process.on("message", async ({ callId, tool, args }) => {
        try {
            const result = await byName.get(tool).handler(args ?? {}, { sessionId: process.env.SESSION_ID });
            process.send({ type: "result", callId, result });
        } catch (error) {
            process.send({ type: "result", callId, error: error.message });
        }
    });
    queueMicrotask(() => process.send({ type: "joined", tools: tools.map((tool) => tool.name) }));
    const answer = process.env.FAKE_SDK_CONFIRM;
    return {
        capabilities: { ui: { elicitation: Boolean(answer) } },
        ui: {
            confirm: async (message) => {
                process.send({ type: "confirm", message });
                return answer === "yes";
            },
        },
        send: async ({ prompt }) => process.send({ type: "prompt", prompt }),
        log: async (message, options) => process.send({ type: "log", message, level: options?.level ?? "info" }),
    };
}
