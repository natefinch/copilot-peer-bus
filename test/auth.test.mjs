import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { startScopeFlow } from "../.github/extensions/peer-bus/auth.mjs";

// A spawn stand-in whose child prints `lines` to stderr, then exits with `status` once finish() is called.
function fakeGh({ lines = [], status = 0 } = {}) {
    const calls = [];
    let child;
    const spawn = (command, args, options) => {
        calls.push({ command, args, env: options.env });
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => child.emit("close", null);
        setImmediate(() => {
            for (const line of lines) child.stderr.write(line);
        });
        return child;
    };
    return { spawn, calls, finish: () => child.emit("close", status) };
}

const DEVICE_OUTPUT = ["\n! One-time code (250F-06CD) copied to clipboard\n", "Open this URL to continue in your web browser: https://github.com/login/device\n"];
const env = { GH_TOKEN: "app", GITHUB_TOKEN: "ci", PATH: "/bin" };

test("startScopeFlow refreshes the stored login without the env tokens and reports the code", async () => {
    const gh = fakeGh({ lines: DEVICE_OUTPUT });
    const flow = await startScopeFlow({ env, spawn: gh.spawn, run: async () => "tok-stored" });

    assert.deepEqual(gh.calls[0].args, ["auth", "refresh", "--hostname", "github.com", "--scopes", "notifications"]);
    assert.deepEqual(gh.calls[0].env, { PATH: "/bin" });
    assert.deepEqual([flow.code, flow.url, flow.copied], ["250F-06CD", "https://github.com/login/device", true]);
    gh.finish();
    await flow.done;
});

test("startScopeFlow logs in when gh has no stored login, and done rejects if gh fails", async () => {
    const gh = fakeGh({ lines: DEVICE_OUTPUT, status: 1 });
    const flow = await startScopeFlow({ env, spawn: gh.spawn, run: async () => null });

    assert.deepEqual(gh.calls[0].args, ["auth", "login", "--hostname", "github.com", "--scopes", "notifications", "--web"]);
    gh.finish();
    await assert.rejects(flow.done, /gh auth login failed: .*One-time code/s);
});

test("startScopeFlow rejects when gh exits without showing a code", async () => {
    const gh = fakeGh({ lines: ["error connecting to github.com\n"], status: 1 });
    const started = startScopeFlow({ env, spawn: gh.spawn, run: async () => "tok-stored" });
    setImmediate(() => setImmediate(gh.finish));
    await assert.rejects(started, /gh auth refresh failed: error connecting to github\.com/);
});
