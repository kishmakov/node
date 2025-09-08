'use strict';

const path = require("path");
const fs = require("fs");

const {
    IDS,
    isOnHost,
} = require('internal/worker/state');

let logPath = undefined;

function initLogFile(threadId) {
    if (!process.env.ISOLATION_LOG_DIR || process.env.ISOLATION_LOG_DIR.length <= 0) return;
    logPath = path.join(process.env.ISOLATION_LOG_DIR, `log_${threadId}.txt`);
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

function getProxyHandle(arg) {
    if (arg !== null && (typeof arg === 'object' || typeof arg === 'function')) {
        const proxyIdKey = isOnHost() ? IDS.PROXY.WORKER : IDS.PROXY.HOST;
        if (proxyIdKey in arg) return { ReportedItemID: arg[proxyIdKey] };
    }

    return null;
}

function createProxyTag(id) {
    const proxyTagKey = isOnHost() ? IDS.PROXY.WORKER : IDS.PROXY.HOST;
    return { [proxyTagKey]: id };
}

module.exports = {
    initLogFile,
    logToFile,
    print,
    getProxyHandle,
    createProxyTag,
};
