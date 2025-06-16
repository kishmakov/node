'use strict';

const {
    messageTypes: {
        H2W_CALL,
        W2H_CALL,
        W2H_TYPE,
    }
} = require('internal/worker/io');
const assert = require('internal/assert');

const {
    getAPI,
    setAPI,
} = require("internal/util");

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

const WorkerObjectProxyID = 'WorkerObjectProxyID';
const HostObjectProxyID = 'HostObjectProxyID';

const WorkerMethodID = 'WorkerMethodID';
const WorkerObjectID = 'WorkerObjectID';
const WorkerFunctionID = 'WorkerFunctionID';

const HostObjectID = 'HostObjectID';
const HostFunctionID = 'HostFunctionID';

let hostFunctions = new Map();
let workerFunctions = new Map();

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
        port.postMessage({
            type: W2H_TYPE,
            id: id,
            name: name,
        });
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

    console.log(`W: ->${H2W_CALL} targetId=${targetId} functionId=${functionId} args=${args} ${resultId}`);

    console.log('WA: WaitCall before');
    const callResult = WaitCall(resultId);
    console.log(`WA: WaitCall after, callResult=${JSON.stringify(callResult)}`);

    return callResult;
}

// Handles management

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
                result[memberId] = {WorkerMethodID: memberId, MethodTargetID: id};
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
    return {WorkerFunctionID: handleId};
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
            structuredClone(arg);
            return arg;
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
        if (WorkerFunctionID in arg) return createWorkerFunctionProxy(port, null, arg.WorkerFunctionID);
    }

    return arg;
}

// Proxy management

function createWorkerObjectProxy(port, objectHandle) {
    const {WorkerObjectID: objectId, ...remainingHandle} = objectHandle;
    console.log(`H: Creating object proxy for id=${objectId}`);

    const handler = {
        __proto__: null,
        get(target, name) {
            console.log(`H: get workerObjects[${objectId}].'${String(name)}' (key is '${typeof name}')  ...`);
            if (!(name in target)) return undefined;
            const val = target[name];

            if (WorkerObjectID in val) return createWorkerObjectProxy(port, val);
            if (WorkerMethodID in val) return createWorkerFunctionProxy(port, val.MethodTargetID, val.WorkerMethodID);

            return val;
        }
    };

    return new Proxy({WorkerObjectProxyID: objectId, ...remainingHandle}, handler);
}

function createHostObjectProxy(port, targetId) {
    console.log(`W: Creating object proxy for id=${targetId}`);

    const handler = {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            console.log(`W: get.1 proxy[${targetId}].'${String(name)}' (type '${typeof name}')  ...`);

            if (name === Symbol.toPrimitive) return () => `proxy[${targetId}]`;
            if (name === Symbol.iterator) return function* () {};
            if (name === 'forEach') { return function(callback, thisArg) {}; }
            if (name === '__esModule') return true; // TODO: workaround?

            console.log(`W: get.2 proxy[${targetId}].'${String(name)}': about to call asyncType ...`);
            const typeResult = asyncType(port, targetId, name);

            let result
            if (typeResult.isFunction) {
                result = createHostFunctionProxy(port, targetId, name)
            } else if ('simpleValue' in typeResult) {
                result = typeResult.simpleValue;
            } else {
                result = createHostObjectProxy(port, targetId + "." + name);
            }

            console.log(`W: get.3 proxy[${targetId}].'${String(name)}' resulted in ${result}`);
            return result;
        }
    };

    return new Proxy({HostObjectProxyID: targetId}, handler);
}

function createWorkerFunctionProxy(port, targetId, functionId) {
    const funcStr = targetId ? `workerObjects[${targetId}].${functionId}` : `workerFunctions[${functionId }]`;
    console.log(`H: Creating method proxy for ${funcStr}`);

    return function (...args) {
        let serializedArgs = args.map(serializeAtHost);

        const resultId = newId();

        port.postMessage({
            type: H2W_CALL,
            targetId: targetId,
            functionId: functionId,
            args: serializedArgs,
            resultId: resultId
        });

        console.log(`H: ->${H2W_CALL} ${funcStr}(${serializedArgs}) resultId=${resultId}`);

        createWorkerObjectProxy(port, {WorkerObjectID: resultId});
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

function callWorkerFunction(port, targetId, functionId, serializedArgs, resultId) {
    const target = lookUpObject(workerObjects, targetId);

    let func;
    let funcStr;

    if (target) {
        assert(functionId in target, `W: ${functionId} not found in workerObjects[${targetId}]`);
        func = target[functionId];
        funcStr = `workerObjects[${targetId}].${functionId}`;
    } else {
        assert(workerFunctions.has(functionId), `W: workerFunctions[${functionId}] can't be found`);
        func = workerFunctions.get(functionId);
        funcStr = `workerFunctions[${functionId}]`;
    }

    console.log(`W: callWorkerFunction for ${funcStr}(${serializedArgs})`);
    const args = serializedArgs.map(arg => deserializeAtWorker(port, arg));

    let result = undefined;
    try {
        result = func.apply(target, args);
    } catch (e) {
        console.log(`W: failed to call ${funcStr}: ${e}\nW: func=${func}`);
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
            console.log(`H: failed to call.new ${funcStr}: ${e}\nH: func=${func}`);
        }
    }

    console.log(`H: ${funcStr}(${serializedArgs}) resulted in ${result?.constructor?.name ?? result}`);

    if (!ResumeCall(resultId, result)) createHostObjectHandle(result, resultId);
}

// Exported functions

function initWorker(id, port) {
    threadId = id.replace(/\./g, '');

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

    if (message.type === W2H_TYPE) {
        const target = lookUpObject(hostObjects, message.id)
        ResumeType(message.id + '.' + message.name, target[message.name]);
        return true;
    }

    return false
}

function reactOnHostMessage(message, port) {
    if (message.type === H2W_CALL) {
        console.log(`W: <-${H2W_CALL}`);
        callWorkerFunction(port, message.targetId, message.functionId, message.args, message.resultId);
        return true;
    }

    return false;
}

module.exports = {
    initWorker,

    reactOnWorkerMessage,
    reactOnHostMessage,
};