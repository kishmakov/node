'use strict';

const {
    IDS,
    getValueIfPresent,
    print,
    printMessage,
} = require('internal/worker/common');

const {
    H2W_CALL,
    W2H_CALL,
    W2H_UPDATE,
    ANY_TYPE,
    ANY_SET,
    ANY_PROMISE,
} = IDS.REQ_TYPES;

const {
    EntityType,
    safeParse,
    serializeArguments
} = require("internal/worker/serialization");

function mixInType(result) {
    const CODE_TO_TYPE = { // see full list in v8/src/inspector/v8-debugger.h
          4: EntityType.NUMBER,
        100: EntityType.OBJECT,
        101: EntityType.ARRAY,
        110: EntityType.FUNCTION,
        111: EntityType.CLASS,
    };

    const typeId = getValueIfPresent(result, IDS.COMM.TYPE);
    return (!typeId || !CODE_TO_TYPE[typeId]) ? EntityType.OBJECT : CODE_TO_TYPE[typeId];
}

function postW2HUpdate(port, targetId, value) {
    sendMessage(port, W2H_UPDATE, {targetId, value});
}

function asyncH2WCall(port, callId, targetId, memberId, args, isAsync) {
    sendMessage(port, H2W_CALL, {targetId, callId, memberId, args, isAsync});
    logToFile(`->${H2W_CALL} args=${print(args)}`);
    return {[IDS.COMM.CALL]: callId};
}

function syncH2WCall(_port, callId, targetId, memberId, args, isAsync) {
    assert(!args || typeof args === 'string', 'failed: args != string @ syncH2WCall');
    const coord = `callId=${callId} targetId=${targetId} memberId=${memberId}`;
    logToFile(`syncH2WCall before RunSync ${coord}`);
    const result = RunSync(context.destId, callId, H2W_CALL, targetId, memberId, args, isAsync, false);
    logToFile(`syncH2WCall after RunSync ${coord} result=${print(result)}`);
    return result;
}

// function asyncW2HType(port, callId, targetId, serialize) {
//     const coord = `callId=${callId} targetId=${targetId} serialize=${serialize}`;
//     sendMessage(port, ANY_TYPE, {targetId, callId, serialize, threadId: context.threadId});
//     logToFile(`asyncW2HType.1/2 before WaitType ${coord}`);
//     const typeResult = WaitType(context.destId, callId, targetId);
//
//     if (!typeResult) {
//         logToFile(`asyncW2HType.2/2 WaitType failed ${coord}`, true);
//         return undefined;
//     }
//
//     logToFile(`asyncW2HType.2/2 after WaitType ${coord} result=${print(typeResult)}`);
//     return typeResult;
// }

// function asyncW2HType(port, callId, targetId) {
//     sendMessage(port, ANY_TYPE, {targetId, callId});
//     const result = WaitCall(context.destId, callId, targetId);
//     if (!result) logToFile(`WaitCall failed result=${result}`, true);
//     return result;
// }
//
// function syncType(_port, callId, targetId, serialize) {
//     const coord = `callId=${callId} targetId=${targetId} serialize=${serialize}`;
//     logToFile(`syncType before RunSync ${coord}`);
//     const result = RunSync(context.destId, callId, ANY_TYPE, targetId, null, null, false, serialize, null);
//     logToFile(`syncType after RunSync ${coord}`);
//     return result;
// }
//
// function syncW2HCall(_port, callId, targetId, memberId, args, isAsync) {
//     const coord = `callId=${callId} targetId=${targetId} memberId=${memberId}`;
//     logToFile(`syncW2HCall before RunSync ${coord}`);
//     const result = RunSync(context.destId, callId, W2H_CALL, targetId, memberId, args, isAsync, false);
//     logToFile(`syncW2HCall after RunSync ${coord}, result=${print(result)}`);
//     return result;
// }
//
// function asyncW2HCall(port, callId, targetId, memberId, args, _isAsync) {
//     assert(!memberId || typeof memberId === 'string', `failed: memberId != string @ postW2HCall`);
//     const coord = `callId=${callId} targetId=${targetId} memberId=${memberId}`;
//     logToFile(`asyncW2HCall.1/3 ${coord}`);
//     sendMessage(port, W2H_CALL, {
//         callId, targetId, memberId, args, threadId: context.threadId
//     });
//     logToFile(`asyncW2HCall.2/3 before WaitCall ${coord}`);
//     const result = WaitCall(context.destId, callId, targetId);
//     if (!result) {
//         logToFile(`asyncW2HCall.3/3 WaitCall failed ${coord}`, true);
//         return undefined;
//     }
//
//     logToFile(`asyncW2HCall.3/3 after WaitCall ${coord} result=${print(result)}`);
//     return result;
// }

// function anyH2WCall(port, targetId, memberId, isAsync, args) {
//     assert(typeof targetId === 'string', `failed targetId != string @ anyH2WCall`);
//     const serArgs = serializeArguments(port, postW2HUpdate, args);
//     const delegate = context.canSync() && !isAsync ? syncH2WCall : asyncH2WCall;
//     return delegate(port, context.newId(), targetId, memberId, serArgs, isAsync);
// }
//
// function anyW2HCall(port, targetId, memberId, isAsync, args) {
//     assert(typeof targetId === 'string', `failed targetId != string @ anyW2HCall`);
//     const callId = context.newId();
//     const serArgs = serializeArguments(port, postW2HUpdate, args);
//     const delegate = context.canSync() ? syncW2HCall : asyncW2HCall;
//     return delegate(port, callId, targetId, memberId, serArgs, isAsync);
// }

// function anyType(port, targetId, serialize = false) {
//     assert(typeof targetId === 'string', `failed targetId != string @ anyType`);
//
//     const delegate = context.canSync() ? syncType : asyncW2HType;
//     const typeResult = delegate(port, context.newId(), targetId, serialize);
//
//     if (serialize) {
//         assert(IDS.COMM.JSON in typeResult, `W: failed to parse ${IDS.COMM.JSON} from typeResult`);
//         assert(typeof typeResult[IDS.COMM.JSON] === 'string', `W: failed to get typeResult[${IDS.COMM.JSON}] as string`);
//
//         try {
//             typeResult._as_json = safeParse(typeResult[IDS.COMM.JSON]);
//         } catch (e) {
//             logToFile(`Failed to parse ${IDS.COMM.JSON}: ${e}`, true);
//         }
//     }
//
//     typeResult.type = mixInType(typeResult);
//     return typeResult;
// }

// function postW2HSet(port, targetId, propertyId, value) {
//     sendMessage(port, W2H_SET, {targetId, propertyId, value});
// }
//
// function postW2HPromise(port, resolve, objectId, result) {
//     sendMessage(port, W2H_PROMISE, {resolve, objectId, result});
// }

// Code below goes to communication/communication.js

function sendMessage(port, type, payload) {
    try {
        const message = {type, threadId: context.threadId, ...payload};
        port.postMessage(message);
        logToFile('->' + printMessage(message));
    } catch (e) {
        logToFile(`postMessage ${type} failed: ${e}`, true);
    }
}

function asyncCall(port, callId, functionId, thisId, valueArgs) {
    const type = context.isOnHost ? H2W_CALL : W2H_CALL;
    sendMessage(port, type, {callId, functionId, thisId, valueArgs});
    logToFile(`->${type} args=${print(valueArgs)}`);

    if (context.isOnHost) return {[IDS.COMM.CALL]: callId};

    const result = WaitCall(context.destId, callId, functionId);
    if (!result) logToFile(`WaitCall failed result=${result}`, true);
    return result;
}

function syncCall(_, callId, functionId, thisId, valueArgs) {
    const type = context.isOnHost ? H2W_CALL : W2H_CALL;
    const result = RunSync(type, context.destId, callId, functionId, thisId, valueArgs);
    if (!result) logToFile(`RunSync failed result=${result}`, true);
    return result;
}

function asyncW2HType(port, callId, targetId) {
    sendMessage(port, ANY_TYPE, {targetId, callId});
    const result = WaitCall(context.destId, callId, targetId);
    if (!result) logToFile(`WaitCall failed result=${result}`, true);
    return result;
}

function anyCall(port, functionId, thisId, args, sync) {
    const callId = context.newId();
    const valueArgs = args.map(serializeValue);
    const call = context.canSync() ? syncCall : asyncCall;
    const valueResult = call(port, callId, functionId, thisId, valueArgs);
    return deserializeResult(port, valueResult, sync);
}

function anySet(port, targetId, memberId, obj) {
    const callId = context.newId();
    const value = serializeValue(obj);
    sendMessage(port, ANY_SET, {callId, targetId, memberId, value});
}

function anyType(port, targetId) {
    assert(typeof targetId === 'string', `anyType: input failed: got targetId=${targetId}`);
    const delegate = asyncW2HType;
    const valueResult = delegate(port, context.newId(), targetId);
    return deserializeResult(port, valueResult, true);
}

function anyPromise(port, promiseId, resolve, obj) {
    const value = serializeValue(obj);
    sendMessage(port, ANY_PROMISE, {resolve, promiseId, value});
}

function setupCommunicationFunctionality() {
    global.anyCall = anyCall;
    global.anySet = anySet;
    global.anyPromise = anyPromise;
    global.anyType = anyType;
}

module.exports = {
    setupCommunicationFunctionality,
};
