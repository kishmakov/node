'use strict';

const assert = require('internal/assert');
const {setAPI} = require("internal/util");

const {IDS, printMessage} = require("internal/worker/common");
const {Context} = require('internal/worker/context');
const {setupCommunicationFunctionality} = require("internal/worker/communication");
const {setupProxyFunctionality} = require("internal/worker/proxy");
const {setupSerializationFunctionality} = require("internal/worker/serialization");
const {asyncHandler, syncHandler} = require("internal/worker/extension");

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

const REQ_TYPES_SET = new Set(Object.values(IDS.REQ_TYPES));

function tryProcessMessage(message) {
    if (!REQ_TYPES_SET.has(message.type)) return false;

    try {
        logToFile('<-' + printMessage(message));
        asyncHandler(message);
        return true;
    } catch (e) {
        const msg = JSON.stringify(message);
        logToFile(`tryProcessMessage failed: message=${msg}\n:> ${e}\n:> stack: ${e.stack}`)
    }

    return false;
}

function resolveActivationResult(res) {
    context.cache.storeItem(IDS.ACTIVATION_RESULT, res);
    anyPromise(context.port, IDS.ACTIVATION_RESULT, true, res);
}

module.exports = {
    logToHostLog,
    initWorker,
    prepareHost,
    resolveActivationResult,
    setupEnvironment,
    tryProcessMessage,
};
