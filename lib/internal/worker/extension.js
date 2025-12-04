'use strict';

const assert = require('internal/assert');
const {getAPI, setAPI} = require("internal/util");

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
    printMessage
} = require("internal/worker/common");

const {
    hostResolves,
    hostRejects,
    installCache,
} = require('internal/worker/cache');

const {Context} = require('internal/worker/context');

const {
    EntityType,
    createHandle,
    serializeArgumentPost,
    serializeArguments,
    serializeResult,
    setSerializationContext,
} = require('internal/worker/serialization');

const {
    anyH2WCall,
    anyType,
    mixInType,
    postW2HCall,
    postW2HSet,
    postW2HPromise,
    postW2HUpdate,
    setCommunicationContext,
} = require('internal/worker/communication');

let context = undefined;
const contexts = new Map(); // destId -> context


// Deserialization
function deserializeItem(port, handle, dstStr = `deserialize(${print(handle)})`) {
    let result = handle;
    if (typeof handle === 'object' && handle !== null) {
        if (IDS.NEW.ITEM in handle) {
            result = createItemProxy(port, handle);
            logToFile(`  ${dstStr} resulted in creation proxies[${handle[IDS.NEW.ITEM]}]`);
        } else if (IDS.COMM.PROXY in handle) {
            result = context.cache.lookUpItem(handle[IDS.COMM.PROXY]);
            logToFile(`  ${dstStr} looked up as items[${handle[IDS.COMM.PROXY]}]`);
        }
    } else {
        logToFile(`  ${dstStr} passed as is`);
    }

    return result;
}

function deserializeResult(port, isAsync, value) {
    logToFile(`deserializeResult value=${print(value)}`);
    if (!value) return value;
    if ('simpleValue' in value) return value.simpleValue;

    const proxyTag = getValueIfPresent(value, IDS.COMM.PROXY);
    if (proxyTag) return context.cache.lookUpItem(proxyTag);

    const handle = createHandle(value[IDS.COMM.RESULT], null, mixInType(value), isAsync);

    const json_str = getValueIfPresent(value, IDS.COMM.JSON);
    if (typeof json_str === 'string' && json_str.length > 0) {
        try {
            Object.assign(handle, JSON.parse(json_str));
        } catch (e) {
            logToFile(`Failed to parse ${json_str}: ${e}`, true);
        }
    }

    return createItemProxy(port, handle);
}

// Proxy management
function commonFieldGetter(target, name, proxyStr) {
    assert(proxyStr, 'proxyStr must be provided');
    if (name === 'isProxy') return true;
    if (name === '__esModule') return true;
    if (name === 'toPrimitive' || name === Symbol.toPrimitive) return () => proxyStr;
}

function createForEach(port, target, itemId) {
    return function (callback, thisArg) {
        if (target[IDS.COMM.PROTO] === 'Array') {
            const lengthObject = anyType(port, itemId + '.length');
            for (let i = 0; i < lengthObject.simpleValue; i++) {
                const callResult = anyType(port, `${itemId}.${i}`, true);
                const handle = callResult._as_json;  // TODO: check if ids are fine
                handle.type = callResult.type;
                const proxy = createItemProxy(port, handle);
                callback.call(thisArg, proxy, i, target);
            }
        }
    };
}

function createProxyIterator(port, itemId) {
    return function* () {
        const lengthObject = anyType(port, itemId + '.length');

        if (lengthObject.type === EntityType.NUMBER) {
            for (let i = 0; i < lengthObject.simpleValue; i++) {
                const callResult = anyType(port, `${itemId}.${i}`, true);
                const handle = callResult._as_json;  // TODO: check if ids are fine
                handle.type = callResult.type;
                yield createItemProxy(port, handle);
            }
        }
    };
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
    const blacklist = new Set([String(IDS.PROXY.HOST), 'type', 'isProxy', 'toPrimitive']);

    return {
        __proto__: null,
        ownKeys(target) {
            logToFile(`W: ownKeys at ${itemStr}`);
            const keys = Reflect.ownKeys(target);
            return keys.filter(k => !blacklist.has(String(k)));
        },
        getOwnPropertyDescriptor(target, prop) {
            logToFile(`W: getOwnPropertyDescriptor at ${itemStr} for ${String(prop)}`);
            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        get(target, name) {
            if (name in target) return target[name];
            const memberStr = `${itemStr}.'${String(name)}'`;
            let value = commonFieldGetter(target, name, proxyStr);
            if (value) {
                target[name] = value;
                logToFile(`W: get ${memberStr} via hardcoded ${print(value)}`);
                return value;
            }

            // Prevent JSON.stringify from triggering cross-thread communication on non-paused threads
            if (name === 'toJSON' && !context.getPaused()) {
                logToFile(`W: get ${memberStr} skipped on non-paused thread`);
                return undefined;
            }

            if (name === 'forEach') return createForEach(port, target, itemId);
            if (name === Symbol.iterator) return createProxyIterator(port, itemId);

            const memberId = itemId + '.' + String(name);
            logToFile(`W: get ${memberStr} needs call to host ...`);
            const typeResult = anyType(port, memberId);

            if (typeResult === undefined) {
                logToFile(`W: get ${memberStr} resulted in undefined from host`);
                return undefined;
            }

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
                assert(type === EntityType.OBJECT, `W: anyType returned unknown type ${type} for id=${memberId}`);
            }

            let handle = createHandle(newItemId, newMemberId, type);
            handle[IDS.COMM.PROTO] = typeResult[IDS.COMM.PROTO];
            target[name] = createItemProxy(port, handle);
            logToFile(`W: get ${memberStr} resulted via proxy in  ${print(target[name])}`);
            return target[name];
        },
        set(target, name, value) {
            const memberStr = `${itemStr}.'${String(name)}'`;
            const serializedValue = serializeArgumentPost(value);
            postW2HSet(port, itemId, name, serializedValue);
            logToFile(`W: set ${memberStr}.'${String(name)}' to ${print(serializedValue)}`);
            return true;
        }
    };
}

function copyRemainingHandleFields(port, target, source, targetStr) {
    for (const memberId of Reflect.ownKeys(source)) {
        target[memberId] = deserializeItem(port, source[memberId], `${targetStr}.'${String(memberId)}'`);
    }
    if (context.isOnHost || context.getPaused()) { // TODO
        if (source[IDS.COMM.PROTO] === 'Array') Object.setPrototypeOf(target, Array.prototype);
    }
}

function createProxyFunction(port, targetId, memberId, isAsync, funcStr, fullId) {
    const createProxy = context.isOnHost ? createWorkerFunctionProxy : createHostFunctionProxy;
    logToFile(`   createProxyFunction ${funcStr} for targetId=${targetId} memberId=${memberId}`);

    const result = createProxy(port, targetId, memberId, isAsync, funcStr);
    Object.assign(result, {[context.proxyTagKey()]: fullId});
    return result;
}

function createProxyObject(base, port, fullId, itemStr, proxyStr) {
    Object.assign(base, {[context.proxyTagKey()]: fullId});
    logToFile(`   createProxyObject id=${fullId} item=${itemStr}`);
    const createHandler = context.isOnHost ? createWorkerProxyHandler : createHostProxyHandler;
    return new Proxy(base, createHandler(port, fullId, itemStr, proxyStr));
}

function createItemProxy(port, objectHandle) {
    const {
        [IDS.NEW.ITEM]: itemId,
        [IDS.NEW.MEMBER]: memberId,
        [IDS.NEW.TYPE]: type,
        [IDS.NEW.ASYNC]: isAsync,
        ...remainingHandle
    } = objectHandle;
    assert(itemId, `itemId is not defined in objectHandle: ${print(objectHandle)}`);
    const fullId = itemId + (memberId ? `.${memberId}` : '');
    if (context.cache.hasProxy(fullId)) return context.cache.getProxy(fullId);

    logToFile(`   createItemProxy id=${itemId} member=${memberId} type=${type} async=${isAsync}`);

    let result;
    const proxyStr = `ProxiedID: ${fullId}, Type: ${type}`;
    const itemStr = `proxies[${itemId}]` + (memberId ? `.${memberId}` : '');

    if (context.isOnHost && type === EntityType.OBJECT && isAsync) {
        result = new Promise((resolve, reject) => {
            logToFile(`filling in hostResolves and hostRejects for id=${itemId}`);
            hostResolves.set(itemId, resolve);
            hostRejects.set(itemId, reject);
        });
    } else {
        let base = null;
        if (type === EntityType.FUNCTION) {
            result = createProxyFunction(port, itemId, memberId, isAsync, itemStr, fullId);
            result.type = EntityType.FUNCTION;
        } else if (type === EntityType.CLASS) {
            base = createProxyFunction(port, itemId, memberId, isAsync, itemStr, fullId);
            base.type = EntityType.CLASS;
        } else if (type === EntityType.OBJECT) {
            base = {type: EntityType.OBJECT};
        }
        else assert(false, `createItemProxy unknown type ${type} id=${fullId}`);
        if (base) result = createProxyObject(base, port, fullId, itemStr, proxyStr);
        context.storeProxy(fullId, result);
        if (base) copyRemainingHandleFields(port, base, remainingHandle, itemStr);
    }
    return result;
}

function createWorkerFunctionProxy(port, targetId, memberId, isAsync, funcStr) {
    logToFile(`createWorkerFunctionProxy targetId=${targetId} memberId=${memberId} isAsync=${isAsync}`);
    return function (...args) {
        logToFile(`workerFunctionProxy.1/2  ${funcStr}(...)`);
        const serArgs = serializeArguments(port, postW2HUpdate, args);
        const result = anyH2WCall(port, targetId, memberId, serArgs, isAsync);
        logToFile(`workerFunctionProxy.2/2 result=${print(result)}`);
        return deserializeResult(port, isAsync, result);
    };
}

function createHostFunctionProxy(port, targetId, memberId, isAsync, funcStr) {
    assert(typeof targetId === 'string', `createHostFunctionProxy non-string targetId: ${targetId}`);
    return function (...args) {
        const resultId = context.newId();
        const callId = context.newId();

        const coord = `callId=${callId} targetId=${targetId} memberId=${memberId} resultId=${resultId} paused=${context.getPaused()}`;

        logToFile(`hostFunctionProxy.1/3 ${funcStr}(...) ${coord}`);
        const serArgs = serializeArguments(port, postW2HUpdate, args);

        if (context.canSync()) {
            logToFile(`hostFunctionProxy.2/3 RunOnPaused before resultId=${resultId}`);
            const reqType = context.isOnHost ? H2W_CALL : W2H_CALL;
            const result = RunSync(context.destId, callId, reqType, targetId, memberId, args, isAsync, false, resultId);
            logToFile(`hostFunctionProxy.3/3 RunOnPaused after, result=${print(result, false)}`);
            return deserializeResult(port, false, result);
        }

        postW2HCall(port, callId, targetId, memberId, serArgs, resultId);

        logToFile(`hostFunctionProxy.2/3 WaitCall before ${coord}`);
        const result = WaitCall(context.destId, callId, targetId, resultId);
        if (!result) {
            logToFile(`hostFunctionProxy.3/3 WaitCall failed to locate result ${coord}`, true);
        } else {
            logToFile(`hostFunctionProxy.3/3 WaitCall after, result=${print(result, false)}`);
        }

        return deserializeResult(port, false, result);
    };
}

// Function call management

function prepareFunctionCall(targetId, memberId, isAsync = false) {
    let target = context.cache.lookUpItem(targetId);

    let func;
    let funcStr = (isAsync ? 'async ' : '') + `items[${targetId}]`;

    if (memberId) {
        assert(memberId in target, `${memberId} not found in items[${targetId}]`);
        func = target[memberId];
        funcStr += '.' + memberId;
    } else {
        func = target;
        target = null;
    }

    return {target, func, funcStr};
}

function callOrConstruct(func, target, resultId, args, funcStr) {
    logToFile(`  callOrConstruct resultId=${resultId} ${funcStr}(...)`);

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
            logToFile(`  callOrConstruct funcStr=${funcStr} failed: ${applyError.message}> stack=${applyError.stack}\n> func=${func}`, true);
        }
    }

    logToFile(`  callOrConstruct funcStr=${funcStr} via ${resultStr} -> ${print(result)}`);
    return result;
}

function callWorkerFunctionCommon(targetId, memberId, serializedArgs, resultId, isAsync) {
    const {target, func, funcStr} = prepareFunctionCall(targetId, memberId, isAsync);
    const args = serializedArgs.map(arg => deserializeItem(context.port, arg));
    const result = callOrConstruct(func, target, resultId, args, funcStr);

    if (isAsync && !!result) {
        result
            .then(res => postW2HPromise(context.port, true, resultId, serializeArgumentPost(res)))
            .catch(err => postW2HPromise(context.port, false, resultId, serializeArgumentPost(err)));
    }

    return serializeResult(result, resultId, true);
}

function callWorkerFunctionSync(callId, targetId, memberId, jsonArgs, isAsync) {
    assert(typeof jsonArgs === 'string', 'failed: jsonArgs != string @ callHostFunctionSync');
    const coords = `callId=${callId} targetId=${targetId} memberId=${memberId} isAsync=${isAsync}`;
    logToFile(`callWorkerFunctionSync ${coords}`);
    const resultId = context.newId();
    const args = JSON.parse(jsonArgs);
    return callWorkerFunctionCommon(targetId, memberId, args, resultId, isAsync);
}

function callWorkerFunctionAsync(targetId, memberId, serializedArgs, resultId, isAsync) {
    logToFile(`<-${H2W_CALL} args=${print(serializedArgs)}`);
    callWorkerFunctionCommon(targetId, memberId, serializedArgs, resultId, isAsync)
}

function callHostFunctionInternal(targetId, memberId, serializedArgs, resultId) {
    const {target, func, funcStr} = prepareFunctionCall(targetId, memberId);
    const args = serializedArgs.map(arg => deserializeItem(context.port, arg));
    const result = callOrConstruct(func, target, resultId, args, funcStr);

    logToFile(`H: serializing result for ${funcStr} -> ${print(result)}`);
    const resultSer = serializeResult(result, resultId, true);
    logToFile(`H: serialization complete for ${funcStr}`);
    return resultSer;
}

function callHostFunctionSync(targetId, memberId, jsonArgs) {
    assert(typeof jsonArgs === 'string', 'failed: jsonArgs != string @ callHostFunctionSync');
    const resultId = context.newId();
    const args = JSON.parse(jsonArgs);
    return callHostFunctionInternal(targetId, memberId, args, resultId);
}

function callHostFunctionAsync(callId, targetId, memberId, serializedArgs, resultId) {
    logToFile(`<-${W2H_CALL} args=${print(serializedArgs)}`);
    const resultSer = callHostFunctionInternal(targetId, memberId, serializedArgs, resultId);
    const coords = `callId=${callId} targetId=${targetId} memberId=${memberId} resultId=${resultId}`;
    logToFile(`callHostFunctionAsync ResumeCall before ${coords}`);
    ResumeCall(context.destId, callId, targetId, resultSer);
    logToFile(`callHostFunctionAsync ResumeCall after ${coords}`);
}

// Update management
function updateHostObject(message) {
    const { targetId: targetId, propertyId: propertyId, value: value } = message;
    const target = context.cache.lookUpItem(targetId);
    target[propertyId] = deserializeItem(context.port, value);
    logToFile(`H: items[${targetId}].${propertyId} := ${print(value)}`);
}

function updateObject(message) {
    const { targetId: targetId, value: value } = message;
    context.cache.storeItem(targetId, value);
    logToFile(`H: items[${targetId}] := ${print(value)}`);
}

function resolvePromise(message) {
    const func = message.resolve ? hostResolves.get(message.objectId) : hostRejects.get(message.objectId);
    assert(typeof func === 'function', `H: promise handler for ${message.objectId} is not a function, but ${typeof func}`);
    const funcStr = message.resolve ? 'resolve' : 'reject';
    logToFile(`promise[${message.objectId}] to ${funcStr}(${print(message.result)})`);
    func(deserializeItem(context.port, message.result));
}

function lookUpTypeCommon(targetId, serialize) {
    const target = context.cache.lookUpItem(targetId, false);
    return serializeResult(target, targetId, serialize);
}

function lookUpTypeAsync(threadId, callId, targetId, serialize) {
    const result = lookUpTypeCommon(targetId, serialize);
    ResumeType(context.destId, callId, targetId, result);
    logToFile(`ResumeType callId=${callId} targetId=${targetId}`);
}

function setupContext(port, threadId, destId) {
    if (contexts.has(destId)) {
        context = contexts.get(destId);
        setSerializationContext(context);
        setCommunicationContext(context);
        return;
    }

    // These ids are supposed to be the same on both sides
    const apiId = IDS.VSCODE + '#' + (threadId === IDS.HOST ? destId : threadId);
    const contextId = IDS.CONTEXT + '#' + (threadId === IDS.HOST ? destId : threadId);

    context = new Context(port, threadId, destId);

    RegisterWorker(threadId, syncHandler);
    installCache(context);
    contexts.set(destId, context);
    setSerializationContext(context);
    setCommunicationContext(context);

    if (threadId === IDS.HOST) {
        context.cache.storeItem(apiId, getAPI(`h:vscode.${destId}`));
        context.cache.storeItem(contextId, getAPI(`h:context.${destId}`));
        const { _, resolve, reject } = getAPI(`h:promise.${destId}`);
        assert(!!resolve && !!reject, `h:promise.${destId} is not set`);
        hostResolves.set(IDS.ACTIVATION_RESULT, resolve);
        hostRejects.set(IDS.ACTIVATION_RESULT, reject);
    } else {
        setAPI('w:vscode', deserializeItem(port, createHandle(apiId)));
        setAPI('w:context', deserializeItem(port, createHandle(contextId)));
    }
}

/////////////////////////////// Dispatchers and handlers ///////////////////////////////

function asyncHandler(message) {
    const {
        type,
        threadId,
        callId,
        targetId,
        memberId,
        args,
        resultId,
        isAsync,
        serialize,
    } = message;

    if (type === ANY_TYPE) lookUpTypeAsync(threadId, callId, targetId, serialize);
    if (type === W2H_CALL) callHostFunctionAsync(callId, targetId, memberId, args, resultId);
    if (type === H2W_CALL) callWorkerFunctionAsync(targetId, memberId, args, resultId, isAsync);
}

function syncHandler(type, callId, targetId, memberId, jsonArgs, isAsync, serialize) {
    if (!context.isOnHost && type === H2W_CALL) {
        return callWorkerFunctionSync(callId, targetId, memberId, jsonArgs, isAsync);
    }
    if (context.isOnHost && type === W2H_CALL) {
        return callHostFunctionSync(targetId, memberId, jsonArgs);
    }
    if (type === ANY_TYPE) {
        return lookUpTypeCommon(targetId, serialize);
    }

    logToFile(`>>> failed: not implemented for ${type} <<<`);
    return undefined;
}

const handlers = {
    // both
    [ANY_TYPE]: asyncHandler,
    // worker
    [H2W_CALL]: asyncHandler,
    // host
    [W2H_CALL]: asyncHandler,
    [W2H_SET]: updateHostObject,
    [W2H_PROMISE]: resolvePromise,
    [W2H_UPDATE]: updateObject,
};

/////////////////////////////// Exported functions ///////////////////////////////

function reactOnMessage(message) {
    try {
        const handler = handlers[message.type];
        if (!handler) return false;
        logToFile('<-' + printMessage(message), false, true);
        handler(message);

        return true;
    } catch (e) {
        const msg = JSON.stringify(message);
        logToFile(`failed handling ${msg}\n:> ${e}\n> stack: ${e.stack}`)
    }

    return false;
}

function prepareHost(port, id) {
    setupContext(port, IDS.HOST, id);
    if (contexts.size > 1) logToFile(`---- context is set for destId=${id} ----`);
}

function initWorker(port, id, filename) {
    setupContext(port, id, IDS.HOST);
    logToFile(`Loading worker for ${filename}`);
    setInterval(() => { logToFile('W: Staying alive'); }, 15000);
    process.on('exit', () => {
        logToFile(`failed to keep worker for ${id} alive`);
    });
}

function resolveActivationResult(res) {
    context.cache.storeItem(IDS.ACTIVATION_RESULT, res);
    postW2HPromise(context.port, true, IDS.ACTIVATION_RESULT, serializeArgumentPost(res));
}

module.exports = {
    initWorker,
    prepareHost,
    logToFile,
    resolveActivationResult,
    reactOnMessage
};
