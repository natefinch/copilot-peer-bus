// Adds the notifications scope to the GitHub CLI's stored login with gh's device flow: gh shows a one-time
// code, the person enters it on github.com, and gh saves the new token, which the extension then rereads.

import { spawn as nodeSpawn } from "node:child_process";

import { ghAuthToken, withoutEnvTokens } from "./github.mjs";

const CODE = /one-time code[^A-Z0-9]*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const DEVICE_URL = /https:\/\/\S+\/login\/device\b/;
// gh gives up when the code expires after 15 minutes; this only guards against a hung gh.
const MAX_FLOW_MS = 20 * 60_000;

// Starts gh's device flow, without GH_TOKEN and GITHUB_TOKEN (gh won't refresh its stored login while they
// are set). Refreshes the stored login, or creates one if gh has none. Resolves once gh shows its code to
// { code, url, copied, done }: copied is whether gh put the code on the clipboard, and done resolves when gh
// has saved the new token (rejecting if the person doesn't finish or gh fails).
export async function startScopeFlow({ env = process.env, spawn = nodeSpawn, run = ghAuthToken } = {}) {
    const ghEnv = withoutEnvTokens(env);
    const args = (await run(ghEnv))
        ? ["auth", "refresh", "--hostname", "github.com", "--scopes", "notifications"]
        : ["auth", "login", "--hostname", "github.com", "--scopes", "notifications", "--web"];
    return new Promise((resolve, reject) => {
        let finish;
        const done = new Promise((ok, fail) => (finish = { ok, fail }));
        done.catch(() => {}); // callers that stop at the code don't await done
        let output = "";
        let shown = false;
        const child = spawn("gh", args, { env: ghEnv, stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => child.kill(), MAX_FLOW_MS);
        timer.unref?.();
        const read = (data) => {
            output += data;
            const code = CODE.exec(output)?.[1];
            const url = DEVICE_URL.exec(output)?.[0];
            if (shown || !code || !url) return;
            shown = true;
            resolve({ code, url, copied: /copied to clipboard/i.test(output), done });
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        child.on("error", (error) => {
            clearTimeout(timer);
            const failure = new Error(error.code === "ENOENT" ? "The GitHub CLI (gh) isn't installed; install it from https://cli.github.com/." : `Could not run gh: ${error.message}`);
            reject(failure);
            finish.fail(failure);
        });
        child.on("close", (status) => {
            clearTimeout(timer);
            if (status === 0 && shown) return finish.ok();
            const failure = new Error(`gh auth ${args[1]} failed: ${output.trim() || `exit status ${status}`}`);
            reject(failure);
            finish.fail(failure);
        });
    });
}

// Opens url in the default browser, ignoring failures (the URL is also shown to the person).
export function openInBrowser(url, { platform = process.platform, spawn = nodeSpawn } = {}) {
    const [command, args] =
        platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    try {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
    } catch {
        // Nothing to do: the person can open the URL themselves.
    }
}
