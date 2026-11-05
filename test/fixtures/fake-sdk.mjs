// Minimal stand-in for the Copilot SDK's joinSession(), driven over the fork IPC channel.
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
    return {
        send: async ({ prompt }) => process.send({ type: "prompt", prompt }),
        log: async (message, options) => process.send({ type: "log", message, level: options?.level ?? "info" }),
    };
}
