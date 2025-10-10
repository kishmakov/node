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
    asyncW2HType,
    mixInType,
    postH2WCall,
    postW2HCall,
    postW2HSet,
    postW2HPromise,
    postW2HUpdate,
    setCommunicationContext,
    v8H2WCall,
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
    if ('simpleValue' in value) return value.simpleValue;

    const proxyTag = getValueIfPresent(value, IDS.COMM.PROXY);
    if (proxyTag) return context.cache.lookUpItem(proxyTag);

    const handle = createHandle(value[IDS.COMM.RESULT], null, mixInType(value), isAsync);

    const json_str = getValueIfPresent(value, '_as_json_str');
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
    return function(callback, thisArg) {
        if (target._ctor_str === 'Array') {
            const lengthObject = asyncW2HType(port, itemId + '.length');
            for (let i = 0; i < lengthObject.simpleValue; i++) {
                const callResult = asyncW2HType(port, `${itemId}.${i}`, true);
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
        const lengthObject = asyncW2HType(port, itemId + '.length');

        if (lengthObject.type === EntityType.NUMBER) {
            for (let i = 0; i < lengthObject.simpleValue; i++) {
                const callResult = asyncW2HType(port, `${itemId}.${i}`, true);
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
    return {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            const memberStr = `${itemStr}.'${String(name)}'`;
            let value = commonFieldGetter(target, name, proxyStr);
            if (value) {
                target[name] = value;
                logToFile(`W: get ${memberStr} via hardcoded ${print(value)}`);
                return value;
            }

            if (name === 'forEach') return createForEach(port, target, itemId);
            if (name === Symbol.iterator) return createProxyIterator(port, itemId);

            const memberId = itemId + '.' + String(name);
            logToFile(`W: get ${memberStr} needs call to host ...`);
            const typeResult = asyncW2HType(port, memberId);

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
                assert(type === EntityType.OBJECT, `W: asyncW2HType returned unknown type ${type} for id=${memberId}`);
            }

            let handle = createHandle(newItemId, newMemberId, type);
            handle._ctor_str = typeResult._ctor_str;
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
    // if (source[IDS.PROTOTYPE] === 'Array') Object.setPrototypeOf(target, Array.prototype); // TODO
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
    const createHandler = context.isOnHost ? createWorkerProxyHandler : createHostProxyHandler;
    return new Proxy(base, createHandler(port, fullId, itemStr, proxyStr));
}

function createItemProxy(port, objectHandle) {
    const { [IDS.NEW.ITEM]: itemId, [IDS.NEW.MEMBER]: memberId, [IDS.NEW.TYPE]: type, [IDS.NEW.ASYNC]: isAsync, ...remainingHandle } = objectHandle;
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
    return function (...args) {
        const paused = context.isThreadPaused();
        logToFile(`workerFunctionProxy.1/2 via ${paused ? 'v8' : 'post'} ${funcStr}(...)`);
        const serArgs = serializeArguments(port, postW2HUpdate, args);

        let result
        if (paused) {
            result = v8H2WCall(targetId, memberId, serArgs, isAsync);
        } else {
            const resultId = context.newId();
            postH2WCall(port, targetId, memberId, serArgs, isAsync, resultId);
            result = {[IDS.COMM.RESULT]: resultId};
        }

        logToFile(`workerFunctionProxy.2/2 result= ${print(result)}`);
        return deserializeResult(port, isAsync, result);
    };
}

function createHostFunctionProxy(port, targetId, memberId, _isAsync, funcStr) {
    assert(typeof targetId === 'string', `createHostFunctionProxy non-string targetId: ${targetId}`);
    return function (...args) {
        logToFile(`hostFunctionProxy.1/3 ${funcStr}(...)`);
        const serArgs = serializeArguments(port, postW2HUpdate, args);

        const resultId = context.newId();
        postW2HCall(port, targetId, memberId, serArgs, resultId);

        if (context.isThreadPaused()) {
            logToFile(`hostFunctionProxy.3/3 ${funcStr} failed on non-paused thread`, true);
            return undefined;
        }

        logToFile(`hostFunctionProxy.2/3 WaitCall before resultId=${resultId}`);
        const result = WaitCall(context.threadId, resultId);
        logToFile(`hostFunctionProxy.3/3 WaitCall after, result=${print(result, false)}`);
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
            logToFile(`  callOrConstruct funcStr=${funcStr} failed: ${applyError}\n  func=${func}`, true);
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

    return serializeResult(result, resultId);
}

function callWorkerFunctionPaused(targetId, memberId, rawArgs, isAsync) {
    assert(typeof rawArgs === 'string', 'args must be a string');
    const resultId = context.newId();
    const args = JSON.parse(rawArgs);
    return callWorkerFunctionCommon(targetId, memberId, args, resultId, isAsync);
}

function callWorkerFunction(message) {
    const {targetId: targetId, memberId: memberId, args: args, resultId: resultId, isAsync: isAsync} = message;
    logToFile(`<-${H2W_CALL} args=${print(args)}`);
    callWorkerFunctionCommon(targetId, memberId, args, resultId, isAsync);
}

function callHostFunction(message) {
    const {targetId: targetId, memberId: memberId, args: serializedArgs, resultId: resultId} = message;
    logToFile(`<-${W2H_CALL} args=${print(serializedArgs)}`);

    const {target, func, funcStr} = prepareFunctionCall(targetId, memberId);
    const args = serializedArgs.map(arg => deserializeItem(context.port, arg));
    const result = callOrConstruct(func, target, resultId, args, funcStr);

    let serializedResult = '';
    try {
        serializedResult = JSON.stringify(serializeArgumentPost(result));
    } catch (e) {
        logToFile(`>>> serialization@${funcStr} failed: ${e}\n  result=${print(result)}`, true);
    }

    if (!ResumeCall(context.destId, resultId, result, serializedResult)) {
        context.cache.storeItem(resultId, result);
    }
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
    assert(typeof func === 'function', `H: promise handler for ${message.objectId} is not a function`);
    const funcStr = message.resolve ? 'resolve' : 'reject';
    logToFile(`promise[${message.objectId}] to ${funcStr}(${print(message.result)})`);
    func(deserializeItem(context.port, message.result));
}

function provideType(message) {
    const target = context.cache.lookUpItem(message.id, false);
    const serializedTarget = message.serialize ? JSON.stringify(serializeArgumentPost(target)) : '';
    ResumeType(context.destId, message.id, target, serializedTarget);
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

    installCache(context);
    contexts.set(destId, context);
    setSerializationContext(context);
    setCommunicationContext(context);

    if (threadId === IDS.HOST) {
        context.cache.storeItem(apiId, getAPI(`h:vscode.${destId}`));
        context.cache.storeItem(contextId, getAPI(`h:context.${destId}`));
    } else {
        setAPI('w:vscode', deserializeItem(port, createHandle(apiId)));
        setAPI('w:context', deserializeItem(port, createHandle(contextId)));
    }
}

const handlers = {
    // worker
    [H2W_CALL]: callWorkerFunction,
    // host
    [W2H_CALL]: callHostFunction,
    [W2H_SET]: updateHostObject,
    [W2H_PROMISE]: resolvePromise,
    [W2H_TYPE]: provideType,
    [W2H_UPDATE]: updateObject,
};

/////////////////////////////// Exported functions ///////////////////////////////

function reactOnMessage(message) {
    try {
        const handler = handlers[message.type];
        if (!handler) return false;
        logToFile('<-' + printMessage(message));
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
    if (contexts.size > 1) logToFile(`---- context is set for destId=${id} ----`);
}

function initWorker(port, id, filename) {
    setupContext(port, id, IDS.HOST);
    context.callWorkerFunctionPaused = callWorkerFunctionPaused;
    logToFile(`Loading worker for ${filename}`);
    setInterval(() => { logToFile('W: Staying alive'); }, 15000);
}

module.exports = {
    initWorker,
    prepareHost,
    logToFile,
    reactOnMessage
};
