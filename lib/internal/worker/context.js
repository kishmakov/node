'use strict';

const assert = require("internal/assert");

const {
    IDS,
    initLogFile
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

    getProxyHandle(arg) {
        if (arg !== null && (typeof arg === 'object' || typeof arg === 'function')) {
            const proxyIdKey = this.isOnHost ? IDS.PROXY.WORKER : IDS.PROXY.HOST;
            if (proxyIdKey in arg) return { [IDS.REPORTED]: arg[proxyIdKey] };
        }

        return null;
    }

    createProxyTag(id) {
        const proxyTagKey = this.isOnHost ? IDS.PROXY.WORKER : IDS.PROXY.HOST;
        return { [proxyTagKey]: id };
    }

    storeProxy(key, value) {
        assert(this.cache !== undefined, 'Context.storeProxy called before cache is set');
        const proxyTagKey = this.isOnHost ? IDS.PROXY.WORKER : IDS.PROXY.HOST
        assert([proxyTagKey] in value, `provided value for ${key} is not tagged as proxy`);
        this.cache.storeProxy(key, value);
    }

    getTracker(arg) {
        assert(this.cache !== undefined, 'Context.getTracker called before cache is set');
        if (!this.cache.hasTracked(arg)) return null;
        return this.cache.getTrackHandle(arg);
    }

    trackItem(value, tracker) {
        assert(this.cache !== undefined, 'Context.trackItem called before cache is set');
        this.cache.trackItem(value, tracker);
    }

    isThreadPaused() {
        return IsThreadPaused(this.destId);
    }

    shouldSkipPrimitives() {
        return this.isOnHost && !this.isThreadPaused();
    }
}

module.exports = {
    Context,
};
