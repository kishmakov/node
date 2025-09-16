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
    printMessage
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
    if (result.code === TypeCode.OBJECT) result.type = EntityType.OBJECT;
    else if (result.code === TypeCode.FUNCTION) result.type = EntityType.FUNCTION;
    else if (result.code === TypeCode.CLASS) result.type = EntityType.CLASS;
}

/////////////////////////////// Exported functions ///////////////////////////////

const TypeCode = Object.freeze({
    UNDEFINED: 0, NULL: 1, BOOLEAN: 2, STRING: 3, NUMBER: 4,
    OBJECT: 101, FUNCTION: 102, CLASS: 103,
    OTHER: 1000,
});

function asyncW2HType(port, id) {
    assert(typeof id === 'string', `W: asyncType called with nonstring id`);

    let callId = newCallId();

    sendMessage(port, W2H_TYPE, { id, callId });

    logToFile(`W: WaitType before id=${id} callId=${callId}`);
    const typeResult = WaitType(id);
    logToFile(`W: WaitType after, typeResult=${print(typeResult)}`);

    mixInType(typeResult);
    return typeResult;
}

function asyncW2HCall(port, targetId, memberId, args, resultId) {
    assert(typeof targetId === 'string', `W: asyncCall called with non-string targetId`);
    assert(typeof memberId === 'string', `W: asyncCall called with non-string memberId`);

    let callId = newCallId();

    sendMessage(port, W2H_CALL, { callId, targetId, memberId, args, resultId, threadId: context.threadId });
    logToFile(`->${W2H_CALL} args=${print(args)}`);

    logToFile(`W: WaitCall before resultId=${resultId}`);
    const callResult = WaitCall(resultId, context.threadId);
    logToFile(`W: WaitCall after, callResult=${print(callResult)}`);

    mixInType(callResult);
    return callResult;
}

function postH2WCall(port, targetId, memberId, args, resultId, isAsync) {
    sendMessage(port, H2W_CALL, { targetId, memberId, args, resultId, isAsync });
    logToFile(`->${H2W_CALL} args=${print(args)}`);
}

// Host <- Worker: set property on host object
function postW2HSet(port, targetId, propertyId, value) {
    sendMessage(port, W2H_SET, { targetId, propertyId, value });
}

// Host <- Worker: resolve/reject a promise created on host side
function postW2HPromise(port, resolve, objectId, result) {
    sendMessage(port, W2H_PROMISE, { resolve, objectId, result });
}

function setCommunicationContext(threadContext) {
    context = threadContext;
    assert('threadId' in context, 'context.threadId must be present');
}

module.exports = {
    TypeCode,
    asyncW2HType,
    asyncW2HCall,
    postH2WCall,
    postW2HSet,
    postW2HPromise,
    setCommunicationContext,
};
