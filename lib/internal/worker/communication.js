'use strict';

const assert = require("internal/assert");

const {
    messageTypes: {
        H2W_CALL,
        W2H_CALL,
        W2H_PROMISE,
        W2H_SET,
        W2H_TYPE,
        W2H_UPDATE,
    }
} = require('internal/worker/io');

const {
    IDS,
    getValueIfPresent,
    logToFile,
    print,
    printMessage,
} = require('internal/worker/common');

const {EntityType} = require("internal/worker/serialization");

let context = null;

const newCallId = (function() {
    let counter = 0;
    return function() { return counter++; };
})();

function sendMessage(port, type, payload) {
    try {
        const message = { type, ...payload }
        port.postMessage(message);
        logToFile('->' + printMessage(message));
    } catch (e) {
        logToFile(`postMessage ${type} failed: ${e}`, true);
    }
}

function mixInType(result) {
    const CODE_TO_TYPE = { // see full list in v8/src/inspector/v8-debugger.h
          4: EntityType.NUMBER,
        101: EntityType.OBJECT,
        102: EntityType.FUNCTION,
        103: EntityType.CLASS,
    };

    const typeId = getValueIfPresent(result, IDS.COMM.TYPE);
    return (!typeId || !CODE_TO_TYPE[typeId]) ? EntityType.OBJECT : CODE_TO_TYPE[typeId];
}

/////////////////////////////// Exported functions ///////////////////////////////

function asyncW2HType(port, id, serialize = false) {
    assert(typeof id === 'string', `W: asyncType called with nonstring id`);
    if (context.isThreadPaused()) {
        logToFile(`failed to call asyncType on non-paused thread id=${id}`, true)
        return undefined;
    }

    let callId = newCallId();

    sendMessage(port, W2H_TYPE, {id, callId, serialize});

    logToFile(`W: WaitType before id=${id} callId=${callId}`);
    const typeResult = WaitType(context.threadId, id, callId, serialize);
    logToFile(`W: WaitType after, typeResult=${print(typeResult)}`);

    if (serialize) {
        assert(IDS.COMM.JSON in typeResult, `W: typeResult was requested with ${IDS.COMM.JSON}`);
        assert(typeof typeResult[IDS.COMM.JSON] === 'string', 'W: _as_json_str must be a string');

        try {
            typeResult._as_json = JSON.parse(typeResult[IDS.COMM.JSON]);
        } catch (e) {
            logToFile(`Failed to parse ${IDS.COMM.JSON}: ${e}`, true);
        }
    }

    typeResult.type = mixInType(typeResult);
    return typeResult;
}

function postW2HCall(port, targetId, memberId, args, resultId) {
    assert(typeof targetId === 'string', `W: postW2HCall called with non-string targetId`);
    assert(typeof memberId === 'string', `W: postW2HCall called with non-string memberId`);

    const payload = {
        callId: newCallId(), targetId, memberId, args, resultId, threadId: context.threadId
    };

    sendMessage(port, W2H_CALL, payload);
    logToFile(`->${W2H_CALL} args=${print(args)}`);
}

function postH2WCall(port, targetId, memberId, args, isAsync, resultId) {
    assert(typeof targetId === 'string', `postH2WCall called with non-string targetId`);
    sendMessage(port, H2W_CALL, {targetId, memberId, args, resultId, isAsync});
    logToFile(`->${H2W_CALL} args=${print(args)}`);
}

function v8H2WCall(targetId, memberId, args, isAsync) {
    assert(typeof targetId === 'string', `v8H2WCall called with non-string targetId`);
    logToFile(`RunOnPaused before targetId=${targetId} memberId=${memberId}`);
    const result = RunOnPaused(context.destId, targetId, memberId, args, isAsync);
    logToFile(`RunOnPaused after, result=${print(result)}`);
    return result;
}

// Execute a type request on a paused worker thread. The paused side will
// detect empty memberId and treat args as the `serialize` flag.
// TODO: check validity
function v8H2WType(id, serialize = false) {
    assert(typeof id === 'string', `v8H2WType called with non-string id`);
    logToFile(`RunOnPaused(Type) before id=${id} serialize=${serialize}`);
    // Pass empty memberId to signal a type request; args carries serialize flag as JSON string.
    const result = RunOnPaused(context.destId, id, '', JSON.stringify(serialize), false);
    logToFile(`RunOnPaused(Type) after, result=${print(result)}`);
    return result;
}

function postW2HSet(port, targetId, propertyId, value) {
    sendMessage(port, W2H_SET, {targetId, propertyId, value});
}

function postW2HPromise(port, resolve, objectId, result) {
    sendMessage(port, W2H_PROMISE, {resolve, objectId, result});
}

function postW2HUpdate(port, targetId, value) {
    sendMessage(port, W2H_UPDATE, {targetId, value});
}

function setCommunicationContext(threadContext) {
    context = threadContext;
    assert('threadId' in context, 'context.threadId must be present');
    assert(typeof context.trackItem === 'function', 'context.trackItem is not a function');
}

module.exports = {
    asyncW2HType,
    mixInType,
    postH2WCall,
    postW2HCall,
    postW2HSet,
    postW2HPromise,
    postW2HUpdate,
    setCommunicationContext,
    v8H2WCall,
    v8H2WType,
};
