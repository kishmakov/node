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
    const CODE_TO_ENTITY = { // see full list in v8/src/inspector/v8-debugger.h
          4: EntityType.NUMBER,
        101: EntityType.OBJECT,
        102: EntityType.FUNCTION,
        103: EntityType.CLASS,
    };

    const typeId = getValueIfPresent(result, IDS.COMM.TYPE);
    if (!typeId || !CODE_TO_ENTITY[typeId]) return;

    result.type = CODE_TO_ENTITY[typeId];
}

/////////////////////////////// Exported functions ///////////////////////////////

function asyncW2HType(port, id, serialize = false) {
    assert(typeof id === 'string', `W: asyncType called with nonstring id`);
    assert(!context.isThreadPaused(), 'W: asyncType called while thread is paused');

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
    assert(!context.isThreadPaused(), 'W: asyncCall called while thread is paused');

    const payload = {
        callId: newCallId(), targetId, memberId, args, resultId, threadId: context.threadId
    };

    sendMessage(port, W2H_CALL, payload);
    logToFile(`->${W2H_CALL} args=${print(args)}`);

    logToFile(`W: WaitCall before resultId=${resultId}`);
    const callResult = WaitCall(context.threadId, resultId);
    logToFile(`W: WaitCall after, callResult=${print(callResult)}`);

    if (typeof callResult._as_json_str === 'string' && callResult._as_json_str.length > 0) {
        try {
            callResult._as_json = JSON.parse(callResult._as_json_str);
        } catch (e) {
            logToFile(`Failed to parse _as_json_str: ${e}`, true);
        }
    }

    mixInType(callResult);
    return callResult;
}

function postH2WCall(port, targetId, memberId, args, isAsync) {
    const resultId = context.newId();
    sendMessage(port, H2W_CALL, {targetId, memberId, args, resultId, isAsync});
    logToFile(`->${H2W_CALL} args=${print(args)}`);
    return {[IDS.COMM.RESULT]: resultId, isAsync: isAsync};
}

function v8H2WCall(targetId, memberId, args, isAsync) {
    logToFile(`RunOnPaused before targetId=${targetId} memberId=${memberId}`);
    const result = RunOnPaused(context.destId, targetId, memberId, args, isAsync);
    logToFile(`RunOnPaused after, result=${print(result)}`);
    result.isAsync = isAsync;
    return result;
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
    assert(typeof context.trackItem === 'function', 'context.trackItem is not a function');
}

module.exports = {
    asyncW2HType,
    asyncW2HCall,
    mixInType,
    postH2WCall,
    postW2HSet,
    postW2HPromise,
    setCommunicationContext,
    v8H2WCall,
};
