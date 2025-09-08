'use strict';

// Shared state for internal worker extension logic.
// Moved from extension.js to centralize mutable cross-module data structures.

const { logToFile, print } = require('internal/worker/utils');
const assert = require('internal/assert');

// Thread / context identifiers
const IDS = {
    CONTEXT: 'context',
    VSCODE: 'vscode',
    HOST: 'host',
    PROXY: {
        HOST: 'HProxyItemID',
        WORKER: 'WProxyItemID',
    }
};

// Current thread id (default host)
let threadId = IDS.HOST;
function setThreadId(id) { threadId = id; }
function getThreadId() { return threadId; }
function isOnHost() { return IDS.HOST === threadId; }

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

// Proxies caches (avoid recreating proxies for same IDs)
let workerProxies = new Map();
workerProxies.set = function(key, value) {
    assert(Map.prototype.has.call(this, key) === false, 'workerProxies already has key: ' + key);
    logToFile(`H: workerProxies[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

let hostProxies = new Map();
hostProxies.set = function(key, value) {
    assert(Map.prototype.has.call(this, key) === false, 'hostProxies already has key: ' + key);
    logToFile(`W: hostProxies[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

// ID generators kept in state so closures are shared
const newId = (function() {
    let counter = 0;
    return function() { return threadId + ':' + counter++; };
})();

const newCallId = (function() {
    let counter = 0;
    return function() { return counter++; };
})();

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

function getProxyHandle(arg) {
    if (arg !== null && (typeof arg === 'object' || typeof arg === 'function')) {
        const proxyIdKey = isOnHost() ? IDS.PROXY.WORKER : IDS.PROXY.HOST;
        if (proxyIdKey in arg) return { ReportedItemID: arg[proxyIdKey] };
    }

    return null;
}

function createProxyTag(id) {
    const proxyTagKey = isOnHost() ? IDS.PROXY.WORKER : IDS.PROXY.HOST;
    return { [proxyTagKey]: id };
}

module.exports = {
    IDS,
    setThreadId,
    getThreadId,
    isOnHost,
    hostResolves,
    hostRejects,
    hostItemsTracker,
    hostItems,
    lookUpItem,
    workerItemsTracker,
    workerItems,
    workerProxies,
    hostProxies,
    newId,
    newCallId,
    getProxyHandle,
    createProxyTag,
};
