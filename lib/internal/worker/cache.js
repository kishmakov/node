'use strict';

const assert = require('internal/assert');

const {
    IDS,
    logToFile,
    print,
} = require('internal/worker/common');

// Promise resolution maps (host side)
let hostResolves = new Map();
hostResolves.set = function(key, value) {
    logToFile(`H: hostResolves[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

let hostRejects = new Map();
hostRejects.set = function(key, value) {
    logToFile(`H: hostRejects[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

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
        logToFile(`   items[${key}] := ${valueStr}`);
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

    trackItem(value, info) {
        if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
            assert(this.tracker.has(value) === false, `tracker@${this.name} already tracks ${value}`);
            this.tracker.set(value, info);
        }
    }

    getTrackedInfo(value) { return this.tracker.get(value); }
    hasTracked(value) { return this.tracker.has(value); }

    storeProxy(key, value) {
        assert(this.proxies.has(key) === false, `proxies@${this.name} already has key: ${key}`);
        logToFile(`   proxies[${key}] := ${value.type}`);
        this.proxies.set(key, value);
    }

    hasProxy(key) { return this.proxies.has(key); }
    getProxy(key) { return this.proxies.get(key); }
}

function installCache(context) {
    context.cache = new ThreadCache(context.isOnHost ? 'host' : 'worker');
    logToFile(`==cache installed threadId=${context.threadId} destId=${context.destId}`);
}

module.exports = {
    hostResolves,
    hostRejects,
    installCache,
};
