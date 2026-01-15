'use strict';

const assert = require('internal/assert');
const {getAPI, setAPI} = require("internal/util");

const {Context} = require('internal/worker/context');
const {setCommunicationContext} = require("internal/worker/communication");
const {setupProxyFunctionality} = require("internal/worker/proxy");
const {setSerializationContext} = require("internal/worker/serialization");
const {IDS, isFunction} = require("internal/worker/common");
const {syncHandler} = require("internal/worker/extension");

// Code below goes to communication/setup.js

const contexts = new Map(); // destId -> context

function setupEnvironment(port, threadId, destId) {
    if (contexts.has(destId)) {
        global.context = contexts.get(destId);
        setSerializationContext(global.context);
        setCommunicationContext(global.context);
        return;
    }

    global.assert = assert;

    // These ids are supposed to be the same on both sides
    const apiId = IDS.VSCODE + '#' + (threadId === IDS.HOST ? destId : threadId);
    const contextId = IDS.CONTEXT + '#' + (threadId === IDS.HOST ? destId : threadId);

    global.context = new Context(port, threadId, destId);

    RegisterWorker(threadId, syncHandler);
    contexts.set(destId, global.context);
    setSerializationContext(global.context);
    setCommunicationContext(global.context);
    setupProxyFunctionality();

    if (threadId === IDS.HOST) {
        global.context.cache.storeItem(apiId, getAPI(`h:vscode.${destId}`));
        global.context.cache.storeItem(contextId, getAPI(`h:context.${destId}`));
        const { _, resolve, reject } = getAPI(`h:promise.${destId}`);
        assert(!!resolve && !!reject, `h:promise.${destId} is not set`);
        global.context.resolves.set(IDS.ACTIVATION_RESULT, resolve);
        global.context.rejects.set(IDS.ACTIVATION_RESULT, reject);
    } else {
        setAPI('w:vscode', createProxyObjectForId(apiId));
        setAPI('w:context', createProxyObjectForId(contextId));
    }

    // const context = new Context(port, threadId, destId);
    // global.context = context;
    //
    // assert(context && context.cache !== undefined, 'context.cache must be present');
    // assert('isOnHost' in context, 'context.isOnHost must be present');
    // assert(isFunction(context.newId), 'context.newId must be present');
    //
    // setCommunicationContext(context);
    // // setupSerializationFunctionality();
    //
    // RegisterWorker(threadId, syncHandler);
}

function initWorker(port, id, filename) {
    setupEnvironment(port, id, IDS.HOST);
    logToFile(`Loading worker for ${filename}`);
    setInterval(() => { logToFile('W: Staying alive'); }, 15000);
    process.on('exit', () => {
        logToFile(`failed to keep worker for ${id} alive`);
    });
}

function prepareHost(port, id) {
    setupEnvironment(port, IDS.HOST, id);
    if (contexts.size > 1) logToFile(`---- context is set for destId=${id} ----`);
}

module.exports = {
    setupEnvironment,
    initWorker,
    prepareHost,
};
