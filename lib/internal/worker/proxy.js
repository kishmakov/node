'use strict';

const {IDS, isObject, print} = require('internal/worker/common');
const {EntityType, jsonToAssembler} = require("internal/worker/serialization_json");

// Code below goes to communication/proxy.js

// Proxy management
function commonFieldGetter(target, memberId, proxyStr) {
    assert(proxyStr, 'proxyStr must be provided');

    if (memberId === 'isProxy') return true;
    if (memberId === '__esModule') return true;
    if (memberId === 'toPrimitive' || memberId === Symbol.toPrimitive) return () => proxyStr;
}

function createGetter(port, id, target, memberId, proxyStr) {
    if (memberId in target) return target[memberId];
    let value = commonFieldGetter(target, memberId, proxyStr);

    if (value === undefined && !context.isOnHost) value = anyType(port, id + '.' + memberId);
    if (Object.isExtensible(target) && value !== undefined) target[memberId] = value;
    logToFile(`  get ${proxyStr}.'${String(memberId)}' resulted in ${print(value)}`);
    return value;
}

function createSetter(port, id, target, memberId, value, proxyStr) {
    if (target[IDS.PROXY_TAG]) anySet(port, id, memberId, value);
    target[memberId] = value;
    logToFile(`  set ${proxyStr}.'${String(memberId)}' to ${print(value)}`);
    return true;
}

function createHandler(port, id, proxyStr) {
    const blacklist = new Set([IDS.PROXY_TAG]);
    return {
        __proto__: null,
        get: (target, memberId) => createGetter(port, id, target, memberId, proxyStr),
        set: (target, memberId, value) => createSetter(port, id, target, memberId, value, proxyStr),
        ownKeys: (target) => { // Filter out IDS.PROXY_TAG from enumeration
            return Reflect.ownKeys(target).filter(key => !blacklist.has(String(key)));
        },
        getOwnPropertyDescriptor: (target, name) => {
            return Reflect.getOwnPropertyDescriptor(target, name);
        },
    };
}

function createProxyObjectNew(port, id) {
    const base = {[IDS.PROXY_TAG]: ''};
    const proxy = new Proxy(base, createHandler(port, id, `proxyObject[${id}]`));
    context.storeProxy(id, proxy);
    return proxy;
}

function createProxyObjectForId(id) {
    const result = createProxyObjectNew(context.port, id);
    result[IDS.PROXY_TAG] = id;  // sealing the proxy
    return result;
}

function createProxyFunctionNew(port, functionId, thisId, sync) {
    const fn = (...args) => anyCall(port, functionId, thisId, args, sync);

    try { // for debugging
        Object.defineProperty(fn, 'name', {value: String(functionId), configurable: true});
    } catch (e) {
    }

    return fn;
}

function createProxyClassNew(port, classId) {
    const ProxyClass = class {
        constructor(...args) {
            return anyCall(port, classId, null, args, false);
        }
    };

    try { // for debugging
        Object.defineProperty(ProxyClass, 'name', {value: String(classId), configurable: true});
    } catch (e) {
    }

    return ProxyClass;
}

function createProxyPromiseNew(port, promiseId) {
    return new Promise((resolve, reject) => {
        logToFile(`  resolves[${promiseId}] and rejects[${promiseId}] are set`);
        context.resolves.set(promiseId, resolve);
        context.rejects.set(promiseId, reject);
    });
}

function assemblerToProxy(port, id, assembler) {
    const func_types = new Set([EntityType.FUNCTION, EntityType.ASYNC_FUNCTION]);
    const val2proxy = new Map();

    function assemble(node, nodeId, parentId) {
        if (!isObject(node)) return node;
        if (val2proxy.has(node)) return val2proxy.get(node);

        if (Array.isArray(node)) {
            const result = []
            for (let i = 0; i < node.length; i++) {
                result[i] = assemble(node[i], nodeId + '.' + i, nodeId);
            }
            return result;
        }

        const {[IDS.SER.TYPE]: type} = node;

        if (func_types.has(type)) {
            const sync = (type === EntityType.FUNCTION);
            if (IDS.SER.PARENT in node) parentId = node[IDS.SER.PARENT];
            const result = createProxyFunctionNew(port, nodeId, parentId, sync);
            val2proxy.set(node, result);
            return result;
        }

        if (type === EntityType.CLASS) {
            const result = createProxyClassNew(port, nodeId);
            val2proxy.set(node, result);
            return result;
        }

        if (type === EntityType.PROMISE) {
            const promiseId = node[IDS.SER.ID];
            const result = createProxyPromiseNew(port, promiseId);
            val2proxy.set(node, result);
            return result;
        }

        if (type === EntityType.OBJECT) {
            const result = createProxyObjectNew(port, nodeId);
            val2proxy.set(node, result);
            for (const key of Object.keys(node)) {
                if (key === IDS.SER.TYPE) continue;
                result[key] = assemble(node[key], nodeId + '.' + key, nodeId);
            }
            result[IDS.PROXY_TAG] = nodeId; // sealing the proxy
            return result;
        }

        return node;
    }

    return assemble(assembler, id, null);
}

function jsonToProxy(port, id, json) {
    assert(typeof id === 'string', `jsonToProxy: input failed: got id=${id}`);
    assert(isObject(json), `jsonToProxy: input failed: got json=${JSON.stringify(json)}`);
    const assembler = jsonToAssembler(json);
    return assemblerToProxy(port, id, assembler);
}

function setupProxyFunctionality() {
    global.createProxyObjectForId = createProxyObjectForId;
    global.jsonToProxy = jsonToProxy;
}

module.exports = {
    setupProxyFunctionality,
};
