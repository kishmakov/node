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
            try {
                const value = object[memberId];
                if (context.shouldSkipPrimitives()) {
                    const primitives = ['string', 'number', 'boolean', 'undefined', 'bigint', 'symbol'];
                    if (value === null || primitives.includes(typeof value)) continue;
                }
                result[memberId] = serializeItem(value, objectId, String(memberId));
            } catch (e) {
                // TODO: this is to clear logs from errors created by .exports access
                if (e.message && e.message.includes('is not known or not activated')) {
                    continue;
                }
                if (e.message && e.message.includes('CANNOT use API proposal')) {
                    continue;
                }
                logToFile(`failed to serialize property '${String(memberId)}' of ${objectId}:\n> message=${e.message}\n> stack=${e.stack}`);
            }
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

// Already-seen objects are mocked as references to their first occurrence.
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch (e) {
        if (e.name !== 'TypeError' && !/circular/i.test(e.message)) {
            logToFile(`safeStringify: unexpected error: ${e.message}`, true);
            return 'null';
        }

        const seen = new Map();
        let nextId = 1;

        function helper(val) {
            if (val && typeof val === 'object') {
                if (seen.has(val)) {
                    return { [IDS.SER.REF]: seen.get(val) };
                }
                const id = nextId++;
                seen.set(val, id);

                if (Array.isArray(val)) {
                    const arr = [];
                    for (let i = 0; i < val.length; i++) {
                        arr[i] = helper(val[i]);
                    }
                    return { [IDS.SER.ID]: id, [IDS.SER.VALUE]: arr };
                }

                const obj = {};
                for (const key of Reflect.ownKeys(val)) {
                    try {
                        obj[key] = helper(val[key]);
                    } catch (err) {
                        logToFile(`safeStringify: error serializing key ${String(key)}: ${err.message}`, true);
                    }
                }
                return { [IDS.SER.ID]: id, [IDS.SER.VALUE]: obj };
            }

            return val;
        }

        try {
            return JSON.stringify(helper(value));
        } catch (e2) {
            logToFile(`safeStringify: fallback failed: ${e2.message}`, true);
            return 'null';
        }
    }
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

// Reverse function for safeStringify: rebuild objects/arrays and circular references
function safeParse(jsonStr) {
    if (typeof jsonStr !== 'string' || jsonStr.length === 0) return [];
    let raw;
    try {
        raw = JSON.parse(jsonStr);
    } catch (e) {
        logToFile(`safeJSONParse: failed to parse JSON: ${e.message}`, true);
        return [];
    }

    // Fast path: if there are no $id / $ref markers, treat it as regular JSON
    const hasMarkers = (function checkMarkers(root) {
        if (!root || typeof root !== 'object') return false;

        const stack = [root];
        const visited = new Set();

        while (stack.length > 0) {
            const val = stack.pop();

            if (!val || typeof val !== 'object') continue;
            if (visited.has(val)) continue;
            visited.add(val);

            if ([IDS.SER.REF] in val || ([IDS.SER.ID] in val && [IDS.SER.VALUE] in val)) return true;

            if (Array.isArray(val)) {
                for (let i = 0; i < val.length; i++) {
                    stack.push(val[i]);
                }
            } else {
                for (const k of Object.keys(val)) {
                    stack.push(val[k]);
                }
            }
        }
        return false;
    })(raw);

    if (!hasMarkers) return raw;

    const byId = new Map();

    function build(node) {
        if (!node || typeof node !== 'object') return node;
        if (IDS.SER.REF in node) return byId.get(node[IDS.SER.REF]);

        if (IDS.SER.ID in node && IDS.SER.VALUE in node) {
            const { [IDS.SER.ID]: id, [IDS.SER.VALUE]: value } = node;
            // pre-create container to allow cycles
            let container;
            if (Array.isArray(value)) {
                container = [];
            } else if (value && typeof value === 'object') {
                container = {};
            } else {
                container = value;
            }

            byId.set(id, container);

            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    container[i] = build(value[i]);
                }
            } else if (value && typeof value === 'object') {
                for (const key of Object.keys(value)) {
                    container[key] = build(value[key]);
                }
            }

            return container;
        }

        // plain object/array inside fallback tree
        if (Array.isArray(node)) return node.map(build);

        const obj = {};
        for (const k of Object.keys(node)) {
            obj[k] = build(node[k]);
        }
        return obj;
    }

    return build(raw);
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

    return safeStringify(result);
}

function serializeResult(resultValue, resultId, provideJson = false) {
    context.cache.storeItem(resultId, resultValue);
    if (typeof resultValue === 'function') resultValue.isClass = isClass(resultValue);

    const resultSer = {
        [IDS.COMM.RESULT]: resultId,
        [IDS.COMM.VALUE]: resultValue,
    };

    const proxyTag = getValueIfPresent(resultValue, context.proxyTagKey())
    if (proxyTag) resultSer[IDS.COMM.PROXY] = proxyTag;

    if (provideJson) {
        resultSer[IDS.COMM.JSON] = safeStringify(serializeArgumentPost(resultValue));
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
    safeParse,
    serializeArgumentPost,
    serializeArguments,
    serializeResult,
    setSerializationContext,
};
