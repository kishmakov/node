'use strict';

const assert = require('internal/assert');

const {
    IDS,
    isOnHost,
} = require('internal/worker/state');

const {
    logToFile,
    print,
} = require('internal/worker/utils');


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

// Object trackers (WeakMaps allow lookup of existing serialization handles)
let hostItemsTracker = new WeakMap();
let workerItemsTracker = new WeakMap();

// Actual stored objects by ID
let hostItems = new Map();
hostItems.set = function(key, value) {
    const valueStr = Object.values(IDS).includes(key) ? key.toUpperCase() : print(value);
    logToFile(`H: hostItems[${key}] := ${valueStr}`);
    return Map.prototype.set.call(this, key, value);
};

let workerItems = new Map();
workerItems.set = function(key, value) {
    logToFile(`W: workerItems[${key}] := ${print(value)}`);
    if (typeof value === 'object' && value !== null) {
        workerItemsTracker.set(value, key);
    }
    return Map.prototype.set.call(this, key, value);
};

function lookUpItem(compoundId, mustFind = true) {
    if (!compoundId) return undefined;
    const objects = isOnHost() ? hostItems : workerItems;
    const ids = compoundId.split('.');

    let result = objects.get(ids[0]);
    for (let i = 1; i < ids.length; i++) {
        if (!result) break;
        result = result[ids[i]];
    }

    if (mustFind) {
        const objectsStr = isOnHost() ? 'hostItems' : 'workerItems';
        assert(result !== undefined, `${objectsStr}[${compoundId}] not found\nstack: ${new Error().stack}\n`);
    }
    return result;
}

class ThreadCache {
    constructor(name) {
        this.name = name;
        this.proxies = new Map();
    }

    storeProxy(key, value) {
        assert(this.proxies.has(key) === false, `proxies@${this.name} already has key: ${key}`);
        logToFile(`proxies@${this.name}[${key}] := ${print(value)}`);
        this.proxies.set(key, value);
    }

    hasProxy(key) { return this.proxies.has(key); }
    getProxy(key) { return this.proxies.get(key); }
}

const hostCache = new ThreadCache('host');
const workerCache = new ThreadCache('worker');

function getCurrentCache() { return isOnHost() ? hostCache : workerCache; }

module.exports = {
    hostResolves,
    hostRejects,
    hostItemsTracker,
    hostItems,
    lookUpItem,
    workerItemsTracker,
    workerItems,
    getCurrentCache
};
