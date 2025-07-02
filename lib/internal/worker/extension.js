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

// ID related constants and stuff

const newId = (function() {
    let counter = 0; // private counter

    return function() {
        return threadId + ':' + counter++;
    };
})();

let threadId = 'host';

const IDS = {
    CONTEXT: 'context',
    VSCODE: 'vscode',
};

const LogFileHost = '/home/kishmakov/log_host.txt';
const LogFileWorker = '/home/kishmakov/log_worker.txt';

const MethodTargetID = 'MethodTargetID';
const IsAsync = 'IsAsync';

// communication ids for creating proxies on receiving side
const NewObjectID = 'NewObjectID';
const NewFunctionID = 'NewFunctionID';
const NewTargetID = 'NewTargetID';

// communication ids for finding existing objects on receiving side
const OldObjectID = 'OldObjectID';
const OldFunctionID = 'OldFunctionID';

const HObjProxyID = 'HObjProxyID';
const HFunProxyID = 'HFunProxyID';

const WObjProxyID = 'WObjProxyID';
const WFunProxyID = 'WFunProxyID';

let hostFunctions = new Map();
let workerFunctions = new Map();

let hostResolves = new Map();
let hostRejects = new Map();

let hostObjects = new Map();
let workerObjects = new Map();

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

function print(arg) {
    let result;

    try {
        if (typeof arg === 'object' && arg !== null) {
            result = JSON.stringify(arg);
        } else {
            result = String(arg).replace(/\r?\n/g, '\\n');
        }
    } catch (e) {
        result = arg?.constructor?.name + `, stringify failed: ${e}`;
    }
    if (typeof result === 'string' && result.length > 97) {
        result = result.substring(0, 97) + '...';
    }

    return result;
}

function shorten(arg) {
    let result = String(arg).replace(/\r?\n/g, '\\n');

    if (result.length > 97) {
        result = result.substring(0, 97) + '...';
    }

    return result;
}

function logToFile(message) {
    const file = message.startsWith('H: ') ? LogFileHost : LogFileWorker;

    for (const prefix of ['W: ', 'WA: ', 'H: ']) {
        if (message.startsWith(prefix)) {
            message = message.substring(prefix.length);
        }
    }

    fs.appendFile(file, message + '\n', (err) => {
        if (err) throw err;
    });
}

// Asynchronous inter-thread communication

function asyncType(port, id, name) {
    assert(id, `W: asyncType called with empty id`);
    try {
        port.postMessage({type: W2H_TYPE, id: id, name: name});
    } catch (e) {
        logToFile(`W: postMessage call @asyncType failed: ${e}`);
    }

    logToFile('WA: WaitType before');
    const typeResult = WaitType(id + '.' + name);
    logToFile(`WA: WaitType after, typeResult=${print(typeResult)}`);

    return typeResult;
}

function asyncCall(port, targetId, functionId, args, resultId) {
    try {
        port.postMessage({
            type: W2H_CALL,
            targetId: targetId,
            functionId: functionId,
            args: args,
            resultId: resultId,
        });
    } catch (e) {
        logToFile(`W: postMessage call @asyncType failed: ${e}`);
    }

    logToFile(`W: ->${W2H_CALL} targetId=${targetId} functionId=${functionId} args=${args} ${resultId}`);

    logToFile('WA: WaitCall before');
    const callResult = WaitCall(resultId);
    logToFile(`WA: WaitCall after, callResult=${print(callResult)}`);

    return callResult;
}

// Serialization

function serializeFunctionAtWorker(func, providedId = null, targetId = null) {
    const functionId = String(providedId ?? newId());
    workerFunctions.set(functionId, func);
    logToFile(`W: workerFunctions[${functionId}] := ${shorten(func)}`);
    return {NewFunctionID: functionId, NewTargetID: targetId, IsAsync: isProbablyAsync(func)};
}

function serializeFunctionAtHost(func, providedId = null, targetId = null) {
    const functionId = String(providedId ?? newId());
    hostFunctions.set(functionId, func);
    logToFile(`H: hostFunctions[${functionId}] := ${shorten(func)}`);
    return {NewFunctionID: functionId, NewTargetID: targetId, IsAsync: isProbablyAsync(func)};
}

function checkMissingGetters(src, dst) {
    if (!dst || typeof dst !== 'object' || typeof dst.hasOwnProperty !== 'function') return;

    let current = src;
    while (current && current !== Object.prototype) {
        for (const memberId of Reflect.ownKeys(current)) {
            if (!dst.hasOwnProperty(memberId)) {
                throw error('Discrepancy found');
            }

            checkMissingGetters(src[memberId], dst[memberId]);
        }

        current = Object.getPrototypeOf(current);
    }
}

function serializeObjectAtWorker(arg, providedId = null, seen = new WeakMap()) {
    if (arg === null || typeof arg !== 'object') return arg;
    if (seen.has(arg)) return seen.get(arg);

    if (HObjProxyID in arg) return {OldObjectID: arg[HObjProxyID]};
    if (HFunProxyID in arg) return {OldFunctionID: arg[HFunProxyID]};

    const id = providedId ?? newId();
    workerObjects.set(id, arg);

    const result = {NewObjectID: id};
    seen.set(arg, result);

    logToFile(`W: workerObjects[${id}] := ${print(arg)}`);

    let current = arg;
    while (current && current !== Object.prototype) {
        for (const memberId of Reflect.ownKeys(current)) {
            const val = arg[memberId];
            if (typeof val === 'function') {
                result[memberId] = serializeFunctionAtWorker(val, memberId, id);
            } else if (typeof val === 'object') {
                result[memberId] = serializeObjectAtWorker(val, id + '.' + String(memberId), seen);
            } else {
                result[memberId] = val;
            }
        }

        current = Object.getPrototypeOf(current);
    }

    return result;
}

function serializeObjectAtHost(arg, providedId = null, seen = new WeakMap()) {
    if (arg === null || typeof arg !== 'object') return arg;
    if (seen.has(arg)) return seen.get(arg);

    if (WObjProxyID in arg) return {OldObjectID: arg[WObjProxyID]};
    if (WFunProxyID in arg) return {OldFunctionID: arg[WFunProxyID]};

    const id = providedId ?? newId();
    hostObjects.set(id, arg);

    const result = {NewObjectID: id};
    seen.set(arg, result);

    logToFile(`H: hostObjects[${id}] := ${print(arg)}`); // TODO: is it needed?

    // TODO: copy internals

    return result;
}


function serializeAtWorker(arg) {
    logToFile(`W: serialize(${print(arg)})`);

    if (typeof arg === 'function') return serializeFunctionAtWorker(arg);
    if (typeof arg === 'object' && arg !== null) return serializeObjectAtWorker(arg);

        // try {
        //     let result = structuredClone(arg);
        //     checkMissingGetters(arg, result);
        //     logToFile(`W: serialize(${print(result)}) worked with structuredClone`);
        //     return result;
        // } catch (e) {
        // return serializeObjectAtWorker(arg);
        // }

    return arg;
}

function serializeAtHost(arg) {
    logToFile(`H: serialize(${print(arg)})`);

    if (typeof arg === 'function') return serializeFunctionAtHost(arg);
    if (typeof arg === 'object' && arg !== null) return serializeObjectAtHost(arg);

        // try {
        //     structuredClone(arg);
        //     return arg;
        // } catch (e) {
        //     return createHostObjectHandle(arg) ;
        // }

    return arg;
}

// Deserialization

function deserializeAtHost(port, arg) {
    let result = arg;

    if (typeof arg === 'object' && arg !== null) {
        if (NewObjectID in arg) result = createWorkerObjectProxy(port, arg);
        if (NewFunctionID in arg) result = createWorkerFunctionProxy(port, arg);
        if (OldObjectID in arg) {
            result = lookUpObject(hostObjects, arg[OldObjectID]);
            assert(result, `H: hostObjects[${arg[OldObjectID]}] not found`);
        }
        if (OldFunctionID in arg) {
            result = hostFunctions.get(arg[OldFunctionID]);
            assert(result, `H: workerFunctions[${arg[OldFunctionID]}] not found`);
        }
    }

    logToFile(`H: deserialize(${print(arg)}) -> ${print(result)}`);

    return result;
}

function deserializeAtWorker(port, arg) {
    let result = arg;

    if (typeof arg === 'object' && arg !== null) {
        if (NewObjectID in arg) result = createHostObjectProxy(port, arg);
        if (NewFunctionID in arg) result = createHostFunctionProxy(port, arg);
        if (OldObjectID in arg) {
            result = lookUpObject(workerObjects, arg[OldObjectID]);
            assert(result, `W: workerObjects[${arg[OldObjectID]}] not found`);
        }
        if (OldFunctionID in arg) {
            result = workerFunctions.get(arg[OldFunctionID]);
            assert(result, `W: workerFunctions[${arg[OldFunctionID]}] not found`);
        }
    }

    logToFile(`W: deserialize(${print(arg)}) -> ${print(result)}`);

    return result;
}

// Handles management

function isProbablyAsync(func) {
    if (func?.constructor?.name === 'AsyncFunction') return true;
    const fnStr = func.toString();
    return fnStr.includes('__awaiter(') && fnStr.includes('function*');
}

function createHostObjectHandle(arg, rawId = undefined) {
    const id = rawId ?? newId();
    hostObjects.set(id, arg);
    logToFile(`H: hostObjects[${id}] := ${arg?.constructor?.name ?? arg}`); // TODO: to print LazyPromise
    return {HostObjectID: id};
}

function createClass(name, port) {
    return class {
        constructor(...args) {
            logToFile(`W: >>> args=${args}`);
        }
    }
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

    const handler = {
        __proto__: null,
        get(target, name) {
            logToFile(`H: get proxy[${objectId}].'${String(name)}' (key is '${typeof name}')  ...`);
            // logToFile(`H: stack: ${new Error().stack}`);

            if (!(name in target)) return undefined;
            const val = target[name];

            if (typeof val === 'object' && val !== null) {
                if (NewObjectID in val) {
                    target[name] = createWorkerObjectProxy(port, val);
                    return target[name];
                }

                if (NewFunctionID in val) {
                    target[name] = createWorkerFunctionProxy(port, val);
                    return target[name];
                }
            }

            return val;
        },

        set(target, name, value) {
            // logToFile(`H: set proxy[${objectId}].'${String(name)}' = ${JSON.stringify(value)}... good luck!`);
            logToFile(`H: >>> set proxy[${objectId}].... good luck!`);
            return true;
        }
    };

    return new Proxy({WObjProxyID: objectId, ...remainingHandle}, handler);
}

function createHostObjectProxy(port, objectHandle) {
    const {NewObjectID: objectId} = objectHandle;
    logToFile(`W: creating object proxy for id=${objectId}`);

    const handler = {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            logToFile(`W: get.1 proxy[${objectId}].'${String(name)}' (type '${typeof name}')  ...`);

            if (name === Symbol.toPrimitive) return () => `proxy[${objectId}]`;
            if (name === Symbol.iterator) return function* () {};
            if (name === 'forEach') { return function(callback, thisArg) {}; }
            if (name === '__esModule') return true; // TODO: workaround?

            logToFile(`W: get.2 proxy[${objectId}].'${String(name)}': about to call asyncType ...`);
            const typeResult = asyncType(port, objectId, name);

            let result
            if (typeResult.isFunction) {
                result = createHostFunctionProxy(port, {NewTargetID: objectId, NewFunctionID: name});
            } else if ('simpleValue' in typeResult) {
                result = typeResult.simpleValue;
            } else {
                result = createHostObjectProxy(port, {NewObjectID: objectId + "." + name});
            }

            logToFile(`W: get.3 proxy[${objectId}].'${String(name)}' resulted in ${shorten(result)}`);
            return result;
        },
        set(target, name, value) {
            if (name === 'buttons') {
                logToFile(`W: original.iconPath = ${value[0].iconPath}`);
            }

            const serializedValue = serializeAtWorker(value);

            if (name === 'buttons') {
                const button = serializedValue[0];
                logToFile(`W: button.iconPath = ${print(button.iconPath)}`);
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

    return new Proxy({HObjProxyID: objectId}, handler);
}

function createWorkerFunctionProxy(port, functionHandle) {
    const {NewTargetID: targetId, NewFunctionID: functionId, IsAsync: isAsync} = functionHandle;
    const prefix = isAsync ? 'async ' : '';
    const funcStr = prefix + (targetId
        ? `workerObjects[${targetId}].${functionId}`
        : `workerFunctions[${functionId}]`);

    logToFile(`H: Creating method proxy for ${funcStr}`);

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
        logToFile(`W: call.2 ${funcStr}(${argsStr}) callResult=${callResult}`);

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

    serializeObjectAtWorker(result, resultId);
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

    logToFile(`H: callHostFunction for ${funcStr}(${argsStr})`);
    const args = serializedArgs.map(arg => deserializeAtHost(port, arg));

    let result = undefined;

    try {
        result = func.apply(target, args);
    } catch (e) {
        logToFile(`H: failed to call ${funcStr}: ${e}`); // TODO: do not pollute console?
        try {
            result = new func(args);
        } catch (e) {
            console.warn(`H: failed to call.new ${funcStr}: ${e}\nH: func=${func}`);
            throw e;
        }
    }

    logToFile(`H: ${funcStr}(${argsStr}) resulted in ${result?.constructor?.name ?? result}`);

    if (funcStr.includes('ThemeIcon')) {
        logToFile(`H: ${funcStr}(${argsStr}) resulted in ${print(result)}`);
    }

    if (!ResumeCall(resultId, result)) return createHostObjectHandle(result, resultId);
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
    fs.writeFile(LogFileHost, date, (err) => {
        if (err) throw err;
    });
    fs.writeFile(LogFileWorker, date, (err) => {
        if (err) throw err;
    });

    setAPI('w:vscode', createHostObjectProxy(port, {NewObjectID: IDS.VSCODE}));
    setAPI('w:context', createHostObjectProxy(port, {NewObjectID: IDS.CONTEXT}));

    setInterval(() => {
        logToFile('W: Staying alive');
    }, 15000);
}

function reactOnWorkerMessage(message, port) {
    if (hostObjects.size === 0) {
        createHostObjectHandle(getAPI('h:vscode'), IDS.VSCODE);
        createHostObjectHandle(getAPI('h:context'), IDS.CONTEXT);
    }

    if (message.type === W2H_CALL) {
        logToFile(`H: <-${W2H_CALL}`);
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
        // logToFile(`H: <-${W2H_PROMISE} promise[${message.objectId}] to ${funcStr}(${message.result})`);
        logToFile(`H: <-${W2H_PROMISE} promise[${message.objectId}] to ${funcStr}(${print(message.result)})`);
        func(deserializeAtHost(port, message.result));
        return true;
    }

    if (message.type === W2H_TYPE) {
        logToFile(`H: <-${W2H_TYPE} id=${message.id} name=${message.name}`);
        const target = lookUpObject(hostObjects, message.id)
        assert(target, `H: ${message.id} not found in hostObjects`);
        ResumeType(message.id + '.' + message.name, target[message.name]);
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