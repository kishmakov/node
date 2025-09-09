'use strict';

const IDS = Object.freeze({
    CONTEXT: 'context',
    VSCODE: 'vscode',
    HOST: 'host',
    PROXY: {
        HOST: 'HProxyItemID',
        WORKER: 'WProxyItemID',
    },
    NEW: {
        ITEM: 'NewItemID',
        TYPE: 'NewType',
        MEMBER: 'NewMemberID',
        ASYNC: 'NewIsAsync',
    }
});

const EntityType = Object.freeze({
    OBJECT: 'OBJECT',
    CLASS: 'CLASS',
    FUNCTION: 'FUNCTION',
});

const TypeCode = Object.freeze({
    UNDEFINED: 0,
    NULL: 1,
    BOOLEAN: 2,
    STRING: 3,
    NUMBER: 4,
    OBJECT: 101,
    FUNCTION: 102,
    CLASS: 103,
    OTHER: 100,
});

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

class Context {
    constructor(port, cache) {
        this.port = port;
        this.cache = cache;
    }
}

module.exports = {
    IDS,
    EntityType,
    TypeCode,
    // class
    Context,
    // functions
    setThreadId,
    getThreadId,
    isOnHost,
    newId,
    newCallId,
};
