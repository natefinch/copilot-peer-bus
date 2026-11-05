// Module hooks that resolve @github/copilot-sdk/extension to the fake SDK below.
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") {
        return { url: new URL("./fake-sdk.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
