'use strict';

const assert = require('internal/assert');
const {getAPI, setAPI} = require("internal/util");

const {Context} = require('internal/worker/context');
const {setupCommunicationFunctionality} = require("internal/worker/communication");
const {setupProxyFunctionality} = require("internal/worker/proxy");
const {setupSerializationFunctionality} = require("internal/worker/serialization");
const {IDS, isFunction} = require("internal/worker/common");
const {syncHandler} = require("internal/worker/extension");

// Code below goes to communication/setup.js

const contexts = new Map(); // destId -> context

function setupEnvironment(port, threadId, destId) {
    if (contexts.has(destId)) {
        global.context = contexts.get(destId);
        return;
    } else {
        global.context = new Context(port, threadId, destId);
        contexts.set(destId, global.context);
    }

    // Repetitive idempotent setup
    global.assert = assert;
    RegisterWorker(threadId, syncHandler);

    setupCommunicationFunctionality();
    setupProxyFunctionality();
    setupSerializationFunctionality();
}

function initWorker(port, id, filename) {
    setupEnvironment(port, id, IDS.HOST);
    const vscId = IDS.VSCODE + '#' + id;
    const ctxId = IDS.CONTEXT + '#' + id;
    setAPI('w:vscode', createProxyObjectForId(vscId));
    setAPI('w:context', createProxyObjectForId(ctxId));
    logToFile(`---- [${new Date().toISOString()}] worker is set for ${filename} ----`);
    setInterval(() => { logToFile('W: Staying alive'); }, 15000);
    process.on('exit', () => {
        logToFile(`failed to keep worker for ${id} alive`);
    });
}

function prepareHost(port, wd) {
    if (!wd.id) return false;
    setupEnvironment(port, IDS.HOST, wd.id);

    const vscId = IDS.VSCODE + '#' + wd.id;
    const ctxId = IDS.CONTEXT + '#' + wd.id;

    setAPI(`h:vscode.${wd.id}`, (vsc) => context.cache.storeItem(vscId, vsc));
    setAPI(`h:context.${wd.id}`, (ctx) => context.cache.storeItem(ctxId, ctx));

    let resolve, reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });

    context.resolves.set(IDS.ACTIVATION_RESULT, resolve);
    context.rejects.set(IDS.ACTIVATION_RESULT, reject);
    setAPI(`h:promise.${wd.id}`, promise);

    logToFile(`---- [${new Date().toISOString()}] context is set for destId=${wd.id} ----`);
    return true;
}

const logToHostLog = (message) => logToFile(message);

module.exports = {
    logToHostLog,
    initWorker,
    prepareHost,
    setupEnvironment
};
