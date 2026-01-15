'use strict';

const assert = require('internal/assert');

const {Context} = require('internal/worker/context');
const {setCommunicationContext} = require("internal/worker/communication");
// const {setupProxyFunctionality} = require("internal/worker/proxy");
// const {setupSerializationFunctionality} = require("./serialization");
const {IDS, isFunction} = require("internal/worker/common");
const {syncHandler} = require("internal/worker/extension");

// Code below goes to communication/setup.js

let context = undefined;
const contexts = new Map(); // destId -> context

function setupEnvironment(port, threadId, destId) {
    const context = new Context(port, threadId, destId);
    global.context = context;

    assert(context && context.cache !== undefined, 'context.cache must be present');
    assert('isOnHost' in context, 'context.isOnHost must be present');
    assert(isFunction(context.newId), 'context.newId must be present');

    setCommunicationContext(context);
    // setupProxyFunctionality();
    // setupSerializationFunctionality();

    RegisterWorker(threadId, syncHandler);
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
