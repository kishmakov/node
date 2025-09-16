'use strict';

const path = require("path");
const fs = require("fs");

const IDS = Object.freeze({
    CONTEXT: 'context',
    VSCODE: 'vscode',
    HOST: 'host',
    PROXY: {
        HOST: 'HProxyItemID',
        WORKER: 'WProxyItemID',
    },
    NEW: {
        ITEM: 'NewItemID',
        TYPE: 'NewType',
        MEMBER: 'NewMemberID',
        ASYNC: 'NewIsAsync',
    },
    REPORTED: 'ReportedItemID',
    PROTOTYPE: 'PrototypeID'
});

let logPath = undefined;

function initLogFile(threadId) {
    if (!process.env.ISOLATION_LOG_DIR || process.env.ISOLATION_LOG_DIR.length <= 0) return;
    const newPath = path.join(process.env.ISOLATION_LOG_DIR, `log_${threadId}.txt`);
    if (logPath !== newPath) {
        logPath = newPath;
        logToFile(`Log initialized at ${new Date().toISOString()}\n`);
    }
}

function print(arg, shorten = true) {
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

function printMessage(message) {
    let result = `${message.type}`;

    Object.keys(message).forEach(key => {
        if (['args', 'value', 'type'].includes(key)) return;
        result += ` ${key}=${print(message[key])}`;
    });

    return result;
}

function logToFile(message, printStack = false) {
    if (!logPath) return;

    const prefixWorker = 'W: ';
    const prefixHost = 'H: ';

    if (message.startsWith(prefixWorker)) {
        message = message.substring(prefixWorker.length);
    } else if (message.startsWith(prefixHost)) {
        message = message.substring(prefixHost.length);
    }

    const result = message + '\n' + (printStack ? `stack: ${new Error().stack}\n` : '');
    fs.appendFileSync(logPath, result);
}

function isAsyncFunction(func) {
    if (func?.constructor?.name === 'AsyncFunction') return true;
    const fnStr = func.toString();
    return fnStr.includes('__awaiter(') && fnStr.includes('function*');
}

function isClass(func) {
    return typeof func === 'function' && /^class\s/.test(Function.prototype.toString.call(func));
}

module.exports = {
    IDS,
    isAsyncFunction,
    isClass,
    initLogFile,
    logToFile,
    print,
    printMessage,
};
