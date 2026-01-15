'use strict';


const IDS = Object.freeze({
    CONTEXT: 'context',
    VSCODE: 'vscode',
    HOST: 'host',
    ACTIVATION_RESULT: 'ActivationResult',
    PROXY_TAG: 'ProxyItemID',
    NEW: {
        ITEM: 'NewItemID',
        TYPE: 'NewType',
        MEMBER: 'NewMemberID',
        ASYNC: 'NewIsAsync',
    },
    COMM: {
        CALL: 'CommCallID', // id marker to associate call results
        PROXY: 'CommProxyID', // for proxied objects
        TYPE: 'CommTypeID', // for code of type
        PROTO: 'CommProtoID', // for name of proto class
        ITEM: 'CommItemID',
        MEMBER: 'CommMemberID',
        VALUE: 'CommValue',
        JSON: 'CommJSON',
    },
    SER: {
        ID: 'SerID',
        VALUE: 'SerValue',
        REF: 'SerRef',
    }
});

function print(arg, shorten = true) {
    let result;

    try {
        if (isObject(arg)) {
            if (arg.isProxy) {
                result = arg.toPrimitive();
            } else if (isFunction(arg.then) && 'then' in arg) {
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

function isAsyncFunction(func) {
    if (func?.constructor?.name === 'AsyncFunction') return true;
    const fnStr = func.toString();
    return fnStr.includes('__awaiter(') && fnStr.includes('function*');
}

function isFunction(value) {
    return value !== null && typeof value === 'function';
}

function isObject(value) {
    return value !== null && typeof value === 'object';
}

function isClass(func) {
    return isFunction(func) && /^class\s/.test(Function.prototype.toString.call(func));
}

function isConstructor(func) {
    return isFunction(func) &&
        func.prototype &&
        Object.getOwnPropertyNames(func.prototype).length > 1;
}

function isThenable(value) {
    return value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof value.then === 'function';
}

function getValueIfPresent(obj, key, defaultValue = null) {
    return (obj && Object.prototype.hasOwnProperty.call(obj, key)) ? obj[key] : defaultValue;
}

module.exports = {
    IDS,
    getValueIfPresent,
    isAsyncFunction,
    isClass,
    isConstructor,
    isFunction,
    isObject,
    isThenable,
    print,
    printMessage,
};
