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
    createProxyTag,
    getProxyHandle,
    initLogFile,
    logToFile,
    print,
} = require("internal/worker/utils");

const {
    hostResolves,
    hostRejects,
    hostItemsTracker,
    hostItems,
    lookUpItem,
    workerItemsTracker,
    workerItems,
    getCurrentCache
} = require('internal/worker/cache');

const {
    IDS,
    EntityType,
    TypeCode,
    setThreadId,
    getThreadId,
    isOnHost,
    newId,
    newCallId,
} = require('internal/worker/state');

let workerPort = null;

const NewItemID = 'NewItemID';
const NewType = 'NewType';
const NewMemberID = 'NewMemberID';
const NewIsAsync = 'NewIsAsync';

const ReportedItemID = 'ReportedItemID';

const PrototypeID = 'PrototypeID';

function isAsync(func) {
    if (func?.constructor?.name === 'AsyncFunction') return true;
    const fnStr = func.toString();
    return fnStr.includes('__awaiter(') && fnStr.includes('function*');
}

function isClass(func) {
    return typeof func === 'function' && /^class\s/.test(Function.prototype.toString.call(func));
}

// Asynchronous inter-thread communication
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
            threadId: getThreadId(),
        });
    } catch (e) {
        logToFile(`W: postMessage call @ asyncType failed: ${e}`);
    }

    logToFile(`W: ->${W2H_CALL} callId=${callId} targetId=${targetId} functionId=${memberId} args=${print(args)} resultId=${resultId}`);

    logToFile('W: WaitCall before');
    const callResult = WaitCall(resultId, getThreadId());
    logToFile(`W: WaitCall after, callResult=${print(callResult)}`);

    mixInType(callResult);
    return callResult;
}

// Serialization

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

function saveObject(object, serialization) {
    const trackIsNeeded = object !== null && (typeof object === 'object' || typeof object === 'function');

    if (isOnHost()) {
        hostItems.set(serialization.NewItemID, object);
        if (trackIsNeeded) hostItemsTracker.set(object, serialization);
    } else {
        workerItems.set(serialization.NewItemID, object);
        if (trackIsNeeded) workerItemsTracker.set(object, serialization);
    }
}

function serializeFunction(func, targetId, memberId) {
    assert(typeof func === 'function', 'serializeFunction called with non-function');
    assert(targetId, `serializeFunction called with empty targetId: ${targetId}`);

    const type = isClass(func) ? EntityType.CLASS : EntityType.FUNCTION;
    const result = { NewItemID: targetId, NewMemberID: memberId, NewType: type, NewIsAsync: isAsync(func) };
    if (!memberId) saveObject(func, result);
    return result;
}

function serializeObject(object, objectId) {
    assert(object !== null && typeof object === 'object', 'serializeObject called with non-object');

    const result = { NewItemID: objectId, NewMemberID: null, NewType: EntityType.OBJECT, NewIsAsync: null };
    saveObject(object, result);

    let current = object;
    while (current && current !== Object.prototype) {
        if (current === Array.prototype) { result[PrototypeID] = 'Array'; break; }
        for (const memberId of Reflect.ownKeys(current)) {
            const value = object[memberId];
            if (isOnHost()) {
                const isPrimitive = (value === null || ['string','number','boolean','undefined','bigint','symbol'].includes(typeof value));
                if (isPrimitive) continue;
            }
            result[memberId] = doSerializeItem(value, objectId, String(memberId));
        }
        current = Object.getPrototypeOf(current);
    }
    return result;
}

function serializeItem(arg) {
    const result = doSerializeItem(arg);
    logToFile(`serializeItem(${print(arg)}) -> ${print(result)}`);
    return result;
}

function doSerializeItem(arg, targetId = null, memberId = null) {
    const objectsTracker = isOnHost() ? hostItemsTracker : workerItemsTracker;
    if (objectsTracker.has(arg)) return objectsTracker.get(arg);

    const proxyHandle = getProxyHandle(arg);
    if (proxyHandle) return proxyHandle;

    const id = targetId ?? newId();
    let result = arg;
    if (typeof arg === 'function') result = serializeFunction(arg, id, memberId);
    if (typeof arg === 'object' && arg !== null) result = serializeObject(arg, id + (memberId ? '.' + memberId : ''));
    return result;
}

// Deserialization
function deserializeItem(port, handle, dstStr = `deserialize(${print(handle)})`) {
    const threadStr = isOnHost() ? 'host' : 'worker';
    let result = handle;
    if (typeof handle === 'object' && handle !== null) {
        if (NewItemID in handle) {
            result = createItemProxy(port, handle);
            logToFile(`${dstStr} -> proxies[${handle[NewItemID]}]`);
        } else if (ReportedItemID in handle) {
            result = lookUpItem(handle[ReportedItemID]);
            logToFile(`${dstStr} -> ${threadStr}Items[${handle[ReportedItemID]}]`);
        }
    } else {
        logToFile(`${dstStr} -> ${print(result)}`);
    }
    return result;
}

// Proxy management
function commonFieldGetter(target, name, proxyStr) {
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

            let handle = {NewItemID: newItemId, NewMemberID: newMemberId, NewType: type}
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
    if (source.PrototypeID === 'Array') Object.setPrototypeOf(target, Array.prototype);
}

function createItemProxy(port, objectHandle) {
    const { NewItemID: itemId, NewMemberID: memberId, NewType: type, NewIsAsync: isAsync, ...remainingHandle } = objectHandle;
    assert(itemId, `itemId is not defined in objectHandle: ${print(objectHandle)}`);
    const fullId = itemId + (memberId ? `.${memberId}` : '');
    const isHostContext = isOnHost();
    const cache = getCurrentCache();
    if (cache.hasProxy(fullId)) return cache.getProxy(fullId);

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
            Object.assign(result, createProxyTag(fullId));
        } else if (type === EntityType.CLASS) {
            base = createFunctionProxy(port, itemId, memberId, isAsync, itemStr);
            Object.assign(base, createProxyTag(fullId));
        } else if (type === EntityType.OBJECT) {
            base = createProxyTag(fullId);
        }
        else assert(false, `createItemProxy unknown type ${type} id=${fullId}`);
        if (base) result = new Proxy(base, createProxyHandler(port, fullId, itemStr, proxyStr));
        cache.storeProxy(fullId, result);
        if (base) copyRemainingHandleFields(port, base, remainingHandle, itemStr);
    }
    return result;
}

function createWorkerFunctionProxy(port, targetId, memberId, isAsync, funcStr) {
    funcStr = (isAsync ? 'async ' : '') + funcStr;
    return function (...args) {
        const serializedArgs = args.map(serializeItem);
        const resultId = newId();
        port.postMessage({ type: H2W_CALL, targetId, memberId, args: serializedArgs, resultId, isAsync });
        logToFile(`H: ->${H2W_CALL} ${funcStr}(${print(serializedArgs)}) resultId=${resultId}`);
        return createItemProxy(port, { NewItemID: resultId, NewType: EntityType.OBJECT, NewIsAsync: isAsync });
    };
}

function createHostFunctionProxy(port, targetId, memberId, _isAsync, funcStr) {
    assert(typeof targetId === 'string', `W: createHostFunctionProxy non-string targetId: ${targetId}`);
    logToFile(`W: createHostFunctionProxy ${funcStr} for targetId=${targetId} memberId=${memberId}`);
    function hostFuncProxy(...args) {
        const serializedArgs = args.map(serializeItem);
        const argsStr = print(serializedArgs, false);
        const resultId = newId();
        logToFile(`W: call.1 ${funcStr}(${argsStr}), reserving resultId=${resultId}`);
        const callResult = asyncCall(port, targetId, memberId, serializedArgs, resultId);
        logToFile(`W: call.2 ${funcStr}(${argsStr}) callResult=${print(callResult)}`);

        let result = 'simpleValue' in callResult
            ? callResult.simpleValue
            : createItemProxy(port, {NewItemID: resultId, NewType: callResult.type});

        logToFile(`W: call.3 ${funcStr}(${argsStr}) resulted in ${result}`);
        return result;
    }
    Object.assign(hostFuncProxy, { IsFromChanges: true });
    return hostFuncProxy;
}

// Function call management
function callWorkerFunction(targetId, memberId, serializedArgs, resultId, isAsync) {
    let target = lookUpItem(targetId);

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
    const args = serializedArgs.map(arg => deserializeItem(workerPort, arg));
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
            workerPort.postMessage({
                type: W2H_PROMISE,
                resolve: true,
                objectId: resultId,
                result: serializeItem(res),
            });
        }, err => {
            logToFile(`W: ->${W2H_PROMISE} promise[${resultId}] rejected with ${print(err)}`);
            workerPort.postMessage({
                type: W2H_PROMISE,
                resolve: false,
                objectId: resultId,
                result: serializeItem(err),
            });
        });
    }
    logToFile(`W: callWorkerFunction resultId=${resultId} ${funcStr}(${argsStr}) via ${resultStr} -> ${print(result)}`);
    workerItems.set(resultId, result);
}

function callHostFunction(port, targetId, memberId, serializedArgs, resultId, fromThreadId) {
    let target = lookUpItem(targetId);

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
    const args = serializedArgs.map(arg => deserializeItem(port, arg));

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
    if (!ResumeCall(resultId, fromThreadId, result, code)) hostItems.set(resultId, result);
}

// Object property update management
function updateHostObject(port, targetId, propertyId, value) {
    const target = lookUpItem(targetId);
    target[propertyId] = deserializeItem(port, value);
    logToFile(`H: hostItems[${targetId}].${propertyId} := ${print(value)}`);
}

// Exported functions
function initWorker(id, port) {
    const sanitizedId = id.replace(/\./g, '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    setThreadId(sanitizedId);
    initLogFile(getThreadId());
    workerPort = port;
    logToFile(`Log initialized at ${new Date().toISOString()}\n`);
    setAPI('w:vscode', createItemProxy(port, { NewItemID: IDS.VSCODE + '#' + id, NewType: EntityType.OBJECT }));
    setAPI('w:context', createItemProxy(port, { NewItemID: IDS.CONTEXT + '#' + id, NewType: EntityType.OBJECT }));
    setInterval(() => { logToFile('W: Staying alive'); }, 15000);
}

function initHost(id) {
    initLogFile(getThreadId());
    const hostId = IDS.VSCODE + '#' + id;
    if (!hostItems.has(hostId)) hostItems.set(hostId, getAPI(`h:vscode.${id}`));
    const contextId = IDS.CONTEXT + '#' + id;
    if (!hostItems.has(contextId)) hostItems.set(contextId, getAPI(`h:context.${id}`));
}

function reactOnWorkerMessage(id, message, port) {
    initHost(id);

    if (message.type === W2H_CALL) {
        logToFile(`H: <-${W2H_CALL} callId=${message.callId} targetId=${message.targetId} functionId=${message.memberId} resultId=${message.resultId}`);
        callHostFunction(port, message.targetId, message.memberId, message.args, message.resultId, message.threadId);
        return true;
    }

    if (message.type === W2H_SET) {
        logToFile(`H: <-${W2H_SET}`);
        updateHostObject(port, message.targetId, message.propertyId, message.value);
        return true;
    }

    if (message.type === W2H_PROMISE) {
        const func = message.resolve ? hostResolves.get(message.objectId) : hostRejects.get(message.objectId);
        assert(typeof func === 'function', `H: promise handler for ${message.objectId} is not a function`);
        const funcStr = message.resolve ? 'resolve' : 'reject';
        logToFile(`H: <-${W2H_PROMISE} promise[${message.objectId}] to ${funcStr}(${print(message.result)})`);
        func(deserializeItem(port, message.result));
        return true;
    }

    if (message.type === W2H_TYPE) {
        logToFile(`H: <-${W2H_TYPE} id=${message.id} callId=${message.callId}`);
        const target = lookUpItem(message.id, false);
        const code = getTypeCode(target)
        logToFile(`H: about to return type for ${message.id} type=${code}`);
        ResumeType(message.id, target, code);
        return true;
    }

    return false
}

function reactOnHostMessage(message) {
    if (message.type === H2W_CALL) {
        logToFile(`W: <-${H2W_CALL} targetId=${message.targetId} functionId=${message.memberId} resultId=${message.resultId}`);
        callWorkerFunction(message.targetId, message.memberId, message.args, message.resultId, message.isAsync);
        return true;
    }

    return false;
}

module.exports = { initWorker, reactOnWorkerMessage, reactOnHostMessage };
