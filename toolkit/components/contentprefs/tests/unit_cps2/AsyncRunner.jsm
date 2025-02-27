/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

let EXPORTED_SYMBOLS = [
  "AsyncRunner",
];

const { interfaces: Ci, classes: Cc } = Components;

function AsyncRunner(callbacks) {
  this._callbacks = callbacks;
  this._iteratorQueue = [];

  // This catches errors reported to the console, e.g., via Cu.reportError.
  Cc["@mozilla.org/consoleservice;1"].
    getService(Ci.nsIConsoleService).
    registerListener(this);
}

AsyncRunner.prototype = {

  appendIterator: function AR_appendIterator(iter) {
    this._iteratorQueue.push(iter);
  },

  next: function AR_next(arg) {
    if (!this._iteratorQueue.length) {
      this.destroy();
      this._callbacks.done();
      return;
    }

    try {
      var { done, value } = this._iteratorQueue[0].next(arg);
      if (done) {
        this._iteratorQueue.shift();
        this.next();
        return;
      }
    }
    catch (err) {
      this._callbacks.error(err);
    }

    // val is truthy => call next
    // val is an iterator => prepend it to the queue and start on it
    if (value) {
      if (typeof(value) != "boolean")
        this._iteratorQueue.unshift(value);
      this.next();
    }
  },

  destroy: function AR_destroy() {
    Cc["@mozilla.org/consoleservice;1"].
      getService(Ci.nsIConsoleService).
      unregisterListener(this);
    this.destroy = function AR_alreadyDestroyed() {};
  },

  observe: function AR_consoleServiceListener(msg) {
    if (msg instanceof Ci.nsIScriptError &&
        !(msg.flags & Ci.nsIScriptError.warningFlag))
    {
      this._callbacks.consoleError(msg);
    }
  },
};
