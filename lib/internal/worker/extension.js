'use strict';

const {
    messageTypes: {
        VS_CALL,
        VS_CALL_API,
        VS_CALL_CHANNEL,
        VS_REGISTER_COMMAND,
        CALL_COMMAND,
    }
} = require('internal/worker/io');

const {
    getAPI,
    setAPI,
} = require("internal/util");

let registeredCommands = new Map();
let registeredChannels = new Map();

// Handle management

const HandleID = 'HandleID';

const IdUtils = {
    COMMAND: 'command:',
    SUBSCRIPTIONS: 'context.subscriptions',
};

const newId = (function() {
    let counter = 0; // private counter

    return function() {
        return 'id:' + counter++;
    };
})();

function createHandle(object, id, port) {
    const handler = {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            if (typeof name !== 'string') return undefined;
            console.log(`W: get h(${id}).${name}`);

            return function (...args) {
                const resultId = newId();

                const postStatus = port.postMessage({
                    type: VS_CALL,
                    id: id,
                    name: name,
                    args: args.map(toTransferable),
                    resultId: resultId,
                });

                console.log(`W: Sent ${VS_CALL}: h(${id}).${name}(${args}) -> ${postStatus}`);
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

function createOutputChannel(port, ...constructor_args) {
    const name = constructor_args[0];
    return new Proxy({}, {
        get(target, prop) {
            return function (...args) {
                const postStatus = port.postMessage({
                    type: VS_CALL_CHANNEL,
                    id: name,
                    method: prop,
                    args: args,
                })

                console.log(`W: Sending ${VS_CALL_CHANNEL}: ${name} -> ${prop}(${args}): ${postStatus}`);
                return undefined;
            }
        }
    });
}

function creatWindowHandler(port) {
    return {
        get(target, prop) {
            if (typeof prop !== 'string') {
                return undefined;
            }
            console.log(`W: Called vscode.window.${prop} ...`);

            return function (...args) {
                const postStatus = port.postMessage({
                    type: VS_CALL_API,
                    name: prop,
                    value: args,
                })

                let result = undefined;

                if (prop === 'createOutputChannel') {
                    result = createOutputChannel(port, ...args);
                }

                console.log(`W: Sent vscode.window.${VS_CALL_API} ${prop}(${args}): ${postStatus}`);
                return result;
            };
        }
    };
}

function initWorker(port) {
    setAPI('vscode', {
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
        window: new Proxy({}, creatWindowHandler(port))
    });

    setAPI('context', {
        subscriptions: createHandle({}, IdUtils.SUBSCRIPTIONS, port)
    });

    setInterval(() => {
        console.log('W: Staying alive');
    }, 5000);
}

function reactOnWorkerMessage(message, port) {
    if (message.type === VS_CALL) {
        console.log(`H: Received ${VS_CALL}: ${message.name} for h(${message.id})`);
        return true;
    }

    if (message.type === VS_REGISTER_COMMAND) {
        console.log(`H: Received ${VS_REGISTER_COMMAND}: ${message.name}`);
        const vscode = getAPI('vscode-api');
        const context = getAPI('context-api');
        console.log(`H: vscode -> ${vscode} context -> ${context} port -> ${port}`);

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
        const api = getAPI('vscode-api');
        console.log(`H: vscode-api -> ${api}`);
        const result = api.window[message.name](...message.value);

        if (message.name === 'createOutputChannel') {
            registeredChannels.set(message.value[0], result);
        }

        console.log(`H: result -> ${result}`);
        return true;
    }

    if (message.type === VS_CALL_CHANNEL) {
        console.log(`H: Received ${VS_CALL_CHANNEL}: ${message.id} -> ${message.method}(${message.args})`);

        if (registeredChannels.has(message.id)) {
            const channel = registeredChannels.get(message.id);
            console.log(`H: channel -> ${channel}`);
            channel[message.method](...message.args);
        }

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