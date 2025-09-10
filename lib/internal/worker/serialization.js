'use strict';

const {IDS} = require('internal/worker/common');

const EntityType = Object.freeze({
    OBJECT: 'OBJECT',
    CLASS: 'CLASS',
    FUNCTION: 'FUNCTION',
});

function createHandle(itemId, memberId = null, type = EntityType.OBJECT, asynchronous = null) {
    return {
        [IDS.NEW.ITEM]: itemId,
        [IDS.NEW.MEMBER]: memberId,
        [IDS.NEW.TYPE]: type,
        [IDS.NEW.ASYNC]: asynchronous
    };
}

let context = null;
function setSerializationContext(threadContext) {
    context = threadContext;
}

module.exports = {
    createHandle,
    setSerializationContext,
    EntityType,
};
