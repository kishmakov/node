'use strict';

const assert = require("internal/assert");
const path = require("path");
const fs = require("fs");


const {
    IDS,
    print,
} = require('internal/worker/common');

// Code below goes to communication/context.js

class ThreadCache {
    constructor(name) {
        this.name = name;
        this.tracker = new Map();
        this.items = new Map();
        this.proxies = new Map();
    }

    storeItem(key, value) {
        const specialIds = [IDS.VSCODE + '#', IDS.CONTEXT + '#'];
        const valueStr = specialIds.some(id => key.startsWith(id))  ? key.toUpperCase() : print(value);
        logToFile(`  items[${key}] := ${valueStr}`);
        this.items.set(key, value);
    }

    lookUpItem(compoundKey, mustFind = true) {
        if (!compoundKey) return undefined;
        const ids = compoundKey.split('.');

        let result = this.items.get(ids[0]);
        for (let i = 1; i < ids.length; i++) {
            if (!result) break;
            result = result[ids[i]];
        }

        if (mustFind && result === undefined) {
            const stack = new Error().stack;
            assert(false, `items@${this.name}[${compoundKey}] not found\nstack: ${stack}\n`);
        }

        return result;
    }

    trackItem(value, tag) {
        if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
            assert(this.tracker.has(value) === false, `tracker@${this.name} already tracks ${value}`);
            this.tracker.set(value, tag);
        }
    }

    getTracker(value) { return this.tracker.get(value); }
    hasTracker(value) { return this.tracker.has(value); }

    storeProxy(key, value) {
        assert(this.proxies.has(key) === false, `proxies@${this.name} already has key: ${key}`);
        this.proxies.set(key, value);
    }

    hasProxy(key) { return this.proxies.has(key); }
    getProxy(key) { return this.proxies.get(key); }
}

function logToPath(logPath, message, printStack = false) {
    const timeStamp = new Date().toISOString().slice(11, 23) + ' ';
    const trace = printStack ? new Error().stack.split('\n').slice(1).join('\n') + '\n' : '';
    fs.appendFileSync(logPath, timeStamp + message + '\n' + trace);
}

function initLogPath(threadId) {
    let logDir = '/home/kishmakov/.vscode-oss-dev/logs';
    if (process.env.ISOLATION_LOG_DIR && process.env.ISOLATION_LOG_DIR.length > 0) {
        logDir = process.env.ISOLATION_LOG_DIR;
    }

    return path.join(logDir, `log_${threadId}.txt`);
}

class Context {
    constructor(port, threadId, destId) {
        this.port = port;
        this.threadId = threadId;
        this.destId = destId;
        this.isOnHost = IDS.HOST === threadId;
        this.cache = new ThreadCache(threadId);
        this.logPath = initLogPath(threadId);
        global.logToFile = (...args) => logToPath(this.logPath, ...args);
    }

    newId() {
        return this.threadId + ':' + (++newIdCounter);
    }

    storeProxy(key, value) {
        assert(IDS.PROXY_TAG in value, `provided value for ${key} is not tagged as proxy`);
        this.cache.storeProxy(key, value);
    }

    getTracker(arg) {
        if (!this.cache.hasTracker(arg)) return null;
        logToFile(`getTracker(${print(arg)}) hit cache`);
        return this.cache.getTracker(arg);
    }

    trackItem(value, tracker) {
        this.cache.trackItem(value, tracker);
    }

    getItem(item) {
        return this.cache.lookUpItem(item);
    }

    getPaused() {
        // GetPaused is a V8 builtin only available in the patched runtime
        if (typeof GetPaused === 'undefined') return null;
        return GetPaused(this.isOnHost ? this.destId : this.threadId);
    }

    shouldSkipPrimitives() {
        // In test environment (no GetPaused), return true to match old mock behavior
        if (typeof GetPaused === 'undefined') return true;
        return this.isOnHost && !this.getPaused();
    }

    // We can perform synchronous calls when dst is waiting for us
    canSync() {
        return this.threadId === GetPaused(this.destId);
    }

    resolves = new Map();
    rejects = new Map();
}

module.exports = {
    Context,
};
