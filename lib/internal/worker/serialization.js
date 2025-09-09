'use strict';

const {IDS} = require('internal/worker/common');

const EntityType = Object.freeze({
    OBJECT: 'OBJECT',
    CLASS: 'CLASS',
    FUNCTION: 'FUNCTION',
});

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
    EntityType,
};
