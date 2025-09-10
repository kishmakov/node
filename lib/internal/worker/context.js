'use strict';

const {IDS} = require('internal/worker/common');

const newCallId = (function() {
    let counter = 0;
    return function() { return counter++; };
})();

let newIdCounter = 0; // module-level for uniqueness

class Context {
    constructor(port, id = IDS.HOST) {
        this.port = port;
        this.threadId = id.replace(/\./g, '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        this.isOnHost = IDS.HOST === id;
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
}

module.exports = {
    Context,
    newCallId,
};
