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

const MethodTargetID = 'MethodTargetID';
const IsAsync = 'IsAsync';

const WorkerObjectProxyID = 'WorkerObjectProxyID';
const HostObjectProxyID = 'HostObjectProxyID';

const WorkerMethodID = 'WorkerMethodID';
const WorkerObjectID = 'WorkerObjectID';
const WorkerFunctionID = 'WorkerFunctionID';

const HostObjectID = 'HostObjectID';
const HostFunctionID = 'HostFunctionID';

let hostFunctions = new Map();
let workerFunctions = new Map();

let hostResolves = new Map();
let hostRejects = new Map();

let hostObjects = new Map();
let workerObjects = new Map();

function lookUpObject(objects, compoundId) {
    if (compoundId === null) return undefined;

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
    try {
        port.postMessage({type: W2H_TYPE, id: id, name: name});
    } catch (e) {
        console.log(`W: postMessage call @asyncType failed: ${e}`);
    }

    console.log('WA: WaitType before');
    const typeResult = WaitType(id + '.' + name);
    console.log(`WA: WaitType after, typeResult=${JSON.stringify(typeResult)}`);

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
        console.log(`W: postMessage call @asyncType failed: ${e}`);
    }

    console.log(`W: ->${W2H_CALL} targetId=${targetId} functionId=${functionId} args=${args} ${resultId}`);

    console.log('WA: WaitCall before');
    const callResult = WaitCall(resultId);
    console.log(`WA: WaitCall after, callResult=${JSON.stringify(callResult)}`);

    return callResult;
}

// Handles management

function isProbablyAsync(func) {
    if (func?.constructor?.name === 'AsyncFunction') return true;
    const fnStr = func.toString();
    return fnStr.includes('__awaiter(') && fnStr.includes('function*');
}

function createWorkerObjectHandle(arg, rawId = null, seen = new WeakSet()) {
    const id = rawId ?? newId();
    workerObjects.set(id, arg);
    console.log(`W: workerObjects[${id}] := ${arg?.constructor?.name ?? JSON.stringify(arg)}`); // TODO: is it needed?

    const result = {WorkerObjectID: id};

    if (!arg) return result; // null is a special case

    if (seen.has(arg)) return result;
    seen.add(arg);

    let current = arg;
    while (current && current !== Object.prototype) {
        for (const memberId of Reflect.ownKeys(current)) {
            const val = arg[memberId];
            if (typeof val === 'function') {
                result[memberId] = {
                    WorkerMethodID: memberId,
                    MethodTargetID: id,
                    IsAsync: isProbablyAsync(val)
                };
            } else if (typeof val === 'object' && val !== null) {
                result[memberId] = createWorkerObjectHandle(val, id + '.' + String(memberId), seen);
            } else {
                result[memberId] = val;
            }
        }

        current = Object.getPrototypeOf(current);
    }

    return result;
}

function createHostObjectHandle(arg, rawId = undefined) {
    const id = rawId ?? newId();
    hostObjects.set(id, arg);
    console.log(`H: hostObjects[${id}] := ${arg?.constructor?.name ?? arg}`); // TODO: to print LazyPromise
    return {HostObjectID: id};
}

function createWorkerFunctionHandle(func) {
    const handleId = newId();
    workerFunctions.set(handleId, func);
    console.log(`W: workerFunctions[${handleId}] := ${func}`);
    return {WorkerFunctionID: handleId, IsAsync: isProbablyAsync(func)};
}

function createClass(name, port) {
    return class {
        constructor(...args) {
            console.log(`W: >>> args=${args}`);
        }
    }
}

// Arguments management

function serializeAtHost(arg) {
    console.log(`H: serialize(${JSON.stringify(arg)})`);

    if (arg === null) return arg;
    if (typeof arg === 'function') return createHostFunctionHandle(arg);

    if (typeof arg === 'object') {
        if (HostObjectID in arg) return {HostObjectID: arg[HostObjectID]};
        if (HostFunctionID in arg) return {HostFunctionID: arg[HostFunctionID]};

        try {
            structuredClone(arg);
            return arg;
        } catch (e) {
            return createHostObjectHandle(arg) ;
        }
    }

    return arg;
}

function deserializeAtWorker(port, arg) {
    console.log(`W: deserialize(${JSON.stringify(arg)})`);

    if (arg === null) return arg;

    if (typeof arg === 'object') {
        if (HostObjectID in arg) return createHostObjectProxy(port, arg[HostObjectID]);
        if (HostFunctionID in arg) return createHostFunctionProxy(port, arg[HostFunctionID]);
    }

    return arg;
}

function serializeAtWorker(arg) {
    console.log(`W: serialize(${JSON.stringify(arg)})`);

    if (arg === null) return arg;
    if (typeof arg === 'function') return createWorkerFunctionHandle(arg);

    if (typeof arg === 'object') {
        if (WorkerObjectID in arg) return {WorkerObjectID: arg.WorkerObjectID};
        if (WorkerFunctionID in arg) return {WorkerFunctionID: arg.WorkerFunctionID};

        try {
            const result = structuredClone(arg);
            console.log(`W: serialize(${JSON.stringify(result)}) worked with structuredClone`);
            return result;
        } catch (e) {
            return createWorkerObjectHandle(arg) ;
        }
    }

    return arg;
}

function deserializeAtHost(port, arg) {
    console.log(`H: deserialize(${JSON.stringify(arg)})`);
    if (arg === null) return arg;

    if (typeof arg === 'object') {
        if (WorkerObjectID in arg)  return createWorkerObjectProxy(port, arg);
        if (WorkerFunctionID in arg) return createWorkerFunctionProxy(port, null, arg.WorkerFunctionID, arg.IsAsync);
    }

    return arg;
}

// Proxy management

function createWorkerObjectProxy(port, objectHandle) {
    const {WorkerObjectID: objectId, IsAsync: isAsync, ...remainingHandle} = objectHandle;
    console.log(`H: creating object proxy for id=${objectId} async=${isAsync}`);

    if (isAsync) {
        return new Promise((resolve, reject) => {
            console.log(`H: filling in hostResolves and hostRejects for id=${objectId}`);
            hostResolves.set(objectId, resolve);
            hostRejects.set(objectId, reject);
        });
    }

    const handler = {
        __proto__: null,
        get(target, name) {
            console.log(`H: get proxy[${objectId}].'${String(name)}' (key is '${typeof name}')  ...`);
            console.log(`H: stack: ${new Error().stack}`);

            if (!(name in target)) return undefined;
            const val = target[name];

            if (typeof val === 'object') {
                if (WorkerObjectID in val) return createWorkerObjectProxy(port, val);
                if (WorkerMethodID in val) return createWorkerFunctionProxy(port, val.MethodTargetID, val.WorkerMethodID, val.IsAsync);
            }

            return val;
        },
        set(target, name, value) {
            // console.log(`H: set proxy[${objectId}].'${String(name)}' = ${JSON.stringify(value)}... good luck!`);
            console.log(`H: >>> set proxy[${objectId}].... good luck!`);
            return true;
        }
    };

    return new Proxy({WorkerObjectProxyID: objectId, ...remainingHandle}, handler);
}

function createHostObjectProxy(port, objectId) {
    console.log(`W: creating object proxy for id=${objectId}`);

    const handler = {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            console.log(`W: get.1 proxy[${objectId}].'${String(name)}' (type '${typeof name}')  ...`);

            if (name === Symbol.toPrimitive) return () => `proxy[${objectId}]`;
            if (name === Symbol.iterator) return function* () {};
            if (name === 'forEach') { return function(callback, thisArg) {}; }
            if (name === '__esModule') return true; // TODO: workaround?

            console.log(`W: get.2 proxy[${objectId}].'${String(name)}': about to call asyncType ...`);
            const typeResult = asyncType(port, objectId, name);

            let result
            if (typeResult.isFunction) {
                result = createHostFunctionProxy(port, objectId, name)
            } else if ('simpleValue' in typeResult) {
                result = typeResult.simpleValue;
            } else {
                result = createHostObjectProxy(port, objectId + "." + name);
            }

            console.log(`W: get.3 proxy[${objectId}].'${String(name)}' resulted in ${result}`);
            return result;
        },
        set(target, name, value) {
            const serializedValue = serializeAtWorker(value);

            if (name === 'buttons') {
                const button = serializedValue[0];
                console.log(`W: button.iconPath = ${button.iconPath}`);
            }

            port.postMessage({
                type: W2H_SET,
                targetId: objectId,
                propertyId: name,
                value: serializedValue
            });

            console.log(`W: set proxy[${objectId}].'${String(name)}' to ${JSON.stringify(serializedValue)}`);
            return true;
        }
    };

    return new Proxy({HostObjectProxyID: objectId}, handler);
}

function createWorkerFunctionProxy(port, targetId, functionId, isAsync) {
    const prefix = isAsync ? 'async ' : '';
    const funcStr = prefix + (targetId
        ? `workerObjects[${targetId}].${functionId}`
        : `workerFunctions[${functionId}]`);

    console.log(`H: Creating method proxy for ${funcStr}`);

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

        console.log(`H: ->${H2W_CALL} ${funcStr}(${serializedArgs}) resultId=${resultId}`);

        return createWorkerObjectProxy(port, {WorkerObjectID: resultId, IsAsync: isAsync});
    };
}

function createHostFunctionProxy(port, targetId, functionId) {
    const funcStr = targetId ? `hostObjects[${targetId}].${functionId}` : `hostFunctions[${functionId}]`;
    console.log(`W: Creating method proxy for ${funcStr}`);

    return function (...args) {
        const serializedArgs = args.map(serializeAtWorker);

        const resultId = newId();
        console.log(`W: call.1 ${funcStr}(${serializedArgs}), reserving resultId=${resultId}`);

        const callResult = asyncCall(port, targetId, functionId, serializedArgs, resultId);
        console.log(`W: call.2 ${funcStr}(${serializedArgs}) callResult=${callResult}`);

        let result = 'simpleValue' in callResult
            ? callResult.simpleValue
            : createHostObjectProxy(port, resultId);

        console.log(`W: call.3 ${funcStr}(${serializedArgs}) resulted in ${result}`);
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

    console.log(`W: callWorkerFunction for ${funcStr}(${serializedArgs})`);
    const args = serializedArgs.map(arg => deserializeAtWorker(workerPort, arg));

    let result = undefined;
    try {
        result = func.apply(target, args);
    } catch (e) {
        console.warn(`W: failed to call ${funcStr}: ${e}\nW: func=${func}`);
    }

    if (isAsync && !!result) {
        result.then(res => {
            console.log(`W: ->${W2H_PROMISE} promise[${resultId}] resolved with ${JSON.stringify(res)}`);
            workerPort.postMessage({
                type: W2H_PROMISE,
                resolve: true,
                objectId: resultId,
                result: serializeAtWorker(res),
            });
        }, err => {
            console.log(`W: ->${W2H_PROMISE} promise[${resultId}]  rejected with ${JSON.stringify(err)}`);
            workerPort.postMessage({
                type: W2H_PROMISE,
                resolve: false,
                objectId: resultId,
                result: serializeAtWorker(err),
            });
        });
    }

    createWorkerObjectHandle(result, resultId);
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

    console.log(`H: callHostFunction for ${funcStr}(${serializedArgs})`);
    const args = serializedArgs.map(arg => deserializeAtHost(port, arg));

    let result = undefined;

    try {
        result = func.apply(target, args);
    } catch (e) {
        console.log(`H: failed to call ${funcStr}: ${e}`); // TODO: do not pollute console?
        try {
            result = new func(args);
        } catch (e) {
            console.warn(`H: failed to call.new ${funcStr}: ${e}\nH: func=${func}`);
        }
    }

    console.log(`H: ${funcStr}(${serializedArgs}) resulted in ${result?.constructor?.name ?? result}`);

    if (funcStr.includes('ThemeIcon')) {
        console.log(`H: ${funcStr}(${serializedArgs}) resulted in ${JSON.stringify(result)}`);
    }

    if (!ResumeCall(resultId, result)) return createHostObjectHandle(result, resultId);
}

// Object property update management

function updateHostObject(port, targetId, propertyId, value) {
    const target = lookUpObject(hostObjects, targetId);
    assert(target, `H: ${targetId} not found in hostObjects`);
    target[propertyId] = deserializeAtHost(port, value);
    console.log(`H: hostObjects[${targetId}].${propertyId} := ${JSON.stringify(value)}`);
}

// Exported functions

function initWorker(id, port) {
    threadId = id.replace(/\./g, '');
    workerPort = port;

    setAPI('w:vscode', createHostObjectProxy(port, IDS.VSCODE));
    setAPI('w:context', createHostObjectProxy(port, IDS.CONTEXT));

    setInterval(() => {
        console.log('W: Staying alive');
    }, 15000);
}

function reactOnWorkerMessage(message, port) {
    if (hostObjects.size === 0) {
        createHostObjectHandle(getAPI('h:vscode'), IDS.VSCODE);
        createHostObjectHandle(getAPI('h:context'), IDS.CONTEXT);
    }

    if (message.type === W2H_CALL) {
        console.log(`H: <-${W2H_CALL}`);
        callHostFunction(port, message.targetId, message.functionId, message.args, message.resultId);
        return true;
    }

    if (message.type === W2H_SET) {
        console.log(`H: <-${W2H_SET}`);
        updateHostObject(port, message.targetId, message.propertyId, message.value);
        return true;
    }


    if (message.type === W2H_PROMISE) {
        const func = message.resolve ? hostResolves.get(message.objectId) : hostRejects.get(message.objectId);
        const funcStr = message.resolve ? 'resolve' : 'reject';
        console.log(`H: <-${W2H_PROMISE} promise[${message.objectId}] to ${funcStr}(${message.result})`);
        func(deserializeAtHost(port, message.result));
        return true;
    }

    if (message.type === W2H_TYPE) {
        console.log(`H: <-${W2H_TYPE}`);
        const target = lookUpObject(hostObjects, message.id)
        ResumeType(message.id + '.' + message.name, target[message.name]);
        return true;
    }

    return false
}

function reactOnHostMessage(message) {
    if (message.type === H2W_CALL) {
        console.log(`W: <-${H2W_CALL}`);
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