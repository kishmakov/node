'use strict';

const assert = require('assert');

const {Context} = require('./context');
const {setCommunicationContext} = require("./communication");
// const {setupProxyFunctionality} = require("./proxy");
// const {setupSerializationFunctionality} = require("./serialization");
const {isFunction} = require("./common");
const {syncHandler} = require("./extension");

// Code below goes to communication/setup.js

function setupEnvironment(port, threadId, destId) {
    const context = new Context(port, threadId, destId);
    global.context = context;

    assert(context && context.cache !== undefined, 'context.cache must be present');
    assert('isOnHost' in context, 'context.isOnHost must be present');
    assert(isFunction(context.newId), 'context.newId must be present');

    setCommunicationContext(context);
    setupProxyFunctionality();
    setupSerializationFunctionality();

    RegisterWorker(threadId, syncHandler);
}

module.exports = {
    setupEnvironment,
};
