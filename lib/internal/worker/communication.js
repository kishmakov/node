'use strict';

const assert = require("internal/assert");

const {
    messageTypes: {
        H2W_CALL,
        W2H_CALL,
        W2H_PROMISE,
        W2H_SET,
        W2H_TYPE
    }
} = require('internal/worker/io');

const {
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
    const CODE_TO_ENTITY = { // see full list in v8/src/inspector/v8-debugger.h
          4: EntityType.NUMBER,
        101: EntityType.OBJECT,
        102: EntityType.FUNCTION,
        103: EntityType.CLASS,
    };

    if (!CODE_TO_ENTITY[result.code]) return;

    result.type = CODE_TO_ENTITY[result.code];
}

/////////////////////////////// Exported functions ///////////////////////////////

function asyncW2HType(port, id, serialize = false) {
    assert(typeof id === 'string', `W: asyncType called with nonstring id`);

    let callId = newCallId();

    sendMessage(port, W2H_TYPE, {id, callId, serialize});

    logToFile(`W: WaitType before id=${id} callId=${callId}`);
    const typeResult = WaitType(context.threadId, id, serialize);
    logToFile(`W: WaitType after, typeResult=${print(typeResult)}`);

    if (serialize) {
        assert('_as_json_str' in typeResult, 'W: typeResult was requested with _as_json_str');
        assert(typeof typeResult._as_json_str === 'string', 'W: _as_json_str must be a string');

        try {
            typeResult._as_json = JSON.parse(typeResult._as_json_str);
        } catch (e) {
            logToFile(`Failed to parse _as_json_str: ${e}`, true);
        }
    }

    mixInType(typeResult);
    return typeResult;
}

function asyncW2HCall(port, targetId, memberId, args, resultId) {
    assert(typeof targetId === 'string', `W: asyncCall called with non-string targetId`);
    assert(typeof memberId === 'string', `W: asyncCall called with non-string memberId`);

    let callId = newCallId();

    sendMessage(port, W2H_CALL, {callId, targetId, memberId, args, resultId, threadId: context.threadId});
    logToFile(`->${W2H_CALL} args=${print(args)}`);

    logToFile(`W: WaitCall before resultId=${resultId}`);
    const callResult = WaitCall(context.threadId, resultId);
    logToFile(`W: WaitCall after, callResult=${print(callResult)}`);

    mixInType(callResult);
    return callResult;
}

function rpcH2WCall(port, targetId, memberId, args, resultId, isAsync) {
    if (!context.isThreadPaused()) {
        sendMessage(port, H2W_CALL, {targetId, memberId, args, resultId, isAsync});
        logToFile(`->${H2W_CALL} args=${print(args)}`);
        return {type: EntityType.OBJECT};
    }

    const strArgs = JSON.stringify(args);
    logToFile(`RunOnPaused before targetId=${targetId} memberId=${memberId} resultId=${resultId}`);
    const callResult = RunOnPaused(context.destId, targetId, memberId, strArgs, resultId, isAsync);
    logToFile(`RunOnPaused after`);

    mixInType(callResult);
    return callResult;
}

function postW2HSet(port, targetId, propertyId, value) {
    sendMessage(port, W2H_SET, {targetId, propertyId, value});
}

function postW2HPromise(port, resolve, objectId, result) {
    sendMessage(port, W2H_PROMISE, {resolve, objectId, result});
}

function setCommunicationContext(threadContext) {
    context = threadContext;
    assert('threadId' in context, 'context.threadId must be present');
}

module.exports = {
    asyncW2HType,
    asyncW2HCall,
    rpcH2WCall,
    postW2HSet,
    postW2HPromise,
    setCommunicationContext,
};
