'use strict';

const {IDS} = require('internal/worker/common');

let threadId = IDS.HOST;
function setThreadId(id) { threadId = id; }
function getThreadId() { return threadId; }
function isOnHost() { return IDS.HOST === threadId; }

const newId = (function() {
    let counter = 0;
    return function() { return threadId + ':' + counter++; };
})();

const newCallId = (function() {
    let counter = 0;
    return function() { return counter++; };
})();

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

class Context {
    constructor(port, cache) {
        this.port = port;
        this.cache = cache;
    }
}

module.exports = {
    // class
    Context,
    // functions
    createProxyTag,
    getProxyHandle,
    setThreadId,
    getThreadId,
    isOnHost,
    newId,
    newCallId,
};
