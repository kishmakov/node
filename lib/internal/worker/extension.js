'use strict';

const {
    messageTypes: {
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

let globalCallback = () => {
    console.log(`W: Called initial callback`);
};

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
            if (typeof prop !== 'string') { return undefined; }

            console.log(`W: Calling ${prop} ...`);

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

                console.log(`W: Sending ${VS_CALL_API} ${prop}(${args}): ${postStatus}`);

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
            }
        },
        window: new Proxy({}, creatWindowHandler(port))
    });

    setInterval(() => {
        console.log(`W: Staying alive`);
    }, 5000);
}

function reactOnWorkerMessage(message, port) {
    if (message.type === VS_REGISTER_COMMAND) {
        console.log(`H: Received ${VS_REGISTER_COMMAND}: ${message.name}`);
        const api = getAPI('vscode-api');
        console.log(`H: vscode-api -> ${api}`);

        api.commands.registerCommand(message.name, () => {
            const result = port.postMessage({ type: CALL_COMMAND, name: message.name });
            console.log(`H: Sending ${CALL_COMMAND}: ${message.name} -> ${result}`);
        });

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