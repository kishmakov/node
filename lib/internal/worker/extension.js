'use strict';

const {
    messageTypes: {
        H2W_CALL,
        W2H_CALL,
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

const IdUtils = {
    // context
    EXTENSION: 'context.extension',
    SUBSCRIPTIONS: 'context.subscriptions',
    // vscode
    COMMANDS: 'vscode.commands',
    EXTENSIONS: 'vscode.extensions',
    WINDOW: 'vscode.window',
};

const newId = (function() {
    let counter = 0; // private counter

    return function() {
        return workerId + ':' + counter++;
    };
})();

let storedHandles = new Map();
let storedFunctions = new Map();

function createHandle(object, id, port) {
    const handler = {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            if (typeof name !== 'string') return undefined;
            console.log(`W: Getting '${name}' from h(${id}).`);

            if (name === 'id') { // TODO: replace with structured fix
                return createHandle({}, newId(), port);
            }

            return function (...args) {
                const resultId = newId();

                const postStatus = port.postMessage({
                    type: W2H_CALL,
                    id: id,
                    name: name,
                    args: args.map(toTransferable),
                    resultId: resultId,
                });

                console.log(`W: ->${W2H_CALL} h(${id}).${name}(${args}) -> ${postStatus}`);
                return createHandle({}, resultId, port);
            };
        }
    };

    return new Proxy({...object, HandleID: id}, handler);
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
                id: arg[FunctionID]
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
    workerId = id;
    setAPI('w:vscode', {
        // Symbols
        CallHierarchyItem: createClass('CallHierarchyItem', port),
        CancellationError: createClass('CancellationError', port),
        CodeAction: createClass('CodeAction', port),
        CodeLens: createClass('CodeLens', port),
        CompletionItem: createClass('CompletionItem', port),
        Diagnostic: createClass('Diagnostic', port),
        DocumentLink: createClass('DocumentLink', port),
        ExtensionMode: createClass('ExtensionMode', port),
        InlayHint: createClass('InlayHint', port),
        SymbolInformation: createClass('SymbolInformation', port),
        TypeHierarchyItem: createClass('TypeHierarchyItem', port),
        // sub-namespaces
        commands: createHandle({}, IdUtils.COMMANDS, port),
        window: createHandle({}, IdUtils.WINDOW, port),
        extensions: createHandle({}, IdUtils.EXTENSIONS, port),
    });

    setAPI('w:context', {
        subscriptions: createHandle({}, IdUtils.SUBSCRIPTIONS, port),
        extension: createHandle({}, IdUtils.EXTENSION, port),
    });

    setInterval(() => {
        console.log('W: Staying alive');
    }, 15000);
}

function reactOnWorkerMessage(message, port) {
    if (message.type === W2H_CALL) {
        console.log(`H: <-${W2H_CALL} h(${message.id}).${message.name}(${message.args})`);

        let object;
        switch (message.id) {
            case IdUtils.COMMANDS:
                object = getAPI('h:vscode').commands;
                break;
            case IdUtils.WINDOW:
                object = getAPI('h:vscode').window;
                break;
            case IdUtils.EXTENSION:
                object = getAPI('h:context').extension;
                break;
            case IdUtils.SUBSCRIPTIONS:
                object = getAPI('h:context').subscriptions;
                break;
            default:
                object = storedHandles.get(message.id);
                break;
        }

        assert(object !== undefined, `H: h(${message.id}) can't be found`);
        assert(message.name in object, `H: ${message.name} not found in h(${message.id})`);

        const result = object[message.name].apply(object, message.args.map(arg => toApplicable(arg, port)));

        if (result !== undefined) {
            storedHandles.set(message.resultId, result);
            console.log(`H: storedHandles[${message.resultId}] := ${result}`);
        }

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