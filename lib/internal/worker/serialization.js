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
            result[IDS.PROTOTYPE] = 'Array';
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

function serializeResult(result, resultId) {
    context.cache.storeItem(resultId, result);
    if (typeof result === 'function') result.isClass = isClass(result);

    const result_ser = {
        [IDS.COMM.RESULT]: resultId,
        [IDS.COMM.VALUE]: result,
    };

    const proxyTag = getValueIfPresent(result, context.proxyTagKey())
    if (proxyTag) result_ser[IDS.COMM.PROXY] = proxyTag;

    return result_ser;
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
    saveObject,
    serializeArgumentPost,
    serializeResult,
    setSerializationContext,
};
