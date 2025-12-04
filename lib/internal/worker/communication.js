'use strict';

const assert = require("internal/assert");

const {
    messageTypes: {
        ANY_TYPE,
        H2W_CALL,
        W2H_CALL,
        W2H_PROMISE,
        W2H_SET,
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

const {EntityType, serializeArguments} = require("internal/worker/serialization");

let context = null;

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

function asyncH2WCall(port, targetId, memberId, args, isAsync, resultId) {
    sendMessage(port, H2W_CALL, {targetId, memberId, args, resultId, isAsync});
    logToFile(`->${H2W_CALL} args=${print(args)}`);
    return {[IDS.COMM.RESULT]: resultId};
}

function syncH2WCall(_, targetId, memberId, args, isAsync, resultId) {
    const callId = context.newId();
    logToFile(`RunSync before callId=${callId} targetId=${targetId} memberId=${memberId} args=${print(args)}`);
    const result = RunSync(context.destId, callId, H2W_CALL, targetId, memberId, args, isAsync, false, resultId);
    logToFile(`RunSync after callId=${callId} result=${print(result)}`);
    return result;
}

function asyncW2HType(port, callId, targetId, serialize) {
    const coord = `callId=${callId} targetId=${targetId} serialize=${serialize}`;
    sendMessage(port, ANY_TYPE, {targetId, callId, serialize, threadId: context.threadId});
    logToFile(`W: WaitType before ${coord}`);
    const typeResult = WaitType(context.destId, callId, targetId, serialize);

    if (!typeResult) {
        logToFile(`W: WaitType failed to locate result ${coord}`, true);
        return undefined;
    }

    logToFile(`W: WaitType after, typeResult=${print(typeResult)}`);
    return typeResult;
}

function syncType(_, callId, targetId, serialize) {
    const coord = `callId=${callId} targetId=${targetId} serialize=${serialize}`;
    logToFile(`RunSync before ${coord}`);
    const result = RunSync(context.destId, callId, ANY_TYPE, targetId, null, null, false, serialize, null);
    logToFile(`RunSync after ${coord}`);
    return result;
}

/////////////////////////////// Exported functions ///////////////////////////////

function anyH2WCall(port, targetId, memberId, args, isAsync) {
    assert(typeof targetId === 'string', `failed targetId != string @ anyH2WCall`);
    const delegate = context.canSync() && !isAsync ? syncH2WCall : asyncH2WCall;
    return delegate(port, targetId, memberId, args, isAsync, context.newId());
}

function anyType(port, targetId, serialize = false) {
    assert(typeof targetId === 'string', `failed targetId != string @ anyType`);

    const delegate = context.canSync() ? syncType : asyncW2HType;
    const typeResult = delegate(port, context.newId(), targetId, serialize);

    if (serialize) {
        assert(IDS.COMM.JSON in typeResult, `W: failed to parse ${IDS.COMM.JSON} from typeResult`);
        assert(typeof typeResult[IDS.COMM.JSON] === 'string', `W: failed to get typeResult[${IDS.COMM.JSON}] as string`);

        try {
            typeResult._as_json = JSON.parse(typeResult[IDS.COMM.JSON]);
        } catch (e) {
            logToFile(`Failed to parse ${IDS.COMM.JSON}: ${e}`, true);
        }
    }

    typeResult.type = mixInType(typeResult);
    return typeResult;
}

function postW2HCall(port, callId, targetId, memberId, args, resultId) {
    assert(typeof targetId === 'string', `failed: targetId != string @ postW2HCall`);
    assert(!memberId || typeof memberId === 'string', `failed: memberId != string @ postW2HCall`);

    const payload = {
        callId, targetId, memberId, args, resultId, threadId: context.threadId
    };

    sendMessage(port, W2H_CALL, payload);
    logToFile(`->${W2H_CALL} args=${print(args)}`);

    return callId;
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
    anyH2WCall,
    anyType,
    mixInType,
    postW2HCall,
    postW2HSet,
    postW2HPromise,
    postW2HUpdate,
    setCommunicationContext,
};
