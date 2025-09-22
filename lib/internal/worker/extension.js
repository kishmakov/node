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
    isClass,
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
    serializeItem,
    setSerializationContext,
} = require('internal/worker/serialization');

const {
    asyncW2HType,
    asyncW2HCall,
    rpcH2WCall,
    postW2HSet,
    postW2HPromise,
    setCommunicationContext
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
        } else if (IDS.REPORTED in handle) {
            result = context.cache.lookUpItem(handle[IDS.REPORTED]);
            logToFile(`  ${dstStr} looked up as items[${handle[IDS.REPORTED]}]`);
        }
    } else {
        logToFile(`  ${dstStr} passed as is`);
    }

    return result;
}

// Proxy management
function commonFieldGetter(target, name, proxyStr) {
    assert(proxyStr, 'proxyStr must be provided');

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

function createProxyIterator(port, itemId) {
    return function* () {
        const lengthObject = asyncW2HType(port, itemId + '.length');

        if (lengthObject.type === EntityType.NUMBER) {
            for (let i = 0; i < lengthObject.simpleValue; i++) {
                const subId = `${itemId}.${i}`;
                const callResult = asyncW2HType(port, subId, true);
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
            target[name] = createItemProxy(port, handle);
            logToFile(`W: get ${memberStr} resulted via proxy in  ${print(target[name])}`);
            return target[name];
        },
        set(target, name, value) {
            const memberStr = `${itemStr}.'${String(name)}'`;
            const serializedValue = serializeItem(value);
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
    Object.assign(result, context.createProxyTag(fullId));
    return result;
}

function createProxyObject(base, port, fullId, itemStr, proxyStr) {
    Object.assign(base, context.createProxyTag(fullId));
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

function createWorkerFunctionProxy(port, targetId, memberId, isAsync, _funcStr) {
    return function (...args) {
        const serializedArgs = args.map(arg => serializeItem(arg));
        const resultId = context.newId();
        const callResult = rpcH2WCall(port, targetId, memberId, serializedArgs, resultId, isAsync);
        let result = 'simpleValue' in callResult
            ? callResult.simpleValue
            : createItemProxy(port, createHandle(resultId, null, callResult.type, isAsync));

        return result;
    };
}

function createHostFunctionProxy(port, targetId, memberId, _isAsync, funcStr) {
    assert(typeof targetId === 'string', `W: createHostFunctionProxy non-string targetId: ${targetId}`);
    return function (...args) {
        const serializedArgs = args.map(arg => serializeItem(arg));
        const argsStr = print(serializedArgs, false);
        const resultId = context.newId();
        logToFile(`W: call.1 ${funcStr}(${argsStr}), reserving resultId=${resultId}`);
        const callResult = asyncW2HCall(port, targetId, memberId, serializedArgs, resultId);
        logToFile(`W: call.2 ${funcStr}(${argsStr}) callResult=${print(callResult)}`);

        let result = 'simpleValue' in callResult
            ? callResult.simpleValue
            : createItemProxy(port, createHandle(resultId, null, callResult.type));

        logToFile(`W: call.3 ${funcStr}(${argsStr}) resulted in ${result}`);
        return result;
    };
}

// Function call management
function doCallWorkerFunction(targetId, memberId, serializedArgs, resultId, isAsync) {
    logToFile(`>>> ${typeof serializedArgs}`);

    if (typeof serializedArgs === 'string') {
        serializedArgs = JSON.parse(serializedArgs);
    }

    let target = context.cache.lookUpItem(targetId);

    let func;
    let funcStr = (isAsync ? 'async ' : '') + `items[${targetId}]`;

    if (memberId) {
        assert(memberId in target, `W: ${memberId} not found in items[${targetId}]`);
        func = target[memberId];
        funcStr += '.' + memberId;
    } else {
        func = target;
        target = null;
    }

    const args = serializedArgs.map(arg => deserializeItem(context.port, arg));
    logToFile(`  doCallWorkerFunction resultId=${resultId} ${funcStr}(...)`);

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
            logToFile(`  doCallWorkerFunction for ${funcStr} failed: ${applyError}\n  func=${func}`);
        }
    }

    if (isAsync && !!result) {
        result
            .then(res => postW2HPromise(context.port, true, resultId, serializeItem(res)))
            .catch(err => postW2HPromise(context.port, false, resultId, serializeItem(err)));
    }

    logToFile(`  doCallWorkerFunction resultId=${resultId} ${funcStr} via ${resultStr} -> ${print(result)}`);
    context.cache.storeItem(resultId, result);

    if (typeof result === 'function') {
        result.isClass = isClass(result);
    }

    return result;
}

function callWorkerFunction(message) {
    const { targetId: targetId, memberId: memberId, args: serializedArgs, resultId: resultId, isAsync: isAsync} = message;
    logToFile(`<-${H2W_CALL} args=${print(serializedArgs)}`);
    doCallWorkerFunction(targetId, memberId, serializedArgs, resultId, isAsync);
}

function callHostFunction(message) {
    const { targetId: targetId, memberId: memberId, args: serializedArgs, resultId:resultId } = message;

    logToFile(`<-${W2H_CALL} args=${print(serializedArgs)}`);

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
            logToFile(`  callHostFunction for ${funcStr} failed: ${applyError}\n  func=${func}`);
        }
    }

    logToFile(`  callHostFunction for ${funcStr}(...) via ${resultStr} -> ${print(result)}`);
    if (!ResumeCall(context.destId, resultId, result)) {
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

function resolvePromise(message) {
    const func = message.resolve ? hostResolves.get(message.objectId) : hostRejects.get(message.objectId);
    assert(typeof func === 'function', `H: promise handler for ${message.objectId} is not a function`);
    const funcStr = message.resolve ? 'resolve' : 'reject';
    logToFile(`promise[${message.objectId}] to ${funcStr}(${print(message.result)})`);
    func(deserializeItem(context.port, message.result));
}

function provideType(message) {
    const target = context.cache.lookUpItem(message.id, false);
    const serializedTarget = message.serialize ? JSON.stringify(serializeItem(target)) : '';
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
    context.doCallWorkerFunction = doCallWorkerFunction;
    logToFile(`Loading worker for ${filename}`);
    setInterval(() => { logToFile('W: Staying alive'); }, 15000);
}

module.exports = {
    initWorker,
    prepareHost,
    logToFile,
    reactOnMessage
};
