'use strict';

const {
    IDS,
    isClass,
    isFunction,
    isObject,
    isThenable,
    isAsyncFunction,
} = require('internal/worker/common');

// Code below goes to communication/serialization_json.js

// keep in sync with v8/src/inspector/v8-debugger.h
const EntityType = Object.freeze({
    UNDEFINED: 'UNDEFINED',
    NULL: 'NULL',
    BOOLEAN: 'BOOLEAN',
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    OBJECT: 'OBJECT',
    ARRAY: 'ARRAY',
    FUNCTION: 'FUNCTION',
    ASYNC_FUNCTION: 'ASYNC_FUNCTION',
    CLASS: 'CLASS',
    PROMISE: 'PROMISE',
    OTHER: 'OTHER',
    isFunctionType(type) {
        return type === EntityType.FUNCTION || type === EntityType.ASYNC_FUNCTION;
    }
});

function getType(value) {
    let type = EntityType.OTHER;
    if (value === undefined) type = EntityType.UNDEFINED;
    else if (value === null) type = EntityType.NULL;
    else if (typeof value === 'boolean') type = EntityType.BOOLEAN;
    else if (typeof value === 'number') type = EntityType.NUMBER;
    else if (typeof value === 'string') type = EntityType.STRING;
    else if (isThenable(value)) type = EntityType.PROMISE;
    else if (isFunction(value)) {
        if (isClass(value)) type = EntityType.CLASS;
        else if (isAsyncFunction(value)) type = EntityType.ASYNC_FUNCTION;
        else type = EntityType.FUNCTION;
    }
    else if (isObject(value)) type = Array.isArray(value) ? EntityType.ARRAY : EntityType.OBJECT;

    let sync = true;
    return [type, sync];
}

function valueToJson(value, valueId) {
    assert(valueId, `valueToJson: input failed: got valueId=${valueId}`);
    const valueToId = new Map();
    let nextId = 1;

    function jsonify(val, absoluteId) {
        if (valueToId.has(val)) return {[IDS.SER.REF]: valueToId.get(val)};

        const id = nextId++;
        valueToId.set(val, id);

        const [type, _] = getType(val);
        const result = {[IDS.SER.ID]: id, [IDS.SER.TYPE]: type};

        if (type === EntityType.UNDEFINED || type === EntityType.NULL) {
            return result;
        }

        if (type === EntityType.BOOLEAN || type === EntityType.STRING || type === EntityType.NUMBER) {
            result[IDS.SER.VALUE] = val;
        }

        if (type === EntityType.OBJECT) {
            const obj = {};
            for (const key of Reflect.ownKeys(val)) {
                try {
                    obj[key] = jsonify(val[key], absoluteId + '.' + key);
                } catch(e) {
                    logToFile(`jsonify failed to access key=${key} of object absoluteId=${absoluteId}`);
                }
            }
            result[IDS.SER.VALUE] = obj;
        }

        if (type === EntityType.ARRAY) {
            const arr = {};
            for (let i = 0; i < val.length; i++) arr[i] = jsonify(val[i], absoluteId + '.' + i);
            arr.length = val.length;
            result[IDS.SER.VALUE] = arr;
        }

        if (type === EntityType.PROMISE) {
            result[IDS.SER.ABSOLUTE] = absoluteId;
            val
                .then(res => anyPromise(context.port, absoluteId, true, res))
                .catch(err => anyPromise(context.port, absoluteId, false, err));
        }

        return result;
    }

    try {
        return jsonify(value, valueId);
    } catch (e) {
        logToFile(`jsonify failed: message=${e.message}\n stack=${e.stack}`, true);
        return null;
    }
}

// Produces precursor for building proxy. Partly reverses valueToJson,
// taking care of circular references and types.
function jsonToAssembler(json) {
    assert(isObject(json), `jsonToAssembler: input failed: got ${json}`);
    const ser_keys = new Set([IDS.SER.ID, IDS.SER.TYPE, IDS.SER.VALUE, IDS.SER.REF]);
    const id2val = new Map();

    function build(node) {
        assert(isObject(node), `jsonToAssembler.build failed to process node=${node}`);
        if (IDS.SER.REF in node) return id2val.get(node[IDS.SER.REF]);

        assert(IDS.SER.TYPE in node, 'jsonToAssembler.build failed to read node type');
        assert(IDS.SER.ID in node, 'jsonToAssembler.build failed to read node id');
        const {[IDS.SER.ID]: id, [IDS.SER.VALUE]: value, [IDS.SER.TYPE]: type} = node;

        if (type === EntityType.UNDEFINED) return undefined;
        if (type === EntityType.NULL) return null;

        if (type === EntityType.CLASS) {
            const result = {[IDS.SER.TYPE]: type, [IDS.SER.ID]: id};
            id2val.set(id, result);
            return result;
        }

        if (type === EntityType.PROMISE) {
            const result = {[IDS.SER.TYPE]: type, [IDS.SER.ID]: node[IDS.SER.ABSOLUTE]};
            id2val.set(id, result);
            return result;
        }

        if (EntityType.isFunctionType(type)) {
            const result = {[IDS.SER.TYPE]: type, [IDS.SER.ID]: id};
            if ([IDS.SER.PARENT] in node) result[IDS.SER.PARENT] = node[IDS.SER.PARENT];
            id2val.set(id, result);
            return result;
        }

        if (IDS.SER.VALUE in node) {
            let container; // pre-create container to allow cycles

            if (type === EntityType.ARRAY) container = [];
            else if (type === EntityType.OBJECT) container = {[IDS.SER.TYPE]: type};
            else container = value;

            id2val.set(id, container);

            if (type === EntityType.ARRAY) {
                for (let i = 0; i < value.length; i++) container[i] = build(value[i]);
            } else if (type === EntityType.OBJECT) {
                for (const key of Object.keys(value)) container[key] = build(value[key]);
            }

            return container;
        }

        const obj = {};
        id2val.set(id, obj);

        for (const k of Object.keys(node)) {
            if (ser_keys.has(k)) continue;
            obj[k] = build(node[k]);
        }

        return obj;
    }

    return build(json);
}

module.exports = {
    EntityType,
    jsonToAssembler,
    valueToJson,
};
