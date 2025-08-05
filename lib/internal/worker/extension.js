'use strict';

const {
    messageTypes: {
        H2W_CALL,
        W2H_CALL,
        W2H_PROMISE,
        W2H_SET,
        W2H_TYPE,
    }
} = require('internal/worker/io');
const assert = require('internal/assert');
const fs = require('fs');
const {
    getAPI,
    setAPI,
} = require("internal/util");

let workerPort = null;

const IDS = {
    CONTEXT: 'context',
    VSCODE: 'vscode',
    HOST: 'host',
};

let threadId = IDS.HOST;

// communication ids for creating proxies on receiving side
const NewItemID = 'NewItemID';
const NewType = 'NewType';
const NewMemberID = 'NewMemberID';
const NewIsAsync = 'NewIsAsync';

const ReportedItemID = 'ReportedItemID';

const PrototypeID = 'PrototypeID';

const HProxyItemID = 'HProxyItemID';
const WProxyItemID = 'WProxyItemID';

let hostResolves = new Map();
hostResolves.set = function(key, value) {
    logToFile(`H: hostResolves[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

let hostRejects = new Map();
hostRejects.set = function(key, value) {
    logToFile(`H: hostRejects[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};


let hostItemsTracker = new WeakMap();
let hostItems = new Map();
hostItems.set = function(key, value) {
    const valueStr = Object.values(IDS).includes(key) ? key.toUpperCase() : print(value);
    logToFile(`H: hostItems[${key}] := ${valueStr}`);
    return Map.prototype.set.call(this, key, value);
};

let workerItemsTracker = new WeakMap();
let workerItems = new Map();
workerItems.set = function(key, value) {
    logToFile(`W: workerItems[${key}] := ${print(value)}`);
    if (typeof value === 'object' && value !== null) {
        workerItemsTracker.set(value, key);
    }

    return Map.prototype.set.call(this, key, value);
};

let workerProxies = new Map();
workerProxies.set = function(key, value) {
    assert(Map.prototype.has.call(this, key) === false, 'workerProxies already has key: ' + key);
    logToFile(`H: workerProxies[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

let hostProxies = new Map();
hostProxies.set = function(key, value) {
    assert(Map.prototype.has.call(this, key) === false, 'hostProxies already has key: ' + key);
    logToFile(`W: hostProxies[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

function isOnHost() { return IDS.HOST === threadId; }

const newId = (function() {
    let counter = 0; // private counter

    return function() {
        return threadId + ':' + counter++;
    };
})();

const newCallId = (function() {
    let counter = 0; // private counter
    return function() { return  counter++; };
})();

function print(arg, shorten = false) {
    let result;

    try {
        if (typeof arg === 'object' && arg !== null) {
            if (arg.isProxy) {
                result = arg.toPrimitive();
            } else if ('then' in arg && typeof arg.then === 'function') {
                result = '[Promise]';
            } else {
                result = JSON.stringify(arg);
            }
        } else {
            result = String(arg);
        }
    } catch (e) {
        result = arg?.constructor?.name + `, stringify failed: ${e}`;
    }

    result = result.replace(/\r?\n/g, '\\n').replace(/\s+/g, ' ');

    if (shorten && result.length > 99) {
        result = result.substring(0, 97) + '...';
    }

    return result;
}

function logToFile(message, printStack = false) {
    const prefixWorker = 'W: ';
    const prefixHost = 'H: ';

    if (message.startsWith(prefixWorker)) {
        message = message.substring(prefixWorker.length);
    } else if (message.startsWith(prefixHost)) {
        message = message.substring(prefixHost.length);
    }

    const result = message + '\n' + (printStack ? `stack: ${new Error().stack}\n` : '');
    const id = threadId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    fs.appendFileSync(`/home/kishmakov/log_${id}.txt`, result);
}

function isAsync(func) {
    if (func?.constructor?.name === 'AsyncFunction') return true;
    const fnStr = func.toString();
    return fnStr.includes('__awaiter(') && fnStr.includes('function*');
}

function isClass(func) {
    return typeof func === 'function' &&
        /^class\s/.test(Function.prototype.toString.call(func));
}

function lookUpItem(compoundId, mustFind = true) {
    if (!compoundId) return undefined;
    const objects = isOnHost() ? hostItems : workerItems;
    const ids = compoundId.split('.');

    let result = objects.get(ids[0]);
    for (let i = 1; i < ids.length; i++) {
        if (!result) break;
        result = result[ids[i]];
    }

    if (mustFind) {
        const objectsStr = isOnHost() ? 'hostItems' : 'workerItems';
        assert(result !== undefined, `${objectsStr}[${compoundId}] not found\nstack: ${new Error().stack}\n` );
    }
    return result;
}

// Asynchronous inter-thread communication

function asyncType(port, id) {
    assert(typeof id === 'string', `W: asyncType called with nonstring id`);
    let callId = newCallId();

    try {
        port.postMessage({type: W2H_TYPE, id: id, callId: callId});
    } catch (e) {
        logToFile(`W: postMessage call @ asyncType failed: ${e}`); // id = ${typeof id} + name = ${typeof name}
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
        });
    } catch (e) {
        logToFile(`W: postMessage call @ asyncType failed: ${e}`);
    }

    logToFile(`W: ->${W2H_CALL} callId=${callId} targetId=${targetId} functionId=${memberId} args=${print(args)} resultId=${resultId}`);

    logToFile('W: WaitCall before');
    const callResult = WaitCall(resultId);
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

const EntityType = Object.freeze({
    OBJECT: 'OBJECT',
    CLASS: 'CLASS',
    FUNCTION: 'FUNCTION',
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
    if (result.code === TypeCode.OBJECT) {
        result.type = EntityType.OBJECT;
    } else if (result.code === TypeCode.FUNCTION) {
        result.type = EntityType.FUNCTION;
    } else if (result.code === TypeCode.CLASS) {
        result.type = EntityType.CLASS;
    }
}

function saveObject(object, serialization) {
    const trackIsNeeded = object !== null &&
        (typeof object === 'object' || typeof object === 'function');

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
    const result = {NewItemID: targetId, NewMemberID: memberId, NewType: type, NewIsAsync: isAsync(func)};
    if (!memberId) saveObject(func, result); // save only non-member functions

    return result;
}

function serializeObject(object, objectId) {
    assert(object !== null && typeof object === 'object', 'serializeObject called with non-object');

    const result = {NewItemID: objectId, NewMemberID: null, NewType: EntityType.OBJECT, NewIsAsync: null};
    saveObject(object, result);

    let current = object;
    while (current && current !== Object.prototype) {
        if (current === Array.prototype) {
            result[PrototypeID] = 'Array';
            break;
        }

        for (const memberId of Reflect.ownKeys(current)) {
            const value = object[memberId];
            if (isOnHost()) {
                const isPrimitive = (
                    value === null ||
                    typeof value === 'string' ||
                    typeof value === 'number' ||
                    typeof value === 'boolean' ||
                    typeof value === 'undefined' ||
                    typeof value === 'bigint' ||
                    typeof value === 'symbol'
                );

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

    if (arg !== null && (typeof arg === 'object' || typeof arg === 'function')) {
        const proxyIdKey = isOnHost() ? WProxyItemID : HProxyItemID;
        if (proxyIdKey in arg) return {ReportedItemID: arg[proxyIdKey]};
    }

    const id = targetId ?? newId();

    let result = arg;

    if (typeof arg === 'function') result = serializeFunction(arg, id, memberId);
    if (typeof arg === 'object' && arg !== null) {
        result = serializeObject(arg, id + (memberId ? '.' + memberId : ''));
    }

    return result;
}

// Deserialization

function deserializeItem(port, handle, dstStr = `deserialize(${print(handle)})`) {
    const threadStr = isOnHost() ? 'host' : 'worker';

    let result = handle;

    if (typeof handle === 'object' && handle !== null) {
        if (NewItemID in handle) {
            result = createItemProxy(port, handle);
            const proxyStr = isOnHost() ? 'workerProxies' : 'hostProxies';
            logToFile(`${dstStr} -> ${proxyStr}[${handle[NewItemID]}]`);
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

function commonFieldGetter(name, proxyStr) {
    if (name === Symbol.iterator) return function* () {};
    if (name === 'isProxy') return true;
    if (name === 'forEach') { return function(callback, thisArg) {}; }  // TODO: provide real forEach
    if (name === '__esModule') return true; // TODO: workaround?
    if (name === 'toPrimitive' || name === Symbol.toPrimitive) return () => proxyStr;
}

function createWorkerProxyHandler(port, itemId, itemStr, proxyStr) {
    return {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            const value = commonFieldGetter(name, proxyStr);

            if (Object.isExtensible(target) && value !== undefined) {
                target[name] = value;
            }

            logToFile(`H: get ${itemStr}.'${String(name)}' resulted in ${print(value)}`);
            return value;
        },

        set(target, name, value) {
            const memberStr = `${itemStr}.'${String(name)}'`;
            logToFile(`H: >>> set ${memberStr} is not supported!`);
            return true;
        }
    };
}

function createHostProxyHandler(port, itemId, itemStr, proxyStr) {
    return {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            const memberId = itemId + '.' + String(name);
            const memberStr = `${itemStr}.'${String(name)}'`;
            const value = commonFieldGetter(name, proxyStr);
            if (value) {
                target[name] = value;
                return value;
            }

            if (!(name in target)) {
                logToFile(`W: get ${memberStr} needs call to host ...`);
                const typeResult = asyncType(port, memberId);

                if ('simpleValue' in typeResult) {
                    return typeResult.simpleValue;
                    // target[name] = typeResult.simpleValue;
                } else {
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
                }
            }

            logToFile(`W: get ${memberStr} resulted in ${print(target[name])}`);
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

    const proxiesMap = isHostContext ? workerProxies : hostProxies;
    if (proxiesMap.has(fullId)) return proxiesMap.get(fullId);

    logToFile(`createItemProxy context=${isHostContext ? 'worker' : 'host'} id=${itemId} member=${memberId} type=${type} async=${isAsync}`);

    let result;
    const proxyTagKey = isHostContext ? WProxyItemID : HProxyItemID;
    const proxyTag = { [proxyTagKey]: fullId };
    const proxyStr = `ProxiedID: ${fullId}, Type: ${type}`;
    const itemStr = `${isHostContext ? 'workerProxies' : 'hostProxies'}[${itemId}]` + (memberId ? `.${memberId}` : '');

    if (isHostContext && type === EntityType.OBJECT && isAsync) {
        result = new Promise((resolve, reject) => {
            logToFile(`filling in hostResolves and hostRejects for id=${itemId}`);
            hostResolves.set(itemId, resolve);
            hostRejects.set(itemId, reject);
        });
    } else {
        const createFunctionProxy = isHostContext ? createWorkerFunctionProxy : createHostFunctionProxy;
        const createProxyHandler = isHostContext ? createWorkerProxyHandler : createHostProxyHandler;

        if (type === EntityType.FUNCTION) {
            result = createFunctionProxy(port, itemId, memberId, isAsync, itemStr);
            proxiesMap.set(fullId, result);
            Object.assign(result, proxyTag);
        } else if (type === EntityType.CLASS) {
            const base = createFunctionProxy(port, itemId, memberId, isAsync, itemStr);
            Object.assign(base, proxyTag);
            const handler = createProxyHandler(port, fullId, itemStr, proxyStr);
            result = new Proxy(base, handler);
            proxiesMap.set(fullId, result);
            copyRemainingHandleFields(port, base, remainingHandle, itemStr);
        } else if (type === EntityType.OBJECT) {
            const base = proxyTag;
            const handler = createProxyHandler(port, fullId, itemStr, proxyStr);
            result = new Proxy(base, handler);
            proxiesMap.set(fullId, result);
            copyRemainingHandleFields(port, base, remainingHandle, itemStr);
        } else { // unreachable
            assert(false, `createItemProxy called with unknown type ${type} for id=${fullId}`);
        }
    }

    return result;
}

function createWorkerFunctionProxy(port, targetId, memberId, isAsync, funcStr) {
    funcStr = (isAsync ? 'async ' : '') + funcStr;

    return function (...args) {
        let serializedArgs = args.map(serializeItem);

        const resultId = newId();

        port.postMessage({
            type: H2W_CALL,
            targetId: targetId,
            memberId: memberId,
            args: serializedArgs,
            resultId: resultId,
            isAsync: isAsync,
        });

        logToFile(`H: ->${H2W_CALL} ${funcStr}(${print(serializedArgs)}) resultId=${resultId}`);

        let resultHandle = {NewItemID: resultId, NewType: EntityType.OBJECT, NewIsAsync: isAsync}
        return createItemProxy(port, resultHandle);
    };
}

function createHostFunctionProxy(port, targetId, memberId, _isAsync, funcStr) {
    assert(typeof targetId === 'string', `W: createHostFunctionProxy called with non-string targetId: ${targetId}`);
    logToFile(`W: createHostFunctionProxy ${funcStr} for targetId=${targetId} memberId=${memberId}`);

    let result = function (...args) {
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

    Object.assign(result, {IsFromChanges: true});
    return result;
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
            console.warn(`W: callWorkerFunction for ${funcStr} failed: ${applyError}\nW: func=${func}`);
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

    logToFile(`W: callWorkerFunction resultId=${resultId} ${funcStr}(${argsStr}) resulted via ${resultStr} in ${print(result)}`);
    workerItems.set(resultId, result);
}

function callHostFunction(port, targetId, memberId, serializedArgs, resultId) {
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
            console.warn(`H: callHostFunction for ${funcStr} failed: ${applyError}\nH: func=${func}`);
        }
    }
    const code = getTypeCode(result);
    logToFile(`H: callHostFunction for ${funcStr}(${argsStr}) resulted via ${resultStr} in ${print(result)} type=${code}`);
    if (!ResumeCall(resultId, result, code)) hostItems.set(resultId, result);
}

// Object property update management

function updateHostObject(port, targetId, propertyId, value) {
    const target = lookUpItem(targetId);
    target[propertyId] = deserializeItem(port, value);
    logToFile(`H: hostItems[${targetId}].${propertyId} := ${print(value)}`);
}

// Exported functions

function initWorker(id, port) {
    threadId = id.replace(/\./g, '');
    workerPort = port;

    logToFile(`Log initialized at ${new Date().toISOString()}\n`);

    setAPI('w:vscode', createItemProxy(port, {NewItemID: IDS.VSCODE + '#' + id, NewType: EntityType.OBJECT}));
    setAPI('w:context', createItemProxy(port, {NewItemID: IDS.CONTEXT + '#' + id, NewType: EntityType.OBJECT}));

    setInterval(() => {
        logToFile('W: Staying alive');
    }, 15000);
}

function initHost(id) {
    const hostId = IDS.VSCODE + '#' + id;
    if (!hostItems.has(hostId)) {
        const host = getAPI(`h:vscode.${id}`)
        hostItems.set(hostId, host);
    }

    const contextId = IDS.CONTEXT + '#' + id;
    if (!hostItems.has(contextId)) {
        const context = getAPI(`h:context.${id}`)
        hostItems.set(contextId, context);
    }
}

function reactOnWorkerMessage(id, message, port) {
    initHost(id);

    if (message.type === W2H_CALL) {
        logToFile(`H: <-${W2H_CALL} callId=${message.callId} targetId=${message.targetId} functionId=${message.memberId} resultId=${message.resultId}`);
        callHostFunction(port, message.targetId, message.memberId, message.args, message.resultId);
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

module.exports = {
    initWorker,

    reactOnWorkerMessage,
    reactOnHostMessage,
};
