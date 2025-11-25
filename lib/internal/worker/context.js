'use strict';

const assert = require("internal/assert");

const {
    IDS,
    initLogFile,
    logToFile,
    print,
} = require('internal/worker/common');

let newIdCounter = 0; // module-level for uniqueness

class Context {
    constructor(port, threadId, destId) {
        this.port = port;
        this.threadId = threadId;
        this.destId = destId;
        this.isOnHost = IDS.HOST === threadId;

        initLogFile(this.threadId);
    }

    newId() {
        return this.threadId + ':' + (newIdCounter++);
    }

    proxyTagKey() {
        return this.isOnHost ? IDS.PROXY.WORKER : IDS.PROXY.HOST;
    }

    storeProxy(key, value) {
        assert(this.cache !== undefined, 'Context.storeProxy called before cache is set');
        const proxyTagKey = this.isOnHost ? IDS.PROXY.WORKER : IDS.PROXY.HOST
        assert([proxyTagKey] in value, `provided value for ${key} is not tagged as proxy`);
        this.cache.storeProxy(key, value);
    }

    getTracker(arg) {
        assert(this.cache !== undefined, 'Context.getTracker called before cache is set');
        if (!this.cache.hasTracker(arg)) return null;
        logToFile(`getTracker(${print(arg)}) hit cache`);
        return this.cache.getTracker(arg);
    }

    trackItem(value, tracker) {
        assert(this.cache !== undefined, 'Context.trackItem called before cache is set');
        this.cache.trackItem(value, tracker);
    }

    getPaused() {
        return GetPaused(this.isOnHost ? this.destId : this.threadId);
    }

    shouldSkipPrimitives() {
        return this.isOnHost && !this.getPaused();
    }
}

module.exports = {
    Context,
};
