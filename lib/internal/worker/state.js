'use strict';

const IDS = {
    CONTEXT: 'context',
    VSCODE: 'vscode',
    HOST: 'host',
    PROXY: {
        HOST: 'HProxyItemID',
        WORKER: 'WProxyItemID',
    }
};

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
    setThreadId,
    getThreadId,
    isOnHost,
    newId,
    newCallId,
};
