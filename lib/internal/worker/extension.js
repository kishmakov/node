'use strict';

const assert = require('internal/assert');

const {
    messageTypes: {
        ANY_TYPE,
        ANY_SET,
        ANY_PROMISE,
        H2W_CALL,
        W2H_CALL,
        W2H_PROMISE,
        W2H_SET,
        W2H_UPDATE,
    }
} = require('internal/worker/io');

const {
    IDS,
    getValueIfPresent,
    isConstructor,
    print,
    printMessage,
    isFunction,
    isObject,
} = require("internal/worker/common");

const {
    EntityType,
    createHandle,
    safeParse,
    serializeItem,
    serializeResult,
    setSerializationContext,
} = require('internal/worker/serialization');

const {
    mixInType,
    setCommunicationContext,
} = require('internal/worker/communication');

// function prepareFunctionCall(targetId, memberId, args, isAsync) {
//     let func;
//     let thisArg = context.cache.lookUpItem(targetId);
//     let callArgs;
//     let funcStr = (isAsync ? 'async ' : '') + `items[${targetId}]`;
//
//     if (memberId) {
//         assert(memberId in thisArg, `failed to find ${memberId} in items[${targetId}]`);
//         func = thisArg[memberId];
//         callArgs = args;
//         funcStr += '.' + memberId;
//     } else {
//         assert(Array.isArray(args) && args.length > 0, `failed to provide 'this' for items[${targetId}] call`);
//         func = thisArg;
//         thisArg = args[0];
//         callArgs = args.slice(1);
//     }
//
//     return {func, thisArg, callArgs, funcStr};
// }
//
// function callOrConstruct(func, thisArg, callArgs, funcStr) {
//     function construct() {
//         const resultStr = 'construct';
//         let result = undefined;
//         let error = undefined;
//
//         try {
//             result = Reflect.construct(func, callArgs);
//
//         } catch (constructError) {
//             error = constructError;
//         }
//
//         return {resultStr, result, error};
//     }
//
//     function apply() {
//         const resultStr = 'apply';
//         let result = undefined;
//         let error = undefined;
//
//         try {
//             result = func.apply(thisArg, callArgs);
//         } catch (constructError) {
//             error = constructError;
//         }
//
//         return {resultStr, result, error};
//     }
//
//     const methods = (isConstructor(func) && !thisArg) ? [construct, apply] : [apply, construct];
//     let errors = [];
//
//     for (const method of methods) {
//         const {resultStr, result, error} = method();
//
//         if (!error) {
//             logToFile(`  callOrConstruct funcStr=${funcStr} via ${resultStr} -> ${print(result)}`);
//             return result;
//         }
//
//         errors.push([resultStr, error]);
//     }
//
//     for (const [resultStr, error] of errors) {
//         logToFile(`  callOrConstruct funcStr=${funcStr} via ${resultStr} failed:`);
//         logToFile(`    thisArg=${thisArg}`);
//         logToFile(`    callArgs=${callArgs}`);
//         logToFile(`    stack=${error.stack}`)
//         logToFile(`    func=${func}`);
//     }
//
//     return undefined;
// }
//
// function callFunctionCommon(targetId, memberId, jsonArgs, isAsync) {
//     const serializedArgs = safeParse(jsonArgs);
//     const args = serializedArgs.map(arg => deserializeItem(context.port, arg));
//     const {func, thisArg, callArgs, funcStr} = prepareFunctionCall(targetId, memberId, args, isAsync);
//     return callOrConstruct(func, thisArg, callArgs, funcStr);
// }
//
// function callWorkerFunctionCommon(callId, targetId, memberId, jsonArgs, isAsync) {
//     const result = callFunctionCommon(targetId, memberId, jsonArgs, isAsync);
//     logToFile(`  callWorkerFunctionCommon callId=${callId} result=${print(result)}`);
//
//     if (isAsync && !!result) {
//         result
//             .then(res => postW2HPromise(context.port, true, callId, serializeItem(res)))
//             .catch(err => postW2HPromise(context.port, false, callId, serializeItem(err)));
//     }
//
//     return result;
// }
//
// function callWorkerFunctionSync(callId, targetId, memberId, jsonArgs, isAsync) {
//     assert(typeof jsonArgs === 'string', 'failed: jsonArgs != string @ callHostFunctionSync');
//     const coords = `callId=${callId} targetId=${targetId} memberId=${memberId} isAsync=${isAsync}`;
//     logToFile(`callWorkerFunctionSync ${coords}`);
//     const result = callWorkerFunctionCommon(callId, targetId, memberId, jsonArgs, isAsync);
//     return serializeResult(result, callId, true)
// }
//
// function callWorkerFunctionAsync(callId, targetId, memberId, jsonArgs, isAsync) {
//     logToFile(`<-${H2W_CALL} args=${print(jsonArgs)}`);
//     const result_raw = callWorkerFunctionCommon(callId, targetId, memberId, jsonArgs, isAsync)
//     context.cache.storeItem(callId, result_raw);
// }
//
// function callHostFunctionInternal(callId, targetId, memberId, jsonArgs) {
//     const result = callFunctionCommon(targetId, memberId, jsonArgs, false);
//     return serializeResult(result, callId, true);
// }

// function callHostFunctionSync(targetId, memberId, jsonArgs) {
//     assert(typeof jsonArgs === 'string', 'failed: jsonArgs != string @ callHostFunctionSync');
//     const callId = context.newId();
//     logToFile(`  callHostFunctionSync callId=${callId}`);
//     const result = callHostFunctionInternal(callId, targetId, memberId, jsonArgs);
//     logToFile(`  callHostFunctionSync callId=${callId} result=${print(result)}`);
//     return result;
// }
//
// function callHostFunctionAsync(callId, targetId, memberId, jsonArgs) {
//     logToFile(`<-${W2H_CALL} args=${print(jsonArgs)}`);
//     const resultSer = callHostFunctionInternal(callId, targetId, memberId, jsonArgs);
//     const coords = `callId=${callId} targetId=${targetId} memberId=${memberId}`;
//     logToFile(`callHostFunctionAsync ResumeCall before ${coords}`);
//     ResumeCall(context.destId, callId, targetId, resultSer);
//     logToFile(`callHostFunctionAsync ResumeCall after ${coords}`);
// }

// Update management
// function updateHostObject(message) {
//     const { targetId: targetId, propertyId: propertyId, value: value } = message;
//     const target = context.cache.lookUpItem(targetId);
//     target[propertyId] = deserializeItem(context.port, value);
//     logToFile(`H: items[${targetId}].${propertyId} := ${print(value)}`);
// }
//
// function updateObject(message) {
//     const { targetId: targetId, value: value } = message;
//     context.cache.storeItem(targetId, value);
//     logToFile(`H: items[${targetId}] := ${print(value)}`);
// }

// function syncHandler(type, callId, targetId, memberId, jsonArgs, isAsync, serialize) {
//     if (!context.isOnHost && type === H2W_CALL) {
//         return callWorkerFunctionSync(callId, targetId, memberId, jsonArgs, isAsync);
//     }
//     if (context.isOnHost && type === W2H_CALL) {
//         return callHostFunctionSync(targetId, memberId, jsonArgs);
//     }
//
//     if (type === ANY_TYPE) return lookUpTypeCommon(callId, targetId, serialize);
//
//     logToFile(`>>> failed: not implemented for ${type} <<<`);
//     return undefined;
// }

// Deserialization
// function deserializeItem(port, handle, dstStr = `deserialize(${print(handle)})`) {
//     let result = handle;
//     if (isObject(handle)) {
//         if (IDS.NEW.ITEM in handle) {
//             result = createItemProxy(port, handle);
//             logToFile(`  ${dstStr} resulted in creation proxies[${handle[IDS.NEW.ITEM]}]`);
//         } else if (IDS.COMM.PROXY in handle) {
//             result = context.cache.lookUpItem(handle[IDS.COMM.PROXY]);
//             logToFile(`  ${dstStr} looked up as items[${handle[IDS.COMM.PROXY]}]`);
//         }
//     } else {
//         logToFile(`  ${dstStr} passed as is`);
//     }
//
//     return result;
// }

// function deserializeResult(port, isAsync, value) {
//     logToFile(`deserializeResult value=${print(value)}`);
//     if (!value) return value;
//     if ('simpleValue' in value) return value.simpleValue;
//
//     const proxyTag = getValueIfPresent(value, IDS.COMM.PROXY);
//     if (proxyTag) return context.cache.lookUpItem(proxyTag);
//
//     const handle = createHandle(value[IDS.COMM.CALL], null, mixInType(value), isAsync);
//
//     const json_str = getValueIfPresent(value, IDS.COMM.JSON);
//     if (typeof json_str === 'string' && json_str.length > 0) {
//         try {
//             Object.assign(handle, safeParse(json_str));
//         } catch (e) {
//             logToFile(`Failed to parse ${json_str}: ${e}`, true);
//         }
//     }
//
//     return createItemProxy(port, handle);
// }

function resolveActivationResult(res) {
    context.cache.storeItem(IDS.ACTIVATION_RESULT, res);
    // postW2HPromise(context.port, true, IDS.ACTIVATION_RESULT, serializeItem(res));
}

function commonFieldGetter(target, name, proxyStr) {
    assert(proxyStr, 'proxyStr must be provided');
    if (name === 'isProxy') return true;
    if (name === '__esModule') return true;
    if (name === 'toPrimitive' || name === Symbol.toPrimitive) return () => proxyStr;
}

function createForEach(port, target, itemId) {
    return function (callback, thisArg) {
        if (target[IDS.COMM.PROTO] === 'Array') {
            const lengthObject = anyType(port, itemId + '.length');
            for (let i = 0; i < lengthObject.simpleValue; i++) {
                const callResult = anyType(port, `${itemId}.${i}`, true);
                const handle = callResult._as_json;  // TODO: check if ids are fine
                handle.type = callResult.type;
                const proxy = createItemProxy(port, handle);
                callback.call(thisArg, proxy, i, target);
            }
        }
    };
}

function createProxyIterator(port, itemId) {
    return function* () {
        const lengthObject = anyType(port, itemId + '.length');

        if (lengthObject.type === EntityType.NUMBER) {
            for (let i = 0; i < lengthObject.simpleValue; i++) {
                const callResult = anyType(port, `${itemId}.${i}`, true);
                const handle = callResult._as_json;  // TODO: check if ids are fine
                handle.type = callResult.type;
                yield createItemProxy(port, handle);
            }
        }
    };
}

function createWorkerProxyHandler(port, itemId, itemStr, proxyStr) {
    return {
        __proto__: null,
        get(target, name) {
            if (name in target) return target[name];
            const value = commonFieldGetter(target, name, proxyStr);
            if (Object.isExtensible(target) && value !== undefined) target[name] = value;
            logToFile(`get ${itemStr}.'${String(name)}' resulted in ${print(value)}`);
            return value;
        },
        set() { return true; }
    };
}

function createHostProxyHandler(port, itemId, itemStr, proxyStr) {
    const blacklist = new Set([String(IDS.PROXY.HOST), 'type', 'isProxy', 'toPrimitive']);

    return {
        __proto__: null,
        ownKeys(target) {
            logToFile(`W: ownKeys at ${itemStr}`);
            const keys = Reflect.ownKeys(target);
            return keys.filter(k => !blacklist.has(String(k)));
        },
        getOwnPropertyDescriptor(target, prop) {
            logToFile(`W: getOwnPropertyDescriptor at ${itemStr} for ${String(prop)}`);
            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        get(target, name) {
            if (name in target) return target[name];
            const memberStr = `${itemStr}.'${String(name)}'`;
            let value = commonFieldGetter(target, name, proxyStr);
            if (value) {
                target[name] = value;
                logToFile(`W: get ${memberStr} via hardcoded ${print(value)}`);
                return value;
            }

            // Prevent JSON.stringify from triggering cross-thread communication on non-paused threads
            if (name === 'toJSON' && !context.getPaused()) {
                logToFile(`W: get ${memberStr} skipped on non-paused thread`);
                return undefined;
            }

            if (name === 'forEach') return createForEach(port, target, itemId);
            if (name === Symbol.iterator) return createProxyIterator(port, itemId);

            const memberId = itemId + '.' + String(name);
            logToFile(`W: get ${memberStr} needs call to host ...`);
            const typeResult = anyType(port, memberId);

            if (typeResult === undefined) {
                logToFile(`W: get ${memberStr} resulted in undefined from host`);
                return undefined;
            }

            if ('simpleValue' in typeResult) {
                logToFile(`W: get ${memberStr} resulted via simpleValue in ${typeResult.simpleValue}`);
                return typeResult.simpleValue;
            }

            let newItemId = memberId;
            let newMemberId = null;
            let type = typeResult.type;

            if (type === EntityType.CLASS || type === EntityType.FUNCTION) {
                newItemId = itemId;
                newMemberId = String(name);
            } else {
                assert(type === EntityType.OBJECT, `W: anyType returned unknown type ${type} for id=${memberId}`);
            }

            let handle = createHandle(newItemId, newMemberId, type);
            handle[IDS.COMM.PROTO] = typeResult[IDS.COMM.PROTO];
            target[name] = createItemProxy(port, handle);
            logToFile(`W: get ${memberStr} resulted via proxy in  ${print(target[name])}`);
            return target[name];
        },
        set(target, name, value) {
            const memberStr = `${itemStr}.'${String(name)}'`;
            const serializedValue = serializeItem(value);
            postW2HSet(port, itemId, name, serializedValue);
            logToFile(`W: set ${memberStr}.'${String(name)}' to ${print(serializedValue)}`);
            return true;
        }
    };
}

function copyRemainingHandleFields(port, target, source, targetStr) {
    for (const memberId of Reflect.ownKeys(source)) {
        target[memberId] = deserializeItem(port, source[memberId], `${targetStr}.'${String(memberId)}'`);
    }
    if (context.isOnHost || context.getPaused()) { // TODO
        if (source[IDS.COMM.PROTO] === 'Array') Object.setPrototypeOf(target, Array.prototype);
    }
}

function createProxyFunction(port, targetId, memberId, isAsync, funcStr, fullId) {
    const createProxy = context.isOnHost ? createWorkerFunctionProxy : createHostFunctionProxy;
    logToFile(`   createProxyFunction ${funcStr} for targetId=${targetId} memberId=${memberId}`);

    const result = createProxy(port, targetId, memberId, isAsync, funcStr);
    Object.assign(result, {[context.proxyTagKey()]: fullId});
    return result;
}

function createProxyObject(base, port, fullId, itemStr, proxyStr) {
    Object.assign(base, {[context.proxyTagKey()]: fullId});
    logToFile(`   createProxyObject id=${fullId} item=${itemStr}`);
    const createHandler = context.isOnHost ? createWorkerProxyHandler : createHostProxyHandler;
    return new Proxy(base, createHandler(port, fullId, itemStr, proxyStr));
}

function createItemProxy(port, objectHandle) {
    const {
        [IDS.NEW.ITEM]: itemId,
        [IDS.NEW.MEMBER]: memberId,
        [IDS.NEW.TYPE]: type,
        [IDS.NEW.ASYNC]: isAsync,
        ...remainingHandle
    } = objectHandle;
    assert(itemId, `itemId is not defined in objectHandle: ${print(objectHandle)}`);
    const fullId = itemId + (memberId ? `.${memberId}` : '');
    if (context.cache.hasProxy(fullId)) return context.cache.getProxy(fullId);

    logToFile(`   createItemProxy id=${itemId} member=${memberId} type=${type} async=${isAsync}`);

    let result;
    const proxyStr = `ProxiedID: ${fullId}, Type: ${type}`;
    const itemStr = `proxies[${itemId}]` + (memberId ? `.${memberId}` : '');

    if (context.isOnHost && type === EntityType.OBJECT && isAsync) {
        result = new Promise((resolve, reject) => {
            logToFile(`filling in hostResolves and hostRejects for id=${itemId}`);
            hostResolves.set(itemId, resolve);
            hostRejects.set(itemId, reject);
        });
    } else {
        let base = null;
        if (type === EntityType.FUNCTION) {
            result = createProxyFunction(port, itemId, memberId, isAsync, itemStr, fullId);
            result.type = EntityType.FUNCTION;
        } else if (type === EntityType.CLASS) {
            base = createProxyFunction(port, itemId, memberId, isAsync, itemStr, fullId);
            base.type = EntityType.CLASS;
        } else if (type === EntityType.OBJECT) {
            base = {type: EntityType.OBJECT};
        }
        else assert(false, `createItemProxy unknown type ${type} id=${fullId}`);
        if (base) result = createProxyObject(base, port, fullId, itemStr, proxyStr);
        context.storeProxy(fullId, result);
        if (base) copyRemainingHandleFields(port, base, remainingHandle, itemStr);
    }
    return result;
}

function createWorkerFunctionProxy(port, targetId, memberId, isAsync, funcStr) {
    assert(typeof targetId === 'string', `failed targetId != string @ createWorkerFunctionProxy`);
    const coord = `targetId=${targetId} memberId=${memberId} isAsync=${isAsync}`;
    logToFile(`createWorkerFunctionProxy ${coord}`);
    return function (...args) {
        logToFile(`workerFunctionProxy.1/2 ${coord} ${funcStr}(...)`);
        const callArgs = !memberId ? [this, ...args] : args;
        const result = anyH2WCall(port, targetId, memberId, isAsync, callArgs);
        logToFile(`workerFunctionProxy.2/2 ${coord} result=${print(result)}`);
        return deserializeResult(port, isAsync, result);
    };
}

function createHostFunctionProxy(port, targetId, memberId, isAsync, funcStr) {
    assert(typeof targetId === 'string', `failed targetId != string @ createHostFunctionProxy`);
    const coord = `targetId=${targetId} memberId=${memberId} isAsync=${isAsync}`;
    return function (...args) {
        logToFile(`hostFunctionProxy.1/2 ${coord} ${funcStr}(...)`);
        const callArgs = !memberId ? [this, ...args] : args;
        const result = anyW2HCall(port, targetId, memberId, isAsync, callArgs);
        logToFile(`hostFunctionProxy.2/2 ${coord} result=${print(result)}`);
        return deserializeResult(port, false, result);
    };
}

// Function call management
function callOrConstruct(func, thisArg, callArgs, funcStr) {
    function construct() {
        const resultStr = 'construct';
        let result = undefined;
        let error = undefined;

        try {
            result = Reflect.construct(func, callArgs);

        } catch (constructError) {
            error = constructError;
        }

        return {resultStr, result, error};
    }

    function apply() {
        const resultStr = 'apply';
        let result = undefined;
        let error = undefined;

        try {
            result = func.apply(thisArg, callArgs);
        } catch (constructError) {
            error = constructError;
        }

        return {resultStr, result, error};
    }

    const methods = (isConstructor(func) && !thisArg) ? [construct, apply] : [apply, construct];
    let errors = [];

    for (const method of methods) {
        const {resultStr, result, error} = method();

        if (!error) {
            logToFile(`  callOrConstruct ${funcStr} via ${resultStr} -> ${print(result)}`);
            return result;
        }

        errors.push([resultStr, error]);
    }

    for (const [resultStr, error] of errors) {
        logToFile(`  callOrConstruct ${funcStr} via ${resultStr} failed:`);
        logToFile(`    thisArg=${thisArg}`);
        logToFile(`    callArgs=${callArgs}`);
        logToFile(`    stack=${error.stack}`)
        logToFile(`    func=${func}`);
    }

    return undefined;
}

function callFunctionCommon(functionId, thisId, valueArgs) {
    const args = valueArgs.map(arg => deserializeValue(context.port, arg));
    const func = context.cache.lookUpItem(functionId);
    const thisArg = context.cache.lookUpItem(thisId);
    const funcStr = `items[${functionId}](${thisId}, ...)`;
    return callOrConstruct(func, thisArg, args, funcStr);
}

function callFunctionAsync(callId, functionId, thisId, valueArgs) {
    const type = context.isOnHost ? W2H_CALL : H2W_CALL;
    logToFile(`<-${type} callId=${callId} args=${print(valueArgs)}`);
    const objectRes = callFunctionCommon(functionId, thisId, valueArgs)
    logToFile(`  callFunctionAsync callId=${callId} result=${print(objectRes)}`);
    context.cache.storeItem(callId, objectRes);

    if (isThenable(objectRes)) {
        objectRes
            .then(res => anyPromise(context.port, callId, true, res))
            .catch(err => anyPromise(context.port, callId, false, err));
    }

    if (context.isOnHost) {
        const valueRes = serializeResult(callId, objectRes);
        ResumeCall(context.destId, callId, functionId, valueRes);
    }
}

function callFunctionSync(callId, functionId, thisId, valueArgs) {
    const objectRes = callFunctionCommon(functionId, thisId, valueArgs)
    return serializeResult(callId, objectRes);
}

function getTypeCommon(callId, targetId) {
    const objectRes = context.cache.lookUpItem(targetId, false);
    return serializeResult(callId, objectRes);
}

function getTypeAsync(callId, targetId) {
    logToFile(`<-${ANY_TYPE} callId=${callId}  targetId=${targetId}`);
    const result = getTypeCommon(callId, targetId);
    ResumeCall(context.destId, callId, targetId, result);
    logToFile(`ResumeCall callId=${callId} targetId=${targetId}`);
}

function updateItemAsync(callId, targetId, memberId, value) {
    logToFile(`<-${ANY_SET} targetId=${targetId} memberId=${memberId} value=${print(value)}`);
    const target = context.cache.lookUpItem(targetId);
    target[memberId] = deserializeValue(context.port, value);
}

function resolvePromise(resolve, promiseId, value) {
    const map =  resolve ? context.resolves : context.rejects;
    const func = map.get(promiseId);
    assert(isFunction(func), `failed to locate proper promise handler promiseId=${promiseId}`);
    const proxy = deserializeValue(context.port, value);
    func(proxy);
}

function asyncHandler(message) {
    const {type} = message;

    if (type === ANY_SET) {
        const {callId, targetId, memberId, value} = message;
        updateItemAsync(callId, targetId, memberId, value);
    } else if (type === ANY_PROMISE) {
        const {resolve, promiseId, value} = message;
        resolvePromise(resolve, promiseId, value);
    } else if (type === ANY_TYPE) {
        const {callId, targetId} = message;
        getTypeAsync(callId, targetId);
    } else if (type === W2H_CALL || type === H2W_CALL) {
        const {callId, functionId, thisId, valueArgs} = message;
        callFunctionAsync(callId, functionId, thisId, valueArgs);
    } else {
        assert(false, `asyncHandler: unknown message type ${type}`);
    }
}

function syncHandler(type, callId, functionId, thisId, valueArgs) {
    if (type === H2W_CALL || type === W2H_CALL) {
        logToFile(`<=${type} args=${print(valueArgs)}`);
        return callFunctionSync(callId, functionId, thisId, valueArgs);
    }

    console.log(`>>> failed: not implemented for ${type} <<<`);
    return undefined;
}

function reactOnMessage(message) {
    if (typeof logToFile === 'undefined') return false;

    try {
        logToFile('<-' + printMessage(message));
        asyncHandler(message);
        return true;
    } catch (e) {
        const msg = JSON.stringify(message);
        logToFile(`reactOnMessage failed message=${msg}\n:> ${e}\n:> stack: ${e.stack}`)
    }

    return false;
}

module.exports = {
    resolveActivationResult,
    reactOnMessage,
    syncHandler,
};
