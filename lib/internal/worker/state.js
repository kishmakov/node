'use strict';

const IDS = Object.freeze({
    CONTEXT: 'context',
    VSCODE: 'vscode',
    HOST: 'host',
    PROXY: {
        HOST: 'HProxyItemID',
        WORKER: 'WProxyItemID',
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

module.exports = {
    IDS,
    EntityType,
    TypeCode,
    setThreadId,
    getThreadId,
    isOnHost,
    newId,
    newCallId,
};
