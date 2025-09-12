'use strict';

const assert = require('internal/assert');
const {getAPI, setAPI} = require("internal/util");

const {
    messageTypes: {
        H2W_CALL,
        W2H_CALL,
        W2H_PROMISE,
        W2H_SET,
        W2H_TYPE,
    }
} = require('internal/worker/io');

const {
    IDS,
    isAsyncFunction,
    isClass,
    logToFile,
    print,
} = require("internal/worker/common");

const {
    hostResolves,
    hostRejects,
    installCache,
} = require('internal/worker/cache');

const {
    Context,
    newCallId,
} = require('internal/worker/context');

const {
    EntityType,
    createHandle,
    serializeItem,
    setSerializationContext,
} = require('internal/worker/serialization');

let context = undefined;
const contexts = new Map(); // destId -> context

function asyncType(port, id) {
    assert(typeof id === 'string', `W: asyncType called with nonstring id`);
    let callId = newCallId();

    try {
        port.postMessage({type: W2H_TYPE, id: id, callId: callId});
    } catch (e) {
        logToFile(`W: postMessage call @ asyncType failed: ${e}`);
    }

    logToFile(`W: WaitType before id=${id} callId=${callId}`);
    const typeResult = WaitType(id);
    logToFile(`W: WaitType after, typeResult=${print(typeResult)}`);

    mixInType(typeResult);
    return typeResult;
}

function asyncCall(port, targetId, memberId, args, resultId) {
    assert(typeof targetId === 'string', `W: asyncCall called with non-string targetId`);
    assert(typeof memberId === 'string', `W: asyncCall called with non-string memberId`);

    let callId = newCallId();
    try {
        port.postMessage({
            type: W2H_CALL,
            callId: callId,
            targetId: targetId,
            memberId: memberId,
            args: args,
            resultId: resultId,
            threadId: context.threadId,
        });
    } catch (e) {
        logToFile(`W: postMessage call @ asyncType failed: ${e}`);
    }

    logToFile(`W: ->${W2H_CALL} callId=${callId} targetId=${targetId} functionId=${memberId} args=${print(args)} resultId=${resultId}`);

    logToFile('W: WaitCall before');
    const callResult = WaitCall(resultId, context.threadId);
    logToFile(`W: WaitCall after, callResult=${print(callResult)}`);

    mixInType(callResult);
    return callResult;
}

// Serialization

const TypeCode = Object.freeze({
    UNDEFINED: 0,
    NULL: 1,
    BOOLEAN: 2,
    STRING: 3,
    NUMBER: 4,
    OBJECT: 101,
    FUNCTION: 102,
    CLASS: 103,
    OTHER: 100,
});

function getTypeCode(value) {
    if (typeof value === 'undefined') return TypeCode.UNDEFINED;
    if (value === null) return TypeCode.NULL;
    if (typeof value === 'boolean') return TypeCode.BOOLEAN;
    if (typeof value === 'string') return TypeCode.STRING;
    if (typeof value === 'number') return TypeCode.NUMBER;
    if (typeof value === 'function') return isClass(value) ? TypeCode.CLASS : TypeCode.FUNCTION;
    if (typeof value === 'object') return TypeCode.OBJECT;

    logToFile(`Unknown type value=${print(value, false)} type=${typeof value}`);
    return TypeCode.OTHER;
}

function mixInType(result) {
    if (result.code === TypeCode.OBJECT) result.type = EntityType.OBJECT;
    else if (result.code === TypeCode.FUNCTION) result.type = EntityType.FUNCTION;
    else if (result.code === TypeCode.CLASS) result.type = EntityType.CLASS;
}

// Deserialization
function deserializeItem(port, handle, dstStr = `deserialize(${print(handle)})`) {
    const threadStr = context.isOnHost ? 'host' : 'worker';
    let result = handle;
    if (typeof handle === 'object' && handle !== null) {
        if (IDS.NEW.ITEM in handle) {
            result = createItemProxy(port, handle);
            logToFile(`${dstStr} -> proxies[${handle[IDS.NEW.ITEM]}]`);
        } else if (IDS.REPORTED in handle) {
            result = context.cache.lookUpItem(handle[IDS.REPORTED]);
            logToFile(`${dstStr} -> ${threadStr}Items[${handle[IDS.REPORTED]}]`);
        }
    } else {
        logToFile(`${dstStr} -> ${print(result)}`);
    }
    return result;
}

// Proxy management
function commonFieldGetter(target, name, proxyStr) {
    assert(proxyStr, 'proxyStr must be provided');
    if (name === Symbol.iterator) return function* () {};
    if (name === 'isProxy') return true;
    if (name === 'forEach') {
        return function(callback, thisArg) {
            if (Array.isArray(target)) target.forEach(callback, thisArg);
            else Object.keys(target).forEach(key => callback.call(thisArg, target[key], key, target));
        };
    }
    if (name === '__esModule') return true;
    if (name === 'toPrimitive' || name === Symbol.toPrimitive) return () => proxyStr;
}

function createWorkerProxyHandler(port, itemId, itemStr, proxyStr) {
    return {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            const value = commonFieldGetter(target, name, proxyStr);
            if (Object.isExtensible(target) && value !== undefined) target[name] = value;
            logToFile(`get ${itemStr}.'${String(name)}' resulted in ${print(value)}`);
            return value;
        },
        set() { return true; }
    };
}

function createHostProxyHandler(port, itemId, itemStr, proxyStr) {
    return {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            const memberStr = `${itemStr}.'${String(name)}'`;
            let value = commonFieldGetter(target, name, proxyStr);
            if (value) { target[name] = value; logToFile(`W: get ${memberStr} via hardcoded ${print(value)}`); return value; }
            const memberId = itemId + '.' + String(name);
            logToFile(`W: get ${memberStr} needs call to host ...`);
            const typeResult = asyncType(port, memberId);

            if ('simpleValue' in typeResult) {
                logToFile(`W: get ${memberStr} resulted via simpleValue in ${typeResult.simpleValue}`);
                return typeResult.simpleValue;
            }

            let newItemId = memberId;
            let newMemberId = null;
            let type = typeResult.type;

            if (type === EntityType.CLASS || type === EntityType.FUNCTION) {
                newItemId = itemId;
                newMemberId = String(name);
            } else {
                assert(typeResult.code === TypeCode.OBJECT, `W: asyncType returned unknown type ${typeResult.code} for id=${memberId}`);
            }

            let handle = createHandle(newItemId, newMemberId, type);
            target[name] = createItemProxy(port, handle);
            logToFile(`W: get ${memberStr} resulted via proxy in  ${print(target[name])}`);
            return target[name];
        },
        set(target, name, value) {
            const memberStr = `${itemStr}.'${String(name)}'`;
            const serializedValue = serializeItem(value);

            port.postMessage({
                type: W2H_SET,
                targetId: itemId,
                propertyId: name,
                value: serializedValue
            });

            logToFile(`W: set ${memberStr}.'${String(name)}' to ${print(serializedValue)}`);
            return true;
        }
    };
}

function copyRemainingHandleFields(port, target, source, targetStr) {
    for (const memberId of Reflect.ownKeys(source)) {
        target[memberId] = deserializeItem(port, source[memberId], `${targetStr}.'${String(memberId)}'`);
    }
    if (source[IDS.PROTOTYPE] === 'Array') Object.setPrototypeOf(target, Array.prototype);
}

function createItemProxy(port, objectHandle) {
    const { [IDS.NEW.ITEM]: itemId, [IDS.NEW.MEMBER]: memberId, [IDS.NEW.TYPE]: type, [IDS.NEW.ASYNC]: isAsync, ...remainingHandle } = objectHandle;
    assert(itemId, `itemId is not defined in objectHandle: ${print(objectHandle)}`);
    const fullId = itemId + (memberId ? `.${memberId}` : '');
    const isHostContext = context.isOnHost;
    if (context.cache.hasProxy(fullId)) return context.cache.getProxy(fullId);

    logToFile(`createItemProxy context=${isHostContext ? 'worker' : 'host'} id=${itemId} member=${memberId} type=${type} async=${isAsync}`);

    let result;
    const proxyStr = `ProxiedID: ${fullId}, Type: ${type}`;
    const itemStr = `proxies[${itemId}]` + (memberId ? `.${memberId}` : '');

    if (isHostContext && type === EntityType.OBJECT && isAsync) {
        result = new Promise((resolve, reject) => {
            logToFile(`filling in hostResolves and hostRejects for id=${itemId}`);
            hostResolves.set(itemId, resolve);
            hostRejects.set(itemId, reject);
        });
    } else {
        const createFunctionProxy = isHostContext ? createWorkerFunctionProxy : createHostFunctionProxy;
        const createProxyHandler = isHostContext ? createWorkerProxyHandler : createHostProxyHandler;

        let base = null;
        if (type === EntityType.FUNCTION) {
            result = createFunctionProxy(port, itemId, memberId, isAsync, itemStr);
            Object.assign(result, context.createProxyTag(fullId));
        } else if (type === EntityType.CLASS) {
            base = createFunctionProxy(port, itemId, memberId, isAsync, itemStr);
            Object.assign(base, context.createProxyTag(fullId));
        } else if (type === EntityType.OBJECT) {
            base = context.createProxyTag(fullId);
        }
        else assert(false, `createItemProxy unknown type ${type} id=${fullId}`);
        if (base) result = new Proxy(base, createProxyHandler(port, fullId, itemStr, proxyStr));
        context.cache.storeProxy(fullId, result);
        if (base) copyRemainingHandleFields(port, base, remainingHandle, itemStr);
    }
    return result;
}

function createWorkerFunctionProxy(port, targetId, memberId, isAsync, funcStr) {
    funcStr = (isAsync ? 'async ' : '') + funcStr;
    return function (...args) {
        const serializedArgs = args.map(arg => serializeItem(arg));
        const resultId = context.newId();
        port.postMessage({ type: H2W_CALL, targetId, memberId, args: serializedArgs, resultId, isAsync });
        logToFile(`H: ->${H2W_CALL} ${funcStr}(${print(serializedArgs)}) resultId=${resultId}`);
        return createItemProxy(port, createHandle(resultId, null, EntityType.OBJECT, isAsync));
    };
}

function createHostFunctionProxy(port, targetId, memberId, _isAsync, funcStr) {
    assert(typeof targetId === 'string', `W: createHostFunctionProxy non-string targetId: ${targetId}`);
    logToFile(`W: createHostFunctionProxy ${funcStr} for targetId=${targetId} memberId=${memberId}`);
    function hostFuncProxy(...args) {
        const serializedArgs = args.map(arg => serializeItem(arg));
        const argsStr = print(serializedArgs, false);
        const resultId = context.newId();
        logToFile(`W: call.1 ${funcStr}(${argsStr}), reserving resultId=${resultId}`);
        const callResult = asyncCall(port, targetId, memberId, serializedArgs, resultId);
        logToFile(`W: call.2 ${funcStr}(${argsStr}) callResult=${print(callResult)}`);

        let result = 'simpleValue' in callResult
            ? callResult.simpleValue
            : createItemProxy(port, createHandle(resultId, null, callResult.type));

        logToFile(`W: call.3 ${funcStr}(${argsStr}) resulted in ${result}`);
        return result;
    }
    Object.assign(hostFuncProxy, { IsFromChanges: true });
    return hostFuncProxy;
}

// Function call management
function callWorkerFunction(message) {
    const { targetId: targetId, memberId: memberId, args: serializedArgs, resultId: resultId, isAsync: isAsync} = message;

    let target = context.cache.lookUpItem(targetId);

    let func;
    let funcStr = (isAsync ? 'async ' : '') + `workerItems[${targetId}]`;

    if (memberId) {
        assert(memberId in target, `W: ${memberId} not found in workerItems[${targetId}]`);
        func = target[memberId];
        funcStr += `.${memberId}`;
    } else {
        func = target;
        target = null;
    }

    const argsStr = print(serializedArgs);
    const args = serializedArgs.map(arg => deserializeItem(context.port, arg));
    logToFile(`W: callWorkerFunction resultId=${resultId} ${funcStr}(${argsStr})`);

    let result = undefined;
    let resultStr = undefined;
    try { // try constructor first
        result = Reflect.construct(func, args);
        resultStr = 'construct';
    } catch (constructError) {
        try { // fall back to regular function call
            result = func.apply(target, args);
            resultStr = 'apply';
        } catch (applyError) {
            logToFile(`W: callWorkerFunction for ${funcStr} failed: ${applyError}\nW: func=${func}`);
        }
    }

    if (isAsync && !!result) {
        result.then(res => {
            logToFile(`W: ->${W2H_PROMISE} promise[${resultId}] resolved with ${print(res)}`);
            context.port.postMessage({
                type: W2H_PROMISE,
                resolve: true,
                objectId: resultId,
                result: serializeItem(res),
            });
        }, err => {
            logToFile(`W: ->${W2H_PROMISE} promise[${resultId}] rejected with ${print(err)}`);
            context.port.postMessage({
                type: W2H_PROMISE,
                resolve: false,
                objectId: resultId,
                result: serializeItem(err),
            });
        });
    }
    logToFile(`W: callWorkerFunction resultId=${resultId} ${funcStr}(${argsStr}) via ${resultStr} -> ${print(result)}`);
    context.cache.storeItem(resultId, result);
}

function callHostFunction(message) {
    const { targetId: targetId, memberId: memberId, args: serializedArgs, resultId:resultId } = message;

    let target = context.cache.lookUpItem(targetId);

    let func;
    let funcStr = `hostItems[${targetId}]`

    if (memberId) {
        assert(memberId in target, `H: ${memberId} not found in hostItems[${targetId}]`);
        func = target[memberId];
        funcStr += `.${memberId}`;
    } else {
        func = target;
        target = null;
    }

    const argsStr = print(serializedArgs);
    const args = serializedArgs.map(arg => deserializeItem(context.port, arg));

    let result = undefined;
    let resultStr = undefined;

    try { // try constructor first
        result = Reflect.construct(func, args);
        resultStr = 'construct';
    } catch (constructError) {
        try { // fall back to regular function call
            result = func.apply(target, args);
            resultStr = 'apply';
        } catch (applyError) {
            logToFile(`H: callHostFunction for ${funcStr} failed: ${applyError}\nH: func=${func}`);
        }
    }
    const code = getTypeCode(result);
    logToFile(`H: callHostFunction for ${funcStr}(${argsStr}) via ${resultStr} -> ${print(result)} type=${code}`);
    if (!ResumeCall(resultId, context.destId, result, code)) {
        context.cache.storeItem(resultId, result);
    }
}

// Object property update management
function updateHostObject(message) {
    const { targetId: targetId, propertyId: propertyId, value: value } = message;
    const target = context.cache.lookUpItem(targetId);
    target[propertyId] = deserializeItem(context.port, value);
    logToFile(`H: hostItems[${targetId}].${propertyId} := ${print(value)}`);
}

function setupContext(port, threadId, destId) {
    if (contexts.has(destId)) {
        context = contexts.get(destId);
        setSerializationContext(context);
        return;
    }

    // These ids are supposed to be the same on both sides
    const apiId = IDS.VSCODE + '#' + (threadId === IDS.HOST ? destId : threadId);
    const contextId = IDS.CONTEXT + '#' + (threadId === IDS.HOST ? destId : threadId);

    context = new Context(port, threadId, destId);

    installCache(context);
    contexts.set(destId, context);
    setSerializationContext(context);

    if (threadId === IDS.HOST) {
        context.cache.storeItem(apiId, getAPI(`h:vscode.${destId}`));
        context.cache.storeItem(contextId, getAPI(`h:context.${destId}`));
    } else {
        setAPI('w:vscode', createItemProxy(port, createHandle(apiId)));
        setAPI('w:context', createItemProxy(port, createHandle(contextId)));
    }
}

const handlers = {
    // worker
    [H2W_CALL]: callWorkerFunction,
    // host
    [W2H_CALL]: callHostFunction,
    [W2H_SET]: updateHostObject,
    [W2H_PROMISE](message) {
        const func = message.resolve ? hostResolves.get(message.objectId) : hostRejects.get(message.objectId);
        assert(typeof func === 'function', `H: promise handler for ${message.objectId} is not a function`);
        const funcStr = message.resolve ? 'resolve' : 'reject';
        logToFile(`promise[${message.objectId}] to ${funcStr}(${print(message.result)})`);
        func(deserializeItem(context.port, message.result));
    },
    [W2H_TYPE](message) {
        const target = context.cache.lookUpItem(message.id, false);
        const code = getTypeCode(target)
        logToFile(`about to return type for ${message.id} type=${code}`);
        ResumeType(message.id, target, code);
    },
};

/////////////////////////////// Exported functions ///////////////////////////////

function reactOnMessage(message) {
    try {
        const handler = handlers[message.type];
        if (!handler) return false;
        let logLine = `<-${message.type}`

        Object.keys(message).forEach(key => {
            if (key !== 'args' && key !== 'value' && key !== 'type') {
                logLine += ` ${key}=${message[key]}`;
            }
        });

        logToFile(logLine);
        handler(message);

        return true;
    } catch (e) {
        const msg = JSON.stringify(message);
        logToFile(`Error during handling ${msg}\n:    ${e}\n    stack: ${e.stack}`)
    }

    return false;
}

function prepareHost(port, id) {
    setupContext(port, IDS.HOST, id);
    logToFile(`Endpoint is set for ${id}`);
}

function initWorker(port, id, filename) {
    setupContext(port, id, IDS.HOST);
    logToFile(`Loading worker for ${filename}`);
    setInterval(() => { logToFile('W: Staying alive'); }, 15000);
}

module.exports = {
    initWorker,
    prepareHost,
    logToFile,
    reactOnMessage
};
