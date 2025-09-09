'use strict';

const {
    IDS,
    EntityType,
} = require('internal/worker/context');

let context = null;

function createHandle(itemId, memberId = null, type = EntityType.OBJECT, asynchronous = null) {
    return {
        [IDS.NEW.ITEM]: itemId,
        [IDS.NEW.MEMBER]: memberId,
        [IDS.NEW.TYPE]: type,
        [IDS.NEW.ASYNC]: asynchronous
    };
}

function initSerialization(serializationContext) {
    context = serializationContext;
}

module.exports = {
    createHandle,
    initSerialization,
};
