'use strict';

const {
  Date,
  Symbol,
} = primordials;

const { setUnrefTimeout } = require('internal/timers');
const { getCategoryEnabledBuffer, trace } = internalBinding('trace_events');
const {
  CHAR_UPPERCASE_B,
  CHAR_UPPERCASE_E,
} = require('internal/constants');

let utcCache;

function utcDate() {
  if (!utcCache) cache();
  return utcCache;
}

function cache() {
  const d = new Date();
  utcCache = d.toUTCString();
  setUnrefTimeout(resetCache, 1000 - d.getMilliseconds());
}

function resetCache() {
  utcCache = undefined;
}

let traceEventId = 0;

function getNextTraceEventId() {
  return ++traceEventId;
}

const httpEnabled = getCategoryEnabledBuffer('node.http');

function isTraceHTTPEnabled() {
  return httpEnabled[0] > 0;
}

const traceEventCategory = 'node,node.http';

function traceBegin(...args) {
  // See v8/src/builtins/builtins-trace.cc - must be uppercase for perfetto
  trace(CHAR_UPPERCASE_B, traceEventCategory, ...args);
}

function traceEnd(...args) {
  // See v8/src/builtins/builtins-trace.cc - must be uppercase for perfetto
  trace(CHAR_UPPERCASE_E, traceEventCategory, ...args);
}

module.exports = {
  kOutHeaders: Symbol('kOutHeaders'),
  kNeedDrain: Symbol('kNeedDrain'),
  utcDate,
  traceBegin,
  traceEnd,
  getNextTraceEventId,
  isTraceHTTPEnabled,
};
