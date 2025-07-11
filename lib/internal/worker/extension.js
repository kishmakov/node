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

const LogFileHost = '/home/kishmakov/log_host.txt';
const LogFileWorker = '/home/kishmakov/log_worker.txt';

// communication ids for creating proxies on receiving side
const NewObjectID = 'NewObjectID';
const NewFunctionID = 'NewFunctionID';
const NewTargetID = 'NewTargetID';
const IsAsync = 'IsAsync';

const PrototypeID = 'PrototypeID';

// communication ids for finding existing objects on receiving side
const OldObjectID = 'OldObjectID';
const OldFunctionID = 'OldFunctionID';

const HObjProxyID = 'HObjProxyID';
const HFunProxyID = 'HFunProxyID';

const WObjProxyID = 'WObjProxyID';
const WFunProxyID = 'WFunProxyID';

let hostFunctions = new Map();
hostFunctions.set = function(key, value) {
    logToFile(`H: hostFunctions[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

let workerFunctions = new Map();
workerFunctions.set = function(key, value) {
    logToFile(`W: workerFunctions[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

let hostResolves = new Map();
let hostRejects = new Map();

let hostObjectsTracker = new WeakMap();
let hostObjects = new Map();
hostObjects.set = function(key, value) {
    logToFile(`H: hostObjects[${key}] := ${print(value)}`);
    if (typeof value === 'object' && value !== null) {
        hostObjectsTracker.set(value, key);
    }
    return Map.prototype.set.call(this, key, value);
};

let workerObjects = new Map();
workerObjects.set = function(key, value) {
    logToFile(`W: workerObjects[${key}] := ${print(value)}`);
    return Map.prototype.set.call(this, key, value);
};

let workerProxies = new Map();

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

function print(arg, shorten = true) {
    let result;

    try {
        if (typeof arg === 'object' && arg !== null) {
            if (arg.isProxy) {
                result = arg.toPrimitive();
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
    const file = (isOnHost() || message.startsWith('H: ')) ? LogFileHost : LogFileWorker;

    for (const prefix of ['W: ', 'WA: ', 'H: ']) {
        if (message.startsWith(prefix)) {
            message = message.substring(prefix.length);
        }
    }

    const result = message + '\n' + (printStack ? `stack: ${new Error().stack}\n` : '');

    fs.appendFile(file, result, (err) => {
        if (err) throw err;
    });
}

function isProbablyAsync(func) {
    if (func?.constructor?.name === 'AsyncFunction') return true;
    const fnStr = func.toString();
    return fnStr.includes('__awaiter(') && fnStr.includes('function*');
}

function lookUpObject(objects, compoundId) {
    if (!compoundId) return undefined;

    const ids = compoundId.split('.');

    let result = objects.get(ids[0]);
    for (let i = 1; i < ids.length; i++) {
        if (!result) break;
        result = result[ids[i]];
    }

    return result;
}

// Asynchronous inter-thread communication

function asyncType(port, id, name) {
    assert(id, `W: asyncType called with empty id`);
    try {
        port.postMessage({type: W2H_TYPE, id: id, name: name});
    } catch (e) {
        logToFile(`W: postMessage call @asyncType failed: ${e}`);
    }

    logToFile('WA: WaitType before ' + id + '.' + name);
    const typeResult = WaitType(id + '.' + name);
    logToFile(`WA: WaitType after, typeResult=${print(typeResult)}`);

    return typeResult;
}

function asyncCall(port, targetId, functionId, args, resultId) {
    let callId = newCallId();
    try {
        port.postMessage({
            type: W2H_CALL,
            callId: callId,
            targetId: targetId,
            functionId: functionId,
            args: args,
            resultId: resultId,
        });
    } catch (e) {
        logToFile(`W: postMessage call @asyncType failed: ${e}`);
    }

    logToFile(`W: ->${W2H_CALL} callId=${callId} targetId=${targetId} functionId=${functionId} args=${print(args)} resultId=${resultId}`);

    logToFile('WA: WaitCall before');
    const callResult = WaitCall(resultId);
    logToFile(`WA: WaitCall after, callResult=${print(callResult)}`);

    return callResult;
}

// Serialization

function serializeFunction(func, providedId = null, targetId = null) {
    const functionId = String(providedId ?? newId());
    if (!targetId) (isOnHost() ? hostFunctions : workerFunctions).set(functionId, func);
    return {NewFunctionID: functionId, NewTargetID: targetId, IsAsync: isProbablyAsync(func)};
}

function serializeObject(arg, providedId = null, seen = new WeakMap()) {
    if (arg === null || typeof arg !== 'object') return arg;
    if (seen.has(arg)) return seen.get(arg);

    const keyObj = isOnHost() ? WObjProxyID : HObjProxyID;
    const keyFun = isOnHost() ? WFunProxyID : HFunProxyID;

    if (keyObj in arg) return {OldObjectID: arg[keyObj]};
    if (keyFun in arg) return {OldFunctionID: arg[keyFun]};

    if (hostObjectsTracker.has(arg)) {
        return {NewObjectID: hostObjectsTracker.get(arg)};
    }

    const id = providedId ?? newId();
    (isOnHost() ? hostObjects : workerObjects).set(id, arg);

    const result = {NewObjectID: id};
    seen.set(arg, result);

    let current = arg;
    while (current && current !== Object.prototype) {
        if (current === Array.prototype) {
            result[PrototypeID] = 'Array';
            break;
        }

        for (const memberId of Reflect.ownKeys(current)) {
            const val = arg[memberId];
            if (typeof val === 'function') {
                result[memberId] = serializeFunction(val, memberId, id);
            } else if (typeof val === 'object') {
                result[memberId] = serializeObject(val, id + '.' + String(memberId), seen);
            } else {
                result[memberId] = val;
            }
        }

        current = Object.getPrototypeOf(current);
    }

    return result;
}

function serializeAtWorker(arg) {
    let result = arg;

    if (typeof arg === 'function') result = serializeFunction(arg);
    if (typeof arg === 'object' && arg !== null) result = serializeObject(arg);

    logToFile(`W: serialize(${print(arg)}) -> ${print(result)}`);
    return result;
}

function serializeAtHost(arg) {
    let result = arg;

    if (typeof arg === 'function') result = serializeFunction(arg);
    if (typeof arg === 'object' && arg !== null) result = serializeObject(arg);

    logToFile(`H: serialize(${print(arg)}) -> ${print(result)}`);
    return result;
}

// Deserialization

function deserializeAtHost(port, arg) {
    const dst = `deserialize(${print(arg)})`;

    let result = arg;

    if (typeof arg === 'object' && arg !== null) {
        if (NewObjectID in arg) {
            result = createWorkerObjectProxy(port, arg);
            logToFile(`H: ${dst} -> proxy[${arg[NewObjectID]}]`);
        }
        if (NewFunctionID in arg) {
            result = createWorkerFunctionProxy(port, arg);
            logToFile(`H: ${dst} -> method proxy[${arg[NewFunctionID]}]`);
        }
        if (OldObjectID in arg) {
            result = lookUpObject(hostObjects, arg[OldObjectID]);
            assert(result, `H: hostObjects[${arg[OldObjectID]}] not found`);
            logToFile(`H: ${dst} -> hostObjects[${arg[OldObjectID]}]`);
        }
        if (OldFunctionID in arg) {
            result = hostFunctions.get(arg[OldFunctionID]);
            assert(result, `H: hostFunctions[${arg[OldFunctionID]}] not found`);
            logToFile(`H: ${dst} -> hostFunctions[${arg[OldFunctionID]}]`);
        }
    } else {
        logToFile(`H: ${dst} -> ${print(result)}`);
    }
    
    return result;
}

function deserializeAtWorker(port, arg) {
    const dst = `deserialize(${print(arg)})`;

    let result = arg;

    if (typeof arg === 'object' && arg !== null) {
        if (NewObjectID in arg) {
            result = createHostObjectProxy(port, arg);
            logToFile(`W: ${dst} -> proxy[${arg[NewObjectID]}]`);
        }
        if (NewFunctionID in arg) {
            result = createHostFunctionProxy(port, arg);
            logToFile(`W: ${dst} -> method proxy[${arg[NewFunctionID]}]`);
        }
        if (OldObjectID in arg) {
            result = lookUpObject(workerObjects, arg[OldObjectID]);
            assert(result, `W: workerObjects[${arg[OldObjectID]}] not found`);
            logToFile(`W: ${dst} -> workerObjects[${arg[OldObjectID]}]`);
        }
        if (OldFunctionID in arg) {
            result = workerFunctions.get(arg[OldFunctionID]);
            assert(result, `W: workerFunctions[${arg[OldFunctionID]}] not found`);
            logToFile(`W: ${dst} -> workerFunctions[${arg[OldFunctionID]}]`);
        }
    } else {
        logToFile(`W: ${dst} -> ${print(result)}`);
    }

    return result;
}

// Proxy management

function createWorkerObjectProxy(port, objectHandle) {
    const {NewObjectID: objectId, IsAsync: isAsync, ...remainingHandle} = objectHandle;
    logToFile(`H: creating object proxy for id=${objectId} async=${isAsync}`);

    if (isAsync) {
        return new Promise((resolve, reject) => {
            logToFile(`H: filling in hostResolves and hostRejects for id=${objectId}`);
            hostResolves.set(objectId, resolve);
            hostRejects.set(objectId, reject);
        });
    }

    let base = {WObjProxyID: objectId, ...remainingHandle};

    for (const memberId of Reflect.ownKeys(remainingHandle)) {
        const val = objectHandle[memberId];
        base[memberId] = val;

        const dst = `proxy[${objectId}].'${String(memberId)}'`;

        if (typeof val === 'object' && val !== null) {
            if (NewObjectID in val) {
                base[memberId] = createWorkerObjectProxy(port, val);
                logToFile(`H: ${dst} := proxy[${val[NewObjectID]}]`);
            }
            if (NewFunctionID in val) {
                base[memberId] = createWorkerFunctionProxy(port, val);
                logToFile(`H: ${dst} := method proxy[${val[NewFunctionID]}]`);
            }
            if (OldObjectID in val) {
                base[memberId] = lookUpObject(hostObjects, val[OldObjectID]);
                assert(base[memberId], `H: hostObjects[${val[OldObjectID]}] not found`);
                logToFile(`H: ${dst} := hostObjects[${val[OldObjectID]}]`);
            }
            if (OldFunctionID in val) {
                base[memberId] = hostFunctions.get(val[OldFunctionID]);
                assert(base[memberId], `H: hostFunctions[${val[OldFunctionID]}] not found`);
                logToFile(`H: ${dst} := hostFunctions[${val[OldFunctionID]}]`);
            }
        } else {
            logToFile(`H: ${dst} := ${print(val)}`);
        }
    }

    if (objectHandle.PrototypeID === 'Array') {
        Object.setPrototypeOf(base, Array.prototype);
    }

    const handler = {
        __proto__: null,
        get(target, name) {
            if (name === 'toPrimitive' || name === Symbol.toPrimitive) return () => `wproxy[${objectId}]`;
            if (name === 'isProxy') return true;
            logToFile(`H: get proxy[${objectId}].'${String(name)}' resulted in ${print(target[name])}`);
            return target[name];
        },

        set(target, name, value) {
            logToFile(`H: >>> set proxy[${objectId}] good luck!`);
            return true;
        }
    };

    return new Proxy(base, handler);
}

function createHostObjectProxy(port, objectHandle) {
    const {NewObjectID: objectId, ...remainingHandle} = objectHandle;
    if (workerProxies.has(objectId)) return workerProxies.get(objectId);

    logToFile(`W: creating object proxy for id=${objectId}`);

    let base = {HObjProxyID: objectId, ...remainingHandle};

    for (const memberId of Reflect.ownKeys(remainingHandle)) {
        const val = objectHandle[memberId];
        base[memberId] = val;

        const dst = `proxy[${objectId}].'${String(memberId)}'`;

        if (typeof val === 'object' && val !== null) {
            if (NewObjectID in val) {
                base[memberId] = createHostObjectProxy(port, val);
                logToFile(`W: ${dst} := proxy[${val[NewObjectID]}]`);
            }
            if (NewFunctionID in val) {
                base[memberId] = createHostFunctionProxy(port, val);
                logToFile(`W: ${dst} := method proxy[${val[NewFunctionID]}]`);
            }
            if (OldObjectID in val) {
                base[memberId] = lookUpObject(workerObjects, val[OldObjectID]);
                assert(base[memberId], `W: workerObjects[${val[OldObjectID]}] not found`);
                logToFile(`W: ${dst} := workerObjects[${val[OldObjectID]}]`);
            }
            if (OldFunctionID in val) {
                base[memberId] = workerFunctions.get(val[OldFunctionID]);
                assert(base[memberId], `H: workerFunctions[${val[OldFunctionID]}] not found`);
                logToFile(`W: ${dst} := workerFunctions[${val[OldFunctionID]}]`);
            }
        } else {
            logToFile(`W: ${dst} := ${print(val)}`);
        }
    }

    const handler = {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];

            if (name === Symbol.iterator) return function* () {};
            if (name === 'toPrimitive' || name === Symbol.toPrimitive) return () => `hproxy[${objectId}]`;
            if (name === 'isProxy') return true;
            if (name === 'forEach') { return function(callback, thisArg) {}; }  // TODO: provide real forEach
            if (name === '__esModule') return true; // TODO: workaround?

            logToFile(`W: get.1 proxy[${objectId}].'${String(name)}', querying type ...`);
            const typeResult = asyncType(port, objectId, String(name));

            let result
            if (typeResult.isFunction) {
                result = createHostFunctionProxy(port, {NewTargetID: objectId, NewFunctionID: name});
            } else if ('simpleValue' in typeResult) {
                result = typeResult.simpleValue;
            } else {
                result = createHostObjectProxy(port, {NewObjectID: objectId + "." + name});
            }

            logToFile(`W: get.3 proxy[${objectId}].'${String(name)}' resulted in ${print(result)}`);
            return result;
        },
        set(target, name, value) {
            if (name === 'buttons') {
                logToFile(`W: original.iconPath = ${print(value[0], false)}`);
            }

            const serializedValue = serializeAtWorker(value);

            if (name === 'buttons') {
                const button = serializedValue[0];
                logToFile(`W: button.iconPath = ${print(button, false)}`);
            }

            port.postMessage({
                type: W2H_SET,
                targetId: objectId,
                propertyId: name,
                value: serializedValue
            });

            logToFile(`W: set proxy[${objectId}].'${String(name)}' to ${print(serializedValue)}`);
            return true;
        }
    };

    const result = new Proxy(base, handler);
    workerProxies.set(objectId, result);
    return result;
}

function createWorkerFunctionProxy(port, functionHandle) {
    const {NewTargetID: targetId, NewFunctionID: functionId, IsAsync: isAsync} = functionHandle;
    const prefix = isAsync ? 'async ' : '';
    const funcStr = prefix + (targetId
        ? `workerObjects[${targetId}].${functionId}`
        : `workerFunctions[${functionId}]`);

    return function (...args) {
        let serializedArgs = args.map(serializeAtHost);

        const resultId = newId();

        port.postMessage({
            type: H2W_CALL,
            targetId: targetId,
            functionId: functionId,
            args: serializedArgs,
            resultId: resultId,
            isAsync: isAsync,
        });

        logToFile(`H: ->${H2W_CALL} ${funcStr}(${print(serializedArgs)}) resultId=${resultId}`);
        return createWorkerObjectProxy(port, {NewObjectID: resultId, IsAsync: isAsync});
    };
}

function createHostFunctionProxy(port, functionHandle) {
    const {NewTargetID: targetId, NewFunctionID: functionId} = functionHandle;
    const funcStr = targetId ? `hostObjects[${targetId}].${functionId}` : `hostFunctions[${functionId}]`;
    logToFile(`W: Creating method proxy for ${funcStr}`);

    return function (...args) {
        const serializedArgs = args.map(serializeAtWorker);
        const argsStr = print(serializedArgs);

        const resultId = newId();
        logToFile(`W: call.1 ${funcStr}(${argsStr}), reserving resultId=${resultId}`);

        const callResult = asyncCall(port, targetId, functionId, serializedArgs, resultId);
        logToFile(`W: call.2 ${funcStr}(${argsStr}) callResult=${print(callResult)}`);

        let result = 'simpleValue' in callResult
            ? callResult.simpleValue
            : createHostObjectProxy(port, {NewObjectID: resultId});

        logToFile(`W: call.3 ${funcStr}(${argsStr}) resulted in ${result}`);
        return result;
    };
}

// Function call management

function callWorkerFunction(targetId, functionId, serializedArgs, resultId, isAsync) {
    const target = lookUpObject(workerObjects, targetId);

    let func;
    let funcStr = isAsync ? 'async ' : '';

    if (target) {
        assert(functionId in target, `W: ${functionId} not found in workerObjects[${targetId}]`);
        func = target[functionId];
        funcStr += `workerObjects[${targetId}].${functionId}`;
    } else {
        assert(workerFunctions.has(functionId), `W: workerFunctions[${functionId}] can't be found`);
        func = workerFunctions.get(functionId);
        funcStr += `workerFunctions[${functionId}]`;
    }

    logToFile(`W: callWorkerFunction for ${funcStr}(${print(serializedArgs)})`);
    const args = serializedArgs.map(arg => deserializeAtWorker(workerPort, arg));

    let result = undefined;
    try {
        result = func.apply(target, args);
    } catch (e) {
        console.warn(`W: failed to call ${funcStr}: ${e}\nW: func=${func}`);
    }

    if (isAsync && !!result) {
        result.then(res => {
            logToFile(`W: ->${W2H_PROMISE} promise[${resultId}] resolved with ${print(res)}`);
            workerPort.postMessage({
                type: W2H_PROMISE,
                resolve: true,
                objectId: resultId,
                result: serializeAtWorker(res),
            });
        }, err => {
            logToFile(`W: ->${W2H_PROMISE} promise[${resultId}]  rejected with ${print(err)}`);
            workerPort.postMessage({
                type: W2H_PROMISE,
                resolve: false,
                objectId: resultId,
                result: serializeAtWorker(err),
            });
        });
    }

    serializeObject(result, resultId);
}

function callHostFunction(port, targetId, functionId, serializedArgs, resultId) {
    const target = lookUpObject(hostObjects, targetId);

    let func;
    let funcStr;

    if (target) {
        assert(functionId in target, `H: ${functionId} not found in hostObjects[${targetId}]`);
        func = target[functionId];
        funcStr = `hostObjects[${targetId}].${functionId}`;
    } else {
        assert(hostFunctions.has(functionId), `H: hostFunctions[${functionId}] can't be found`);
        func = hostFunctions.get(functionId);
        funcStr = `hostFunctions[${functionId}]`;
    }

    const argsStr = print(serializedArgs);
    const args = serializedArgs.map(arg => deserializeAtHost(port, arg));

    let result = undefined;
    let resultStr = undefined;

    try { // try constructor first
        result = Reflect.construct(func, args);
        resultStr = 'via construct';
    } catch (constructError) {
        try { // fall back to regular function call
            result = func.apply(target, args);
            resultStr = 'via apply';
        } catch (applyError) {
            console.warn(`H: callHostFunction for ${funcStr} failed: ${applyError}\nH: func=${func}`);
        }
    }

    logToFile(`H: callHostFunction for ${funcStr}(${argsStr}) resulted ${resultStr} in ${print(result)}`);
    if (!ResumeCall(resultId, result)) hostObjects.set(resultId, result);
}

// Object property update management

function updateHostObject(port, targetId, propertyId, value) {
    const target = lookUpObject(hostObjects, targetId);
    assert(target, `H: ${targetId} not found in hostObjects`);
    target[propertyId] = deserializeAtHost(port, value);
    logToFile(`H: hostObjects[${targetId}].${propertyId} := ${print(value)}`);
}

// Exported functions

function initWorker(id, port) {
    threadId = id.replace(/\./g, '');
    workerPort = port;

    const date = `Log initialized at ${new Date().toISOString()}\n`;
    logToFile('W: ' + date);
    logToFile('H: ' + date);

    setAPI('w:vscode', createHostObjectProxy(port, {NewObjectID: IDS.VSCODE}));
    setAPI('w:context', createHostObjectProxy(port, {NewObjectID: IDS.CONTEXT}));

    setInterval(() => {
        logToFile('W: Staying alive');
    }, 15000);
}

function reactOnWorkerMessage(message, port) {
    if (hostObjects.size === 0) {
        hostObjects.set(IDS.VSCODE, getAPI('h:vscode'));
        hostObjects.set(IDS.CONTEXT, getAPI('h:context'));
    }

    if (message.type === W2H_CALL) {
        logToFile(`H: <-${W2H_CALL} callId=${message.callId}`);
        callHostFunction(port, message.targetId, message.functionId, message.args, message.resultId);
        return true;
    }

    if (message.type === W2H_SET) {
        logToFile(`H: <-${W2H_SET}`);
        updateHostObject(port, message.targetId, message.propertyId, message.value);
        return true;
    }

    if (message.type === W2H_PROMISE) {
        const func = message.resolve ? hostResolves.get(message.objectId) : hostRejects.get(message.objectId);
        const funcStr = message.resolve ? 'resolve' : 'reject';
        logToFile(`H: <-${W2H_PROMISE} promise[${message.objectId}] to ${funcStr}(${print(message.result)})`);
        func(deserializeAtHost(port, message.result));
        return true;
    }

    if (message.type === W2H_TYPE) {
        const target = lookUpObject(hostObjects, message.id)
        assert(target, `H: ${message.id} not found in hostObjects`);
        logToFile(`H: <-${W2H_TYPE} id=${message.id} name=${message.name} target=${print(target)}`);
        const member = target[message.name];
        ResumeType(message.id + '.' + message.name, member, false);
        return true;
    }

    return false
}

function reactOnHostMessage(message) {
    if (message.type === H2W_CALL) {
        logToFile(`W: <-${H2W_CALL}`);
        callWorkerFunction(message.targetId, message.functionId, message.args, message.resultId, message.isAsync);
        return true;
    }

    return false;
}

module.exports = {
    initWorker,

    reactOnWorkerMessage,
    reactOnHostMessage,
};