'use strict';

const {EntityType, valueToJson} = require('internal/worker/serialization_json');

const {
    IDS,
    getValueIfPresent,
    isClass,
    isAsyncFunction,
    print,
    isFunction,
    isObject,
} = require('internal/worker/common');

// const EntityType = Object.freeze({
//     UNDEFINED: 'UNDEFINED',
//     NULL: 'NULL',
//     BOOLEAN: 'BOOLEAN',
//     STRING: 'STRING',
//     NUMBER: 'NUMBER',
//     OBJECT: 'OBJECT',
//     ARRAY: 'ARRAY',
//     FUNCTION: 'FUNCTION',
//     CLASS: 'CLASS',
//     OTHER: 'OTHER',
// });

function saveObject(object, serialization) {
    if (!context.getTracker(object)) {
        context.cache.storeItem(serialization[IDS.NEW.ITEM], object);
        context.trackItem(object, serialization);
    }
}

function serializeFunction(func, targetId, memberId) {
    assert(isFunction(func), 'serializeFunction called with non-function');
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
    assert(isObject(object), `serializeObject called with bad object=${object}`);

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
    if (isFunction(arg)) result = serializeFunction(arg, id, memberId);
    if (isObject(arg)) result = serializeObject(arg, id + (memberId ? '.' + memberId : ''));

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
    }

    const val2id = new Map();
    let nextId = 1;

    function convert(val) {
        if (val && typeof val === 'object') {
            if (val2id.has(val)) return {[IDS.SER.REF]: val2id.get(val)};

            const id = nextId++;
            val2id.set(val, id);

            if (Array.isArray(val)) {
                const arr = [];
                for (let i = 0; i < val.length; i++) {
                    arr[i] = convert(val[i]);
                }
                return {[IDS.SER.ID]: id, [IDS.SER.VALUE]: arr};
            }

            const obj = {};
            for (const key of Reflect.ownKeys(val)) {
                obj[key] = convert(val[key]);
            }
            return {[IDS.SER.ID]: id, [IDS.SER.VALUE]: obj};
        }

        return val;
    }

    try {
        return JSON.stringify(convert(value));
    } catch (e) {
        logToFile(`safeStringify: fallback failed: ${e.message}`, true);
        return 'null';
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
        logToFile(`safeParse: failed to parse JSON: ${e.message}`, true);
        return [];
    }

    // checks for [IDS.SER.ID] markers
    const hasMarkers = (function checkMarkers(root) {
        if (!root || typeof root !== 'object') return false;

        const stack = [root];
        const visited = new Set();

        while (stack.length > 0) {
            const val = stack.pop();
            if (!val || typeof val !== 'object' || visited.has(val)) continue;
            visited.add(val);

            if ([IDS.SER.ID] in val) return true;

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

    if (!hasMarkers) return raw; // regular JSON

    const id2val = new Map();

    function build(node) {
        if (!node || typeof node !== 'object') return node;
        if (IDS.SER.REF in node) return id2val.get(node[IDS.SER.REF]);

        if (IDS.SER.ID in node && IDS.SER.VALUE in node) {
            const {[IDS.SER.ID]: id, [IDS.SER.VALUE]: value} = node;
            // pre-create container to allow cycles
            let container;
            if (Array.isArray(value)) {
                container = [];
            } else if (value && typeof value === 'object') {
                container = {};
            } else {
                container = value;
            }

            id2val.set(id, container);

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

function serializeArguments(port, postW2HUpdate, args) {
    const result = [];
    for (const arg of args) {
        if (CheckObjectFullyConstructed(arg)) {
            result.push(serializeItem(arg));
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
                postW2HUpdate(port, id, serializeItem(arg));
            });

            result.push(handle);
        }
    }

    return safeStringify(result);
}

// function serializeResult(result, callId, provideJson = false) {
//     context.cache.storeItem(callId, result);
//     if (isFunction(result)) result.isClass = isClass(result);
//
//     const resultSer = {
//         [IDS.COMM.CALL]: callId,
//         [IDS.COMM.VALUE]: result,
//     };
//
//     const proxyTag = getValueIfPresent(result, context.proxyTagKey())
//     if (proxyTag) resultSer[IDS.COMM.PROXY] = proxyTag;
//     if (provideJson) resultSer[IDS.COMM.JSON] = safeStringify(serializeItem(result));
//
//     return resultSer;
// }

// Code below goes to communication/serialization.js

function createTracker(value) {
    const itemId = context.newId();
    context.cache.storeItem(itemId, value);
    const tracker = {[IDS.COMM.ITEM]: itemId};
    tracker[IDS.COMM.JSON] = valueToJson(value);
    return tracker;
}

function getOrCreateTracker(value) {
    let tracker = context.getTracker(value);
    if (tracker) return tracker;

    tracker = createTracker(value);
    context.trackItem(value, tracker);
    return tracker;
}

function deserializeTracker(port, tracker) {
    assert(isObject(tracker), `deserializeTracker: input failed: got ${tracker}`);
    assert(IDS.COMM.ITEM in tracker, `deserializeTracker: input failed: missing ${IDS.COMM.ITEM}`);
    assert(IDS.COMM.JSON in tracker, `deserializeTracker: input failed: missing ${IDS.COMM.JSON}`);
    const {[IDS.COMM.ITEM]: id, [IDS.COMM.JSON]: json} = tracker;
    if (context.cache.hasProxy(id)) return context.cache.getProxy(id);
    return jsonToProxy(port, id, json);
}

function serializeValue(value) {
    const proxyId = getValueIfPresent(value, IDS.PROXY_TAG)
    return proxyId ? {[IDS.COMM.PROXY]: proxyId} : getOrCreateTracker(value);
}

function serializeResult(callId, value) {
    const handle = serializeValue(value);
    handle[IDS.COMM.CALL] = callId;
    return handle;
}

function deserializeValue(port, value) {
    if (IDS.COMM.PROXY in value) return context.getItem(value[IDS.COMM.PROXY]);
    return deserializeTracker(port, value);
}

function deserializeResult(port, value, sync) {
    assert(isObject(value), `deserializeResult: input failed: got ${value}`);
    if (IDS.COMM.PROXY in value) return context.getItem(value[IDS.COMM.PROXY]);

    assert(IDS.COMM.CALL in value, `deserializeResult: input failed: missing ${IDS.COMM.CALL}`);
    let {[IDS.COMM.CALL]: callId} = value;

    if (!sync) {
        return new Promise((resolve, reject) => {
            logToFile(`  resolves[${callId}] and rejects[${callId}] are set`);
            context.resolves.set(callId, resolve);
            context.rejects.set(callId, reject);
        });
    }

    if (!(IDS.COMM.ITEM in value)) value[IDS.COMM.ITEM] = callId;
    if (!(IDS.COMM.JSON in value)) {
        value[IDS.COMM.JSON] = {
            [IDS.SER.ID]: callId,
            [IDS.SER.TYPE]: EntityType.OBJECT,
            [IDS.SER.VALUE]: {}
        };
    }

    return deserializeValue(port, value);
}

function setupSerializationFunctionality() {
    global.serializeValue = serializeValue;
    global.serializeResult = serializeResult;
    global.deserializeValue = deserializeValue;
    global.deserializeResult = deserializeResult;
}

module.exports = {
    createHandle,
    serializeItem,
    setupSerializationFunctionality,
};
