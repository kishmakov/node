'use strict';

const assert = require("internal/assert");

const {
    IDS,
    getValueIfPresent,
    isClass,
    isAsyncFunction,
    logToFile,
    print,
} = require('internal/worker/common');

const EntityType = Object.freeze({
    NUMBER: 'NUMBER',
    OBJECT: 'OBJECT',
    CLASS: 'CLASS',
    FUNCTION: 'FUNCTION',
});

let context = null;

function saveObject(object, serialization) {
    if (!context.getTracker(object)) {
        context.cache.storeItem(serialization[IDS.NEW.ITEM], object);
        context.trackItem(object, serialization);
    }
}

function serializeFunction(func, targetId, memberId) {
    assert(typeof func === 'function', 'serializeFunction called with non-function');
    assert(targetId, `serializeFunction called with empty targetId: ${targetId}`);

    const result = createHandle(
        targetId,
        memberId,
        isClass(func) ? EntityType.CLASS : EntityType.FUNCTION,
        isAsyncFunction(func)
    );

    if (!memberId) saveObject(func, result);
    return result;
}

function serializeObject(object, objectId) {
    assert(!!object && typeof object === 'object', `serializeObject called with bad object=${object}`);

    const result = createHandle(objectId);
    saveObject(object, result);

    let current = object;
    while (current && current !== Object.prototype) {
        if (current === Array.prototype) {
            result[IDS.COMM.PROTO] = 'Array';
            break;
        }
        for (const memberId of Reflect.ownKeys(current)) {
            const value = object[memberId];
            if (context.shouldSkipPrimitives()) {
                const primitives = ['string', 'number', 'boolean', 'undefined', 'bigint', 'symbol'];
                if (value === null || primitives.includes(typeof value)) continue;
            }
            result[memberId] = serializeItem(value, objectId, String(memberId));
        }
        current = Object.getPrototypeOf(current);
    }
    return result;
}

function serializeItem(arg, targetId = null, memberId = null) {
    const tracker = context.getTracker(arg);
    if (tracker) return tracker;

    const proxyTag = getValueIfPresent(arg, context.proxyTagKey())
    if (proxyTag) return {[IDS.COMM.PROXY]: proxyTag};

    const id = targetId ?? context.newId();
    let result = arg;
    if (typeof arg === 'function') result = serializeFunction(arg, id, memberId);
    if (typeof arg === 'object' && arg !== null) result = serializeObject(arg, id + (memberId ? '.' + memberId : ''));

    logToFile(`serializeItem(${print(arg)}) -> ${print(result, false)}`);
    return result;
}

/////////////////////////////// Exported functions ///////////////////////////////

function createHandle(itemId, memberId = null, type = EntityType.OBJECT, asynchronous = null) {
    return {
        [IDS.NEW.ITEM]: itemId,
        [IDS.NEW.MEMBER]: memberId,
        [IDS.NEW.TYPE]: type,
        [IDS.NEW.ASYNC]: asynchronous
    };
}

function serializeArgumentPost(arg) { return serializeItem(arg); }

function serializeArguments(port, postW2HUpdate, args) {
    const result = [];
    for (const arg of args) {
        if (CheckObjectFullyConstructed(arg)) {
            result.push(serializeArgumentPost(arg));
        } else {
            assert(!context.isOnHost, `Delayed serialization on host is not supported, arg=${arg}`);

            const id = context.newId();

            const handle = createHandle(id);
            saveObject(arg, handle);

            const proto = Object.getPrototypeOf(arg); // TODO: work it out
            const allKeys = proto
                ? new Set([...Reflect.ownKeys(arg), ...Reflect.ownKeys(proto)])
                : new Set(Reflect.ownKeys(arg));
            for (const memberId of allKeys) {
                try {
                    handle[memberId] = serializeItem(arg[memberId], id, memberId);
                } catch (e) {
                    logToFile(`failed to serialize member ${String(memberId)}, error=${e.message}`, true);
                }
            }

            Promise.resolve().then(() => {
                postW2HUpdate(port, id, serializeArgumentPost(arg));
            });

            result.push(handle);
        }
    }

    return context.isThreadPaused() && context.isOnHost ? JSON.stringify(result) : result;
}

function serializeResult(resultValue, resultId, serialize = false) {
    context.cache.storeItem(resultId, resultValue);
    if (typeof resultValue === 'function') resultValue.isClass = isClass(resultValue);

    const resultSer = {
        [IDS.COMM.RESULT]: resultId,
        [IDS.COMM.VALUE]: resultValue,
    };

    const proxyTag = getValueIfPresent(resultValue, context.proxyTagKey())
    if (proxyTag) resultSer[IDS.COMM.PROXY] = proxyTag;

    if (serialize) {
        try {
            resultSer[IDS.COMM.JSON] = JSON.stringify(serializeArgumentPost(resultValue));
        } catch (e) {
            logToFile(`serializeResult failed for resultId=${resultId}:\n\\-> error=${e.message}\n\\-> stack=${e.stack}`, true);
        }
    }

    return resultSer;
}

function setSerializationContext(threadContext) {
    context = threadContext;
    assert(context && context.cache !== undefined, 'context.cache must be present');
    assert('isOnHost' in context, 'context.isOnHost must be present');
    assert(typeof context.proxyTagKey === 'function', 'context.proxyTagKey must be present');
    assert(typeof context.newId === 'function', 'context.newId must be present');
}

module.exports = {
    EntityType,
    createHandle,
    serializeArgumentPost,
    serializeArguments,
    serializeResult,
    setSerializationContext,
};
