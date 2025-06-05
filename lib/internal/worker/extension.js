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

let workerId = undefined;

// Handle management

const HandleID = 'HandleID';
const FunctionID = 'FunctionID';

const IDS = {
    CONTEXT: 'context',
    VSCODE: 'vscode',
};

const newId = (function() {
    let counter = 0; // private counter

    return function() {
        return workerId + ':' + counter++;
    };
})();

let storedTargets = new Map();

function lookUpTarget(compoundId) {
    if (storedTargets.size === 0) {
        storedTargets.set(IDS.VSCODE, getAPI('h:vscode'));
        storedTargets.set(IDS.CONTEXT, getAPI('h:context'));
    }

    let result = undefined;

    for (const id of  compoundId.split('.')) {
        result = result ? result[id] : storedTargets.get(id);
    }

    return result;
}

function createHandle(id, port) {
    console.log(`W: Creating handle for id=${id}`);

    const handler = {
        __proto__: null,
        get(target, name) {
            console.log(`W: Getting.1 '${String(name)}' (type '${typeof name}') from h(${id}) ...`);

            if (name in target) return target[name];
            if (name === Symbol.toPrimitive) return () => `h(${id})`;
            if (name === '__esModule') return true; // TODO: workaround?

            console.log(`W: Getting.2 '${name}' from h(${id}): no shortcut`);

            port.postMessage({
                type: W2H_TYPE,
                id: id,
                name: name,
            });

            const typeResult = WaitType(id + '.' + name);

            let result = typeResult.isFunction
                ? createRPC(port, id, name)
                : ('simpleValue' in typeResult
                    ? typeResult.simpleValue
                    : createHandle(id + "." + name, port)
                );

            console.log(`W: Getting.3 '${name}' from h(${id}) resulted in ${result}`);
            return result;
        }
    };

    return new Proxy({HandleID: id}, handler);
}

// RPC management

let storedFunctions = new Map();

function createRPC(port, id, name) {
    console.log(`W: Creating rpc for id=${id} name=${name}`);

    return function (...args) {
        const resultId = newId();
        const transferableArgs = args.map(toTransferable);

        console.log(`W: Calling rpc for id=${id} name=${name}`);

        port.postMessage({
            type: W2H_CALL,
            id: id,
            name: name,
            args: transferableArgs,
            resultId: resultId,
        });

        const callResult = WaitCall(resultId);

        let result = 'simpleValue' in callResult
            ? callResult.simpleValue
            : createHandle(resultId, port);

        console.log(`W: ->${W2H_CALL} h(${id}).${name}(${transferableArgs}) resulted in ${result}`);
        return result;
    };
}

function toTransferable(arg) {
    if (arg !== null && typeof arg === 'object' && HandleID in arg) {
        return {HandleID: arg[HandleID]};
    }

    if (typeof arg === 'function') {
        const functionId = newId();
        storedFunctions.set(functionId, arg);
        console.log(`W: storedFunctions[${functionId}] := ${arg}`);
        return {FunctionID: functionId};
    }

    return arg;
}

function toApplicable(arg, port) {
    if (arg !== null && typeof arg === 'object' && FunctionID in arg) {
        return () => {
            const result = port.postMessage({
                type: H2W_CALL,
                id: arg[FunctionID],
            });
            console.log(`H: ->${H2W_CALL} f(${arg[FunctionID]}) -> ${result}`);
        };
    }

    return arg;
}

function createClass(name, port) {
    return class {
        constructor(...args) {
            console.log(`W: >>> args=${args}`);
        }
    }
}

// Exported functions

function initWorker(id, port) {
    workerId = id.replace(/\./g, '');

    setAPI('w:vscode', createHandle(IDS.VSCODE, port));
    setAPI('w:context', createHandle(IDS.CONTEXT, port));

    setInterval(() => {
        console.log('W: Staying alive');
    }, 15000);
}

function reactOnWorkerMessage(message, port) {
    if (message.type === W2H_CALL) {
        console.log(`H: <-${W2H_CALL} h(${message.id}).${message.name}(${message.args})`);

        const target = lookUpTarget(message.id)

        console.log(`H: h(${message.id}) resulted in ${target}`);

        assert(target !== undefined, `H: h(${message.id}) can't be found`);
        assert(message.name in target, `H: ${message.name} not found in h(${message.id})`);

        const result = target[message.name].apply(target, message.args.map(arg => toApplicable(arg, port)));

        console.log(`H: h(${message.id}).${message.name}(${message.args}) resulted in ${result}`);

        if (!ResumeCall(message.resultId, result)) {
            storedTargets.set(message.resultId, result);
            console.log(`H: storedTargets[${message.resultId}] := ${result}`);
        }

        return true;
    }

    if (message.type === W2H_TYPE) {
        const target = lookUpTarget(message.id)
        ResumeType(message.id + '.' + message.name, target[message.name]);
        return true;
    }

    return false
}

function reactOnHostMessage(message) {
    if (message.type === H2W_CALL) {
        console.log(`W: <-${H2W_CALL} f(${message.id})`);
        assert(storedFunctions.has(message.id), `W: f(${message.id}) can't be found`);

        const command = storedFunctions.get(message.id);
        command();

        return true;
    }

    return false;
}

module.exports = {
    initWorker,

    reactOnWorkerMessage,
    reactOnHostMessage,
};