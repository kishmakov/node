'use strict';

const {
    messageTypes: {
        W2H_CALL,
        VS_CALL_API,
        VS_REGISTER_COMMAND,
        CALL_COMMAND,
    }
} = require('internal/worker/io');
const assert = require('internal/assert');

const {
    getAPI,
    setAPI,
} = require("internal/util");

let registeredCommands = new Map();

// Handle management

const HandleID = 'HandleID';

const IdUtils = {
    COMMAND: 'command:',
    SUBSCRIPTIONS: 'context.subscriptions',
    WINDOW: 'vscode.window',
};

const newId = (function() {
    let counter = 0; // private counter

    return function() {
        return 'id:' + counter++;
    };
})();

let storedHandles = new Map();

function createHandle(object, id, port) {
    const handler = {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            if (typeof name !== 'string') return undefined;
            console.log(`W: Getting '${name}' from h(${id}).`);

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

    return arg;
}

function initWorker(port) {
    setAPI('w:vscode', {
        commands: {
            registerCommand: function (commandName, callback) {
                registeredCommands.set(commandName, callback);

                const result = port.postMessage({
                    type: VS_REGISTER_COMMAND,
                    name: commandName,
                })

                console.log(`W: Sending ${VS_REGISTER_COMMAND}: ${result}`);
                return createHandle({name: commandName}, IdUtils.COMMAND + commandName, port);
            }
        },
        window: createHandle({}, IdUtils.WINDOW , port)
    });

    setAPI('w:context', {
        subscriptions: createHandle({}, IdUtils.SUBSCRIPTIONS, port)
    });

    setInterval(() => {
        console.log('W: Staying alive');
    }, 5000);
}

function reactOnWorkerMessage(message, port) {
    if (message.type === W2H_CALL) {
        console.log(`H: <-${W2H_CALL} h(${message.id}).${message.name}(${message.args})`);

        let object;
        switch (message.id) {
            case IdUtils.WINDOW:
                object = getAPI('h:vscode').window;
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

        const result = object[message.name].apply(object, message.args);

        if (result !== undefined) {
            storedHandles.set(message.resultId, result);
            console.log(`H: storedHandles[${message.resultId}] := ${result}`);
        }

        return true;
    }

    if (message.type === VS_REGISTER_COMMAND) {
        console.log(`H: Received ${VS_REGISTER_COMMAND}: ${message.name}`);
        const vscode = getAPI('h:vscode');
        const context = getAPI('h:context');
        console.log(`H: vscode -> ${vscode} context -> ${context} port -> ${port}`); // TODO: remove once verified

        const handle = vscode.commands.registerCommand(message.name, () => {
            const result = port.postMessage({type: CALL_COMMAND, name: message.name});
            console.log(`H: Sending ${CALL_COMMAND}: ${message.name} -> ${result}`);
        });

        // context.subscriptions.push(
        //     handle // TODO: wrap this Disposable?
        // );

        return true;
    }

    if (message.type === VS_CALL_API) {
        console.log(`H: Received ${VS_CALL_API}: ${message.name}(${message.value})`);
        const vscode = getAPI('h:vscode');
        console.log(`H: vscode -> ${vscode}`);
        const result = api.window[message.name](...message.value);

        console.log(`H: result -> ${result}`);
        return true;
    }

    return false
}

function reactOnHostMessage(message) {
    if (message.type === CALL_COMMAND) {
        console.log(`W: Received ${CALL_COMMAND}: ${message.name}`);
        if (registeredCommands.has(message.name)) {
            const command = registeredCommands.get(message.name);
            command();
        }

        return true;
    }

    return false;
}

module.exports = {
    initWorker,

    reactOnWorkerMessage,
    reactOnHostMessage,
};