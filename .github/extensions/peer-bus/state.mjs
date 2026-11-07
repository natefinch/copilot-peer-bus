// Per-session state, stored under $COPILOT_HOME/peer-bus/sessions.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function peerBusDir(env = process.env) {
    return path.join(env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "peer-bus");
}

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error(`${file} is invalid: ${error.message}`);
    }
}

function writeJson(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, file);
}

export function sessionHash(sessionId) {
    return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16);
}

// Settings shared by all of this user's sessions, in $COPILOT_HOME/peer-bus/settings.json.
export class UserSettings {
    constructor(env = process.env) {
        this.file = path.join(peerBusDir(env), "settings.json");
    }

    // Reread on every call, since other sessions change the file. An unreadable file counts as empty.
    get(key) {
        try {
            return readJson(this.file)?.[key];
        } catch {
            return undefined;
        }
    }

    set(key, value) {
        let settings = null;
        try {
            settings = readJson(this.file);
        } catch {
            // Replace an unreadable file.
        }
        writeJson(this.file, { ...(settings && typeof settings === "object" ? settings : {}), [key]: value });
    }
}

export class SessionStore {
    constructor(sessionId, env = process.env) {
        this.file = path.join(peerBusDir(env), "sessions", `${sessionHash(sessionId)}.json`);
    }

    load() {
        const state = readJson(this.file);
        return state && typeof state === "object" ? state : null;
    }

    save(state) {
        writeJson(this.file, state);
    }

    clear() {
        rmSync(this.file, { force: true });
    }
}
