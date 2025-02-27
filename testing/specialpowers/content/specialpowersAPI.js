/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* This code is loaded in every child process that is started by mochitest in
 * order to be used as a replacement for UniversalXPConnect
 */

"use strict";

var Ci = Components.interfaces;
var Cc = Components.classes;
var Cu = Components.utils;

Cu.import("chrome://specialpowers/content/MockFilePicker.jsm");
Cu.import("chrome://specialpowers/content/MockColorPicker.jsm");
Cu.import("chrome://specialpowers/content/MockPermissionPrompt.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/PrivateBrowsingUtils.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// We're loaded with "this" not set to the global in some cases, so we
// have to play some games to get at the global object here.  Normally
// we'd try "this" from a function called with undefined this value,
// but this whole file is in strict mode.  So instead fall back on
// returning "this" from indirect eval, which returns the global.
if (!(function() { var e = eval; return e("this"); })().File) {
    Cu.importGlobalProperties(["File"]);
}

// Allow stuff from this scope to be accessed from non-privileged scopes. This
// would crash if used outside of automation.
Cu.forcePermissiveCOWs();

function SpecialPowersAPI() {
  this._consoleListeners = [];
  this._encounteredCrashDumpFiles = [];
  this._unexpectedCrashDumpFiles = { };
  this._crashDumpDir = null;
  this._mfl = null;
  this._prefEnvUndoStack = [];
  this._pendingPrefs = [];
  this._applyingPrefs = false;
  this._permissionsUndoStack = [];
  this._pendingPermissions = [];
  this._applyingPermissions = false;
  this._observingPermissions = false;
  this._fm = null;
  this._cb = null;
}

function bindDOMWindowUtils(aWindow) {
  if (!aWindow)
    return

   var util = aWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIDOMWindowUtils);
   return wrapPrivileged(util);
}

function getRawComponents(aWindow) {
  // If we're running in automation that supports enablePrivilege, then we also
  // provided access to the privileged Components.
  try {
    let win = Cu.waiveXrays(aWindow);
    if (typeof win.netscape.security.PrivilegeManager == 'object')
      Cu.forcePrivilegedComponentsForScope(aWindow);
  } catch (e) {}
  return Cu.getComponentsForScope(aWindow);
}

function isWrappable(x) {
  if (typeof x === "object")
    return x !== null;
  return typeof x === "function";
};

function isWrapper(x) {
  return isWrappable(x) && (typeof x.SpecialPowers_wrappedObject !== "undefined");
};

function unwrapIfWrapped(x) {
  return isWrapper(x) ? unwrapPrivileged(x) : x;
};

function wrapIfUnwrapped(x) {
  return isWrapper(x) ? x : wrapPrivileged(x);
}

function isObjectOrArray(obj) {
  if (Object(obj) !== obj)
    return false;
  let arrayClasses = ['Object', 'Array', 'Int8Array', 'Uint8Array',
                      'Int16Array', 'Uint16Array', 'Int32Array',
                      'Uint32Array', 'Float32Array', 'Float64Array',
                      'Uint8ClampedArray'];
  let className = Cu.getClassName(obj, true);
  return arrayClasses.indexOf(className) != -1;
}

// In general, we want Xray wrappers for content DOM objects, because waiving
// Xray gives us Xray waiver wrappers that clamp the principal when we cross
// compartment boundaries. However, there are some exceptions where we want
// to use a waiver:
//
// * Xray adds some gunk to toString(), which has the potential to confuse
//   consumers that aren't expecting Xray wrappers. Since toString() is a
//   non-privileged method that returns only strings, we can just waive Xray
//   for that case.
//
// * We implement Xrays to pure JS [[Object]] and [[Array]] instances that
//   filter out tricky things like callables. This is the right thing for
//   security in general, but tends to break tests that try to pass object
//   literals into SpecialPowers. So we waive [[Object]] and [[Array]]
//   instances before inspecting properties.
//
// * When we don't have meaningful Xray semantics, we create an Opaque
//   XrayWrapper for security reasons. For test code, we generally want to see
//   through that sort of thing.
function waiveXraysIfAppropriate(obj, propName) {
  if (propName == 'toString' || isObjectOrArray(obj) ||
      /Opaque/.test(Object.prototype.toString.call(obj)))
{
    return XPCNativeWrapper.unwrap(obj);
}
  return obj;
}

// We can't call apply() directy on Xray-wrapped functions, so we have to be
// clever.
function doApply(fun, invocant, args) {
  // We implement Xrays to pure JS [[Object]] instances that filter out tricky
  // things like callables. This is the right thing for security in general,
  // but tends to break tests that try to pass object literals into
  // SpecialPowers. So we waive [[Object]] instances when they're passed to a
  // SpecialPowers-wrapped callable.
  //
  // Note that the transitive nature of Xray waivers means that any property
  // pulled off such an object will also be waived, and so we'll get principal
  // clamping for Xrayed DOM objects reached from literals, so passing things
  // like {l : xoWin.location} won't work. Hopefully the rabbit hole doesn't
  // go that deep.
  args = args.map(x => isObjectOrArray(x) ? Cu.waiveXrays(x) : x);
  return Reflect.apply(fun, invocant, args);
}

function wrapPrivileged(obj) {

  // Primitives pass straight through.
  if (!isWrappable(obj))
    return obj;

  // No double wrapping.
  if (isWrapper(obj))
    throw "Trying to double-wrap object!";

  let dummy;
  if (typeof obj === "function")
    dummy = function() {};
  else
    dummy = Object.create(null);

  return new Proxy(dummy, new SpecialPowersHandler(obj));
};

function unwrapPrivileged(x) {

  // We don't wrap primitives, so sometimes we have a primitive where we'd
  // expect to have a wrapper. The proxy pretends to be the type that it's
  // emulating, so we can just as easily check isWrappable() on a proxy as
  // we can on an unwrapped object.
  if (!isWrappable(x))
    return x;

  // If we have a wrappable type, make sure it's wrapped.
  if (!isWrapper(x))
    throw "Trying to unwrap a non-wrapped object!";

  var obj = x.SpecialPowers_wrappedObject;
  // unwrapped.
  return obj;
};

function SpecialPowersHandler(wrappedObject) {
  this.wrappedObject = wrappedObject;
}

SpecialPowersHandler.prototype = {
  construct(target, args) {
    // The arguments may or may not be wrappers. Unwrap them if necessary.
    var unwrappedArgs = Array.prototype.slice.call(args).map(unwrapIfWrapped);

    // We want to invoke "obj" as a constructor, but using unwrappedArgs as
    // the arguments.  Make sure to wrap and re-throw exceptions!
    try {
      return wrapIfUnwrapped(Reflect.construct(this.wrappedObject, unwrappedArgs));
    } catch (e) {
      throw wrapIfUnwrapped(e);
    }
  },

  apply(target, thisValue, args) {
    // The invocant and arguments may or may not be wrappers. Unwrap
    // them if necessary.
    var invocant = unwrapIfWrapped(thisValue);
    var unwrappedArgs = Array.prototype.slice.call(args).map(unwrapIfWrapped);

    try {
      return wrapIfUnwrapped(doApply(this.wrappedObject, invocant, unwrappedArgs));
    } catch (e) {
      // Wrap exceptions and re-throw them.
      throw wrapIfUnwrapped(e);
    }
  },

  has(target, prop) {
    if (prop === "SpecialPowers_wrappedObject")
      return true;

    return Reflect.has(this.wrappedObject, prop);
  },

  get(target, prop, receiver) {
    if (prop === "SpecialPowers_wrappedObject")
      return this.wrappedObject;

    let obj = waiveXraysIfAppropriate(this.wrappedObject, prop);
    return wrapIfUnwrapped(Reflect.get(obj, prop));
  },

  set(target, prop, val, receiver) {
    if (prop === "SpecialPowers_wrappedObject")
      return false;

    let obj = waiveXraysIfAppropriate(this.wrappedObject, prop);
    return Reflect.set(obj, prop, unwrapIfWrapped(val));
  },

  delete(target, prop) {
    if (prop === "SpecialPowers_wrappedObject")
      return false;

    return Reflect.deleteProperty(this.wrappedObject, prop);
  },

  defineProperty(target, prop, descriptor) {
    throw "Can't call defineProperty on SpecialPowers wrapped object";
  },

  getOwnPropertyDescriptor(target, prop) {
    // Handle our special API.
    if (prop === "SpecialPowers_wrappedObject") {
      return { value: this.wrappedObject, writeable: true,
               configurable: true, enumerable: false };
    }

    let obj = waiveXraysIfAppropriate(this.wrappedObject, prop);
    let desc = Reflect.getOwnPropertyDescriptor(obj, prop);

    if (desc === undefined)
      return undefined;

    // Transitively maintain the wrapper membrane.
    function wrapIfExists(key) {
      if (key in desc)
        desc[key] = wrapIfUnwrapped(desc[key]);
    };

    wrapIfExists('value');
    wrapIfExists('get');
    wrapIfExists('set');

    // A trapping proxy's properties must always be configurable, but sometimes
    // we come across non-configurable properties. Tell a white lie.
    desc.configurable = true;

    return desc;
  },

  ownKeys(target) {
    // Insert our special API. It's not enumerable, but ownKeys()
    // includes non-enumerable properties.
    let props = ['SpecialPowers_wrappedObject'];

    // Do the normal thing.
    let flt = (a) => !props.includes(a);
    props = props.concat(Reflect.ownKeys(this.wrappedObject).filter(flt));

    // If we've got an Xray wrapper, include the expandos as well.
    if ('wrappedJSObject' in this.wrappedObject) {
      props = props.concat(Reflect.ownKeys(this.wrappedObject.wrappedJSObject)
                           .filter(flt));
    }

    return props;
  },

  preventExtensions(target) {
    throw "Can't call preventExtensions on SpecialPowers wrapped object";
  }
};

// SPConsoleListener reflects nsIConsoleMessage objects into JS in a
// tidy, XPCOM-hiding way.  Messages that are nsIScriptError objects
// have their properties exposed in detail.  It also auto-unregisters
// itself when it receives a "sentinel" message.
function SPConsoleListener(callback) {
  this.callback = callback;
}

SPConsoleListener.prototype = {
  observe: function(msg) {
    let m = { message: msg.message,
              errorMessage: null,
              sourceName: null,
              sourceLine: null,
              lineNumber: null,
              columnNumber: null,
              category: null,
              windowID: null,
              isScriptError: false,
              isWarning: false,
              isException: false,
              isStrict: false };
    if (msg instanceof Ci.nsIScriptError) {
      m.errorMessage  = msg.errorMessage;
      m.sourceName    = msg.sourceName;
      m.sourceLine    = msg.sourceLine;
      m.lineNumber    = msg.lineNumber;
      m.columnNumber  = msg.columnNumber;
      m.category      = msg.category;
      m.windowID      = msg.outerWindowID;
      m.isScriptError = true;
      m.isWarning     = ((msg.flags & Ci.nsIScriptError.warningFlag) === 1);
      m.isException   = ((msg.flags & Ci.nsIScriptError.exceptionFlag) === 1);
      m.isStrict      = ((msg.flags & Ci.nsIScriptError.strictFlag) === 1);
    }

    Object.freeze(m);

    this.callback.call(undefined, m);

    if (!m.isScriptError && m.message === "SENTINEL")
      Services.console.unregisterListener(this);
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIConsoleListener])
};

function wrapCallback(cb) {
  return function SpecialPowersCallbackWrapper() {
    var args = Array.prototype.map.call(arguments, wrapIfUnwrapped);
    return cb.apply(this, args);
  }
}

function wrapCallbackObject(obj) {
  obj = Cu.waiveXrays(obj);
  var wrapper = {};
  for (var i in obj) {
    if (typeof obj[i] == 'function')
      wrapper[i] = wrapCallback(obj[i]);
    else
      wrapper[i] = obj[i];
  }
  return wrapper;
}

function setWrapped(obj, prop, val) {
  if (!isWrapper(obj))
    throw "You only need to use this for SpecialPowers wrapped objects";

  obj = unwrapPrivileged(obj);
  return Reflect.set(obj, prop, val);
}

SpecialPowersAPI.prototype = {

  /*
   * Privileged object wrapping API
   *
   * Usage:
   *   var wrapper = SpecialPowers.wrap(obj);
   *   wrapper.privilegedMethod(); wrapper.privilegedProperty;
   *   obj === SpecialPowers.unwrap(wrapper);
   *
   * These functions provide transparent access to privileged objects using
   * various pieces of deep SpiderMagic. Conceptually, a wrapper is just an
   * object containing a reference to the underlying object, where all method
   * calls and property accesses are transparently performed with the System
   * Principal. Moreover, objects obtained from the wrapper (including properties
   * and method return values) are wrapped automatically. Thus, after a single
   * call to SpecialPowers.wrap(), the wrapper layer is transitively maintained.
   *
   * Known Issues:
   *
   *  - The wrapping function does not preserve identity, so
   *    SpecialPowers.wrap(foo) !== SpecialPowers.wrap(foo). See bug 718543.
   *
   *  - The wrapper cannot see expando properties on unprivileged DOM objects.
   *    That is to say, the wrapper uses Xray delegation.
   *
   *  - The wrapper sometimes guesses certain ES5 attributes for returned
   *    properties. This is explained in a comment in the wrapper code above,
   *    and shouldn't be a problem.
   */
  wrap: wrapIfUnwrapped,
  unwrap: unwrapIfWrapped,
  isWrapper: isWrapper,

  /*
   * When content needs to pass a callback or a callback object to an API
   * accessed over SpecialPowers, that API may sometimes receive arguments for
   * whom it is forbidden to create a wrapper in content scopes. As such, we
   * need a layer to wrap the values in SpecialPowers wrappers before they ever
   * reach content.
   */
  wrapCallback: wrapCallback,
  wrapCallbackObject: wrapCallbackObject,

  /*
   * Used for assigning a property to a SpecialPowers wrapper, without unwrapping
   * the value that is assigned.
   */
  setWrapped: setWrapped,

  /*
   * Create blank privileged objects to use as out-params for privileged functions.
   */
  createBlankObject: function () {
    return new Object;
  },

  /*
   * Because SpecialPowers wrappers don't preserve identity, comparing with ==
   * can be hazardous. Sometimes we can just unwrap to compare, but sometimes
   * wrapping the underlying object into a content scope is forbidden. This
   * function strips any wrappers if they exist and compare the underlying
   * values.
   */
  compare: function(a, b) {
    return unwrapIfWrapped(a) === unwrapIfWrapped(b);
  },

  get MockFilePicker() {
    return MockFilePicker;
  },

  get MockColorPicker() {
    return MockColorPicker;
  },

  get MockPermissionPrompt() {
    return MockPermissionPrompt;
  },

  loadChromeScript: function (url) {
    // Create a unique id for this chrome script
    let uuidGenerator = Cc["@mozilla.org/uuid-generator;1"]
                          .getService(Ci.nsIUUIDGenerator);
    let id = uuidGenerator.generateUUID().toString();

    // Tells chrome code to evaluate this chrome script
    this._sendSyncMessage("SPLoadChromeScript",
                          { url: url, id: id });

    // Returns a MessageManager like API in order to be
    // able to communicate with this chrome script
    let listeners = [];
    let chromeScript = {
      addMessageListener: (name, listener) => {
        listeners.push({ name: name, listener: listener });
      },

      removeMessageListener: (name, listener) => {
        listeners = listeners.filter(
          o => (o.name != name || o.listener != listener)
        );
      },

      sendAsyncMessage: (name, message) => {
        this._sendSyncMessage("SPChromeScriptMessage",
                              { id: id, name: name, message: message });
      },

      destroy: () => {
        listeners = [];
        this._removeMessageListener("SPChromeScriptMessage", chromeScript);
        this._removeMessageListener("SPChromeScriptAssert", chromeScript);
      },

      receiveMessage: (aMessage) => {
        let messageId = aMessage.json.id;
        let name = aMessage.json.name;
        let message = aMessage.json.message;
        // Ignore message from other chrome script
        if (messageId != id)
          return;

        if (aMessage.name == "SPChromeScriptMessage") {
          listeners.filter(o => (o.name == name))
                   .forEach(o => o.listener(message));
        } else if (aMessage.name == "SPChromeScriptAssert") {
          assert(aMessage.json);
        }
      }
    };
    this._addMessageListener("SPChromeScriptMessage", chromeScript);
    this._addMessageListener("SPChromeScriptAssert", chromeScript);

    let assert = json => {
      // An assertion has been done in a mochitest chrome script
      let {url, err, message, stack} = json;

      // Try to fetch a test runner from the mochitest
      // in order to properly log these assertions and notify
      // all usefull log observers
      let window = this.window.get();
      let parentRunner, repr = o => o;
      if (window) {
        window = window.wrappedJSObject;
        parentRunner = window.TestRunner;
        if (window.repr) {
          repr = window.repr;
        }
      }

      // Craft a mochitest-like report string
      var resultString = err ? "TEST-UNEXPECTED-FAIL" : "TEST-PASS";
      var diagnostic =
        message ? message :
                  ("assertion @ " + stack.filename + ":" + stack.lineNumber);
      if (err) {
        diagnostic +=
          " - got " + repr(err.actual) +
          ", expected " + repr(err.expected) +
          " (operator " + err.operator + ")";
      }
      var msg = [resultString, url, diagnostic].join(" | ");
      if (parentRunner) {
        if (err) {
          parentRunner.addFailedTest(url);
          parentRunner.error(msg);
        } else {
          parentRunner.log(msg);
        }
      } else {
        // When we are running only a single mochitest, there is no test runner
        dump(msg + "\n");
      }
    };

    return this.wrap(chromeScript);
  },

  get Services() {
    return wrapPrivileged(Services);
  },

  /*
   * In general, any Components object created for unprivileged scopes is
   * neutered (it implements nsIXPCComponentsBase, but not nsIXPCComponents).
   * We override this in certain legacy automation configurations (see the
   * implementation of getRawComponents() above), but don't want to support
   * it in cases where it isn't already required.
   *
   * In scopes with neutered Components, we don't have a natural referent for
   * things like SpecialPowers.Cc. So in those cases, we fall back to the
   * Components object from the SpecialPowers scope. This doesn't quite behave
   * the same way (in particular, SpecialPowers.Cc[foo].createInstance() will
   * create an instance in the SpecialPowers scope), but SpecialPowers wrapping
   * is already a YMMV / Whatever-It-Takes-To-Get-TBPL-Green sort of thing.
   *
   * It probably wouldn't be too much work to just make SpecialPowers.Components
   * unconditionally point to the Components object in the SpecialPowers scope.
   * Try will tell what needs to be fixed up.
   */
  getFullComponents: function() {
    return typeof this.Components.classes == 'object' ? this.Components
                                                      : Components;
  },

  /*
   * Convenient shortcuts to the standard Components abbreviations. Note that
   * we don't SpecialPowers-wrap Components.interfaces, because it's available
   * to untrusted content, and wrapping it confuses QI and identity checks.
   */
  get Cc() { return wrapPrivileged(this.getFullComponents().classes); },
  get Ci() { return this.Components.interfaces; },
  get Cu() { return wrapPrivileged(this.getFullComponents().utils); },
  get Cr() { return wrapPrivileged(this.Components.results); },

  /*
   * SpecialPowers.getRawComponents() allows content to get a reference to a
   * naked (and, in certain automation configurations, privileged) Components
   * object for its scope.
   *
   * SpecialPowers.getRawComponents(window) is defined as the global property
   * window.SpecialPowers.Components for convenience.
   */
  getRawComponents: getRawComponents,

  getDOMWindowUtils: function(aWindow) {
    if (aWindow == this.window.get() && this.DOMWindowUtils != null)
      return this.DOMWindowUtils;

    return bindDOMWindowUtils(aWindow);
  },

  removeExpectedCrashDumpFiles: function(aExpectingProcessCrash) {
    var success = true;
    if (aExpectingProcessCrash) {
      var message = {
        op: "delete-crash-dump-files",
        filenames: this._encounteredCrashDumpFiles
      };
      if (!this._sendSyncMessage("SPProcessCrashService", message)[0]) {
        success = false;
      }
    }
    this._encounteredCrashDumpFiles.length = 0;
    return success;
  },

  findUnexpectedCrashDumpFiles: function() {
    var self = this;
    var message = {
      op: "find-crash-dump-files",
      crashDumpFilesToIgnore: this._unexpectedCrashDumpFiles
    };
    var crashDumpFiles = this._sendSyncMessage("SPProcessCrashService", message)[0];
    crashDumpFiles.forEach(function(aFilename) {
      self._unexpectedCrashDumpFiles[aFilename] = true;
    });
    return crashDumpFiles;
  },

  _setTimeout: function(callback) {
    // for mochitest-browser
    if (typeof window != 'undefined')
      setTimeout(callback, 0);
    // for mochitest-plain
    else
      content.window.setTimeout(callback, 0);
  },

  _delayCallbackTwice: function(callback) {
     function delayedCallback() {
       function delayAgain(aCallback) {
         // Using this._setTimeout doesn't work here
         // It causes failures in mochtests that use
         // multiple pushPrefEnv calls
         // For chrome/browser-chrome mochitests
         if (typeof window != 'undefined')
           setTimeout(aCallback, 0);
         // For mochitest-plain
         else
           content.window.setTimeout(aCallback, 0);
       }
       delayAgain(delayAgain(callback));
     }
     return delayedCallback;
  },

  /* apply permissions to the system and when the test case is finished (SimpleTest.finish())
     we will revert the permission back to the original.

     inPermissions is an array of objects where each object has a type, action, context, ex:
     [{'type': 'SystemXHR', 'allow': 1, 'context': document}, 
      {'type': 'SystemXHR', 'allow': Ci.nsIPermissionManager.PROMPT_ACTION, 'context': document}]

     Allow can be a boolean value of true/false or ALLOW_ACTION/DENY_ACTION/PROMPT_ACTION/UNKNOWN_ACTION
  */
  pushPermissions: function(inPermissions, callback) {
    inPermissions = Cu.waiveXrays(inPermissions);
    var pendingPermissions = [];
    var cleanupPermissions = [];

    for (var p in inPermissions) {
        var permission = inPermissions[p];
        var originalValue = Ci.nsIPermissionManager.UNKNOWN_ACTION;
        var context = Cu.unwaiveXrays(permission.context); // Sometimes |context| is a DOM object on which we expect
                                                           // to be able to access .nodePrincipal, so we need to unwaive.
        if (this.testPermission(permission.type, Ci.nsIPermissionManager.ALLOW_ACTION, context)) {
          originalValue = Ci.nsIPermissionManager.ALLOW_ACTION;
        } else if (this.testPermission(permission.type, Ci.nsIPermissionManager.DENY_ACTION, context)) {
          originalValue = Ci.nsIPermissionManager.DENY_ACTION;
        } else if (this.testPermission(permission.type, Ci.nsIPermissionManager.PROMPT_ACTION, context)) {
          originalValue = Ci.nsIPermissionManager.PROMPT_ACTION;
        } else if (this.testPermission(permission.type, Ci.nsICookiePermission.ACCESS_SESSION, context)) {
          originalValue = Ci.nsICookiePermission.ACCESS_SESSION;
        } else if (this.testPermission(permission.type, Ci.nsICookiePermission.ACCESS_ALLOW_FIRST_PARTY_ONLY, context)) {
          originalValue = Ci.nsICookiePermission.ACCESS_ALLOW_FIRST_PARTY_ONLY;
        } else if (this.testPermission(permission.type, Ci.nsICookiePermission.ACCESS_LIMIT_THIRD_PARTY, context)) {
          originalValue = Ci.nsICookiePermission.ACCESS_LIMIT_THIRD_PARTY;
        }

        let principal = this._getPrincipalFromArg(context);
        if (principal.isSystemPrincipal) {
          continue;
        }

        let perm;
        if (typeof permission.allow !== 'boolean') {
          perm = permission.allow;
        } else {
          perm = permission.allow ? Ci.nsIPermissionManager.ALLOW_ACTION
                             : Ci.nsIPermissionManager.DENY_ACTION;
        }

        if (permission.remove == true)
          perm = Ci.nsIPermissionManager.UNKNOWN_ACTION;

        if (originalValue == perm) {
          continue;
        }

        var todo = {'op': 'add',
                    'type': permission.type,
                    'permission': perm,
                    'value': perm,
                    'principal': principal,
                    'expireType': (typeof permission.expireType === "number") ?
                      permission.expireType : 0, // default: EXPIRE_NEVER
                    'expireTime': (typeof permission.expireTime === "number") ?
                      permission.expireTime : 0};

        var cleanupTodo = Object.assign({}, todo);

        if (permission.remove == true)
          todo.op = 'remove';

        pendingPermissions.push(todo);

        /* Push original permissions value or clear into cleanup array */
        if (originalValue == Ci.nsIPermissionManager.UNKNOWN_ACTION) {
          cleanupTodo.op = 'remove';
        } else {
          cleanupTodo.value = originalValue;
          cleanupTodo.permission = originalValue;
        }
        cleanupPermissions.push(cleanupTodo);
    }

    if (pendingPermissions.length > 0) {
      // The callback needs to be delayed twice. One delay is because the pref
      // service doesn't guarantee the order it calls its observers in, so it
      // may notify the observer holding the callback before the other
      // observers have been notified and given a chance to make the changes
      // that the callback checks for. The second delay is because pref
      // observers often defer making their changes by posting an event to the
      // event loop.
      if (!this._observingPermissions) {
        this._observingPermissions = true;
        // If specialpowers is in main-process, then we can add a observer
        // to get all 'perm-changed' signals. Otherwise, it can't receive
        // all signals, so we register a observer in specialpowersobserver(in
        // main-process) and get signals from it.
        if (this.isMainProcess()) {
          this.permissionObserverProxy._specialPowersAPI = this;
          Services.obs.addObserver(this.permissionObserverProxy, "perm-changed", false);
        } else {
          this.registerObservers("perm-changed");
          // bind() is used to set 'this' to SpecialPowersAPI itself.
          this._addMessageListener("specialpowers-perm-changed", this.permChangedProxy.bind(this));
        }
      }
      this._permissionsUndoStack.push(cleanupPermissions);
      this._pendingPermissions.push([pendingPermissions,
                                     this._delayCallbackTwice(callback)]);
      this._applyPermissions();
    } else {
      this._setTimeout(callback);
    }
  },

  /*
   * This function should be used when specialpowers is in content process but
   * it want to get the notification from chrome space.
   *
   * This function will call Services.obs.addObserver in SpecialPowersObserver
   * (that is in chrome process) and forward the data received to SpecialPowers
   * via messageManager.
   * You can use this._addMessageListener("specialpowers-YOUR_TOPIC") to fire
   * the callback.
   *
   * To get the expected data, you should modify
   * SpecialPowersObserver.prototype._registerObservers.observe. Or the message
   * you received from messageManager will only contain 'aData' from Service.obs.
   *
   * NOTICE: there is no implementation of _addMessageListener in
   * ChromePowers.js
   */
  registerObservers: function(topic) {
    var msg = {
      'op': 'add',
      'observerTopic': topic,
    };
    this._sendSyncMessage("SPObserverService", msg);
  },

  permChangedProxy: function(aMessage) {
    let permission = aMessage.json.permission;
    let aData = aMessage.json.aData;
    this._permissionObserver.observe(permission, aData);
  },

  permissionObserverProxy: {
    // 'this' in permChangedObserverProxy is the permChangedObserverProxy
    // object itself. The '_specialPowersAPI' will be set to the 'SpecialPowersAPI'
    // object to call the member function in SpecialPowersAPI.
    _specialPowersAPI: null,
    observe: function (aSubject, aTopic, aData)
    {
      if (aTopic == "perm-changed") {
        var permission = aSubject.QueryInterface(Ci.nsIPermission);
        this._specialPowersAPI._permissionObserver.observe(permission, aData);
      }
    }
  },

  popPermissions: function(callback) {
    if (this._permissionsUndoStack.length > 0) {
      // See pushPermissions comment regarding delay.
      let cb = callback ? this._delayCallbackTwice(callback) : null;
      /* Each pop from the stack will yield an object {op/type/permission/value/url/appid/isInBrowserElement} or null */
      this._pendingPermissions.push([this._permissionsUndoStack.pop(), cb]);
      this._applyPermissions();
    } else {
      if (this._observingPermissions) {
        this._observingPermissions = false;
        this._removeMessageListener("specialpowers-perm-changed", this.permChangedProxy.bind(this));
      }
      this._setTimeout(callback);
    }
  },

  flushPermissions: function(callback) {
    while (this._permissionsUndoStack.length > 1)
      this.popPermissions(null);

    this.popPermissions(callback);
  },


  setTestPluginEnabledState: function(newEnabledState, pluginName) {
    return this._sendSyncMessage("SPSetTestPluginEnabledState",
                                 { newEnabledState: newEnabledState, pluginName: pluginName })[0];
  },


  _permissionObserver: {
    _self: null,
    _lastPermission: {},
    _callBack: null,
    _nextCallback: null,
    _obsDataMap: {
      'deleted':'remove',
      'added':'add'
    },
    observe: function (permission, aData)
    {
      if (this._self._applyingPermissions) {
        if (permission.type == this._lastPermission.type) {
          this._self._setTimeout(this._callback);
          this._self._setTimeout(this._nextCallback);
          this._callback = null;
          this._nextCallback = null;
        }
      } else {
        var found = false;
        for (var i = 0; !found && i < this._self._permissionsUndoStack.length; i++) {
          var undos = this._self._permissionsUndoStack[i];
          for (var j = 0; j < undos.length; j++) {
            var undo = undos[j];
            if (undo.op == this._obsDataMap[aData] &&
                undo.principal.originAttributes.appId == permission.principal.originAttributes.appId &&
                undo.type == permission.type) {
              // Remove this undo item if it has been done by others(not
              // specialpowers itself.)
              undos.splice(j,1);
              found = true;
              break;
            }
          }
          if (!undos.length) {
            // Remove the empty row in permissionsUndoStack
            this._self._permissionsUndoStack.splice(i, 1);
          }
        }
      }
    }
  },

  /*
    Iterate through one atomic set of permissions actions and perform allow/deny as appropriate.
    All actions performed must modify the relevant permission.
  */
  _applyPermissions: function() {
    if (this._applyingPermissions || this._pendingPermissions.length <= 0) {
      return;
    }

    /* Set lock and get prefs from the _pendingPrefs queue */
    this._applyingPermissions = true;
    var transaction = this._pendingPermissions.shift();
    var pendingActions = transaction[0];
    var callback = transaction[1];
    var lastPermission = pendingActions[pendingActions.length-1];

    var self = this;
    this._permissionObserver._self = self;
    this._permissionObserver._lastPermission = lastPermission;
    this._permissionObserver._callback = callback;
    this._permissionObserver._nextCallback = function () {
        self._applyingPermissions = false;
        // Now apply any permissions that may have been queued while we were applying
        self._applyPermissions();
    }

    for (var idx in pendingActions) {
      var perm = pendingActions[idx];
      this._sendSyncMessage('SPPermissionManager', perm)[0];
    }
  },

  /*
   * Take in a list of pref changes to make, and invoke |callback| once those
   * changes have taken effect.  When the test finishes, these changes are
   * reverted.
   *
   * |inPrefs| must be an object with up to two properties: "set" and "clear".
   * pushPrefEnv will set prefs as indicated in |inPrefs.set| and will unset
   * the prefs indicated in |inPrefs.clear|.
   *
   * For example, you might pass |inPrefs| as:
   *
   *  inPrefs = {'set': [['foo.bar', 2], ['magic.pref', 'baz']],
   *             'clear': [['clear.this'], ['also.this']] };
   *
   * Notice that |set| and |clear| are both an array of arrays.  In |set|, each
   * of the inner arrays must have the form [pref_name, value] or [pref_name,
   * value, iid].  (The latter form is used for prefs with "complex" values.)
   *
   * In |clear|, each inner array should have the form [pref_name].
   *
   * If you set the same pref more than once (or both set and clear a pref),
   * the behavior of this method is undefined.
   *
   * (Implementation note: _prefEnvUndoStack is a stack of values to revert to,
   * not values which have been set!)
   *
   * TODO: complex values for original cleanup?
   *
   */
  pushPrefEnv: function(inPrefs, callback) {
    var prefs = Services.prefs;

    var pref_string = [];
    pref_string[prefs.PREF_INT] = "INT";
    pref_string[prefs.PREF_BOOL] = "BOOL";
    pref_string[prefs.PREF_STRING] = "CHAR";

    var pendingActions = [];
    var cleanupActions = [];

    for (var action in inPrefs) { /* set|clear */
      for (var idx in inPrefs[action]) {
        var aPref = inPrefs[action][idx];
        var prefName = aPref[0];
        var prefValue = null;
        var prefIid = null;
        var prefType = prefs.PREF_INVALID;
        var originalValue = null;

        if (aPref.length == 3) {
          prefValue = aPref[1];
          prefIid = aPref[2];
        } else if (aPref.length == 2) {
          prefValue = aPref[1];
        }

        /* If pref is not found or invalid it doesn't exist. */
        if (prefs.getPrefType(prefName) != prefs.PREF_INVALID) {
          prefType = pref_string[prefs.getPrefType(prefName)];
          if ((prefs.prefHasUserValue(prefName) && action == 'clear') ||
              (action == 'set'))
            originalValue = this._getPref(prefName, prefType);
        } else if (action == 'set') {
          /* prefName doesn't exist, so 'clear' is pointless */
          if (aPref.length == 3) {
            prefType = "COMPLEX";
          } else if (aPref.length == 2) {
            if (typeof(prefValue) == "boolean")
              prefType = "BOOL";
            else if (typeof(prefValue) == "number")
              prefType = "INT";
            else if (typeof(prefValue) == "string")
              prefType = "CHAR";
          }
        }

        /* PREF_INVALID: A non existing pref which we are clearing or invalid values for a set */
        if (prefType == prefs.PREF_INVALID)
          continue;

        /* We are not going to set a pref if the value is the same */
        if (originalValue == prefValue)
          continue;

        pendingActions.push({'action': action, 'type': prefType, 'name': prefName, 'value': prefValue, 'Iid': prefIid});

        /* Push original preference value or clear into cleanup array */
        var cleanupTodo = {'action': action, 'type': prefType, 'name': prefName, 'value': originalValue, 'Iid': prefIid};
        if (originalValue == null) {
          cleanupTodo.action = 'clear';
        } else {
          cleanupTodo.action = 'set';
        }
        cleanupActions.push(cleanupTodo);
      }
    }

    if (pendingActions.length > 0) {
      // The callback needs to be delayed twice. One delay is because the pref
      // service doesn't guarantee the order it calls its observers in, so it
      // may notify the observer holding the callback before the other
      // observers have been notified and given a chance to make the changes
      // that the callback checks for. The second delay is because pref
      // observers often defer making their changes by posting an event to the
      // event loop.
      this._prefEnvUndoStack.push(cleanupActions);
      this._pendingPrefs.push([pendingActions,
                               this._delayCallbackTwice(callback)]);
      this._applyPrefs();
    } else {
      this._setTimeout(callback);
    }
  },

  popPrefEnv: function(callback) {
    if (this._prefEnvUndoStack.length > 0) {
      // See pushPrefEnv comment regarding delay.
      let cb = callback ? this._delayCallbackTwice(callback) : null;
      /* Each pop will have a valid block of preferences */
      this._pendingPrefs.push([this._prefEnvUndoStack.pop(), cb]);
      this._applyPrefs();
    } else {
      this._setTimeout(callback);
    }
  },

  flushPrefEnv: function(callback) {
    while (this._prefEnvUndoStack.length > 1)
      this.popPrefEnv(null);

    this.popPrefEnv(callback);
  },

  /*
    Iterate through one atomic set of pref actions and perform sets/clears as appropriate.
    All actions performed must modify the relevant pref.
  */
  _applyPrefs: function() {
    if (this._applyingPrefs || this._pendingPrefs.length <= 0) {
      return;
    }

    /* Set lock and get prefs from the _pendingPrefs queue */
    this._applyingPrefs = true;
    var transaction = this._pendingPrefs.shift();
    var pendingActions = transaction[0];
    var callback = transaction[1];

    var lastPref = pendingActions[pendingActions.length-1];

    var pb = Services.prefs;
    var self = this;
    pb.addObserver(lastPref.name, function prefObs(subject, topic, data) {
      pb.removeObserver(lastPref.name, prefObs);

      self._setTimeout(callback);
      self._setTimeout(function () {
        self._applyingPrefs = false;
        // Now apply any prefs that may have been queued while we were applying
        self._applyPrefs();
      });
    }, false);

    for (var idx in pendingActions) {
      var pref = pendingActions[idx];
      if (pref.action == 'set') {
        this._setPref(pref.name, pref.type, pref.value, pref.Iid);
      } else if (pref.action == 'clear') {
        this.clearUserPref(pref.name);
      }
    }
  },

  // Disables the app install prompt for the duration of this test. There is
  // no need to re-enable the prompt at the end of the test.
  //
  // The provided callback is invoked once the prompt is disabled.
  autoConfirmAppInstall: function(cb) {
    this.pushPrefEnv({set: [['dom.mozApps.auto_confirm_install', true]]}, cb);
  },

  autoConfirmAppUninstall: function(cb) {
    this.pushPrefEnv({set: [['dom.mozApps.auto_confirm_uninstall', true]]}, cb);
  },

  // Allow tests to disable the per platform app validity checks so we can
  // test higher level WebApp functionality without full platform support.
  setAllAppsLaunchable: function(launchable) {
    this._sendSyncMessage("SPWebAppService", {
      op: "set-launchable",
      launchable: launchable
    });
  },

  // Allow tests to install addons without signing the package, for convenience.
  allowUnsignedAddons: function() {
    this._sendSyncMessage("SPWebAppService", {
      op: "allow-unsigned-addons"
    });
  },

  // Turn on debug information from UserCustomizations.jsm
  debugUserCustomizations: function(value) {
    this._sendSyncMessage("SPWebAppService", {
      op: "debug-customizations",
      value: value
    });
  },

  // Restore the launchable property to its default value.
  flushAllAppsLaunchable: function() {
    this._sendSyncMessage("SPWebAppService", {
      op: "set-launchable",
      launchable: false
    });
  },

  // Force-registering an app in the registry
  injectApp: function(aAppId, aApp) {
    this._sendSyncMessage("SPWebAppService", {
      op: "inject-app",
      appId: aAppId,
      app: aApp
    });
  },

  // Removing app from the registry
  rejectApp: function(aAppId) {
    this._sendSyncMessage("SPWebAppService", {
      op: "reject-app",
      appId: aAppId
    });
  },

  _proxiedObservers: {
    "specialpowers-http-notify-request": function(aMessage) {
      let uri = aMessage.json.uri;
      Services.obs.notifyObservers(null, "specialpowers-http-notify-request", uri);
    },
  },

  _addObserverProxy: function(notification) {
    if (notification in this._proxiedObservers) {
      this._addMessageListener(notification, this._proxiedObservers[notification]);
    }
  },

  _removeObserverProxy: function(notification) {
    if (notification in this._proxiedObservers) {
      this._removeMessageListener(notification, this._proxiedObservers[notification]);
    }
  },

  addObserver: function(obs, notification, weak) {
    this._addObserverProxy(notification);
    obs = Cu.waiveXrays(obs);
    if (typeof obs == 'object' && obs.observe.name != 'SpecialPowersCallbackWrapper')
      obs.observe = wrapCallback(obs.observe);
    Services.obs.addObserver(obs, notification, weak);
  },
  removeObserver: function(obs, notification) {
    this._removeObserverProxy(notification);
    Services.obs.removeObserver(Cu.waiveXrays(obs), notification);
  },
  notifyObservers: function(subject, topic, data) {
    Services.obs.notifyObservers(subject, topic, data);
  },

  can_QI: function(obj) {
    return obj.QueryInterface !== undefined;
  },
  do_QueryInterface: function(obj, iface) {
    return obj.QueryInterface(Ci[iface]);
  },

  call_Instanceof: function (obj1, obj2) {
     obj1=unwrapIfWrapped(obj1);
     obj2=unwrapIfWrapped(obj2);
     return obj1 instanceof obj2;
  },

  // Returns a privileged getter from an object. GetOwnPropertyDescriptor does
  // not work here because xray wrappers don't properly implement it.
  //
  // This terribleness is used by dom/base/test/test_object.html because
  // <object> and <embed> tags will spawn plugins if their prototype is touched,
  // so we need to get and cache the getter of |hasRunningPlugin| if we want to
  // call it without paradoxically spawning the plugin.
  do_lookupGetter: function(obj, name) {
    return Object.prototype.__lookupGetter__.call(obj, name);
  },

  // Mimic the get*Pref API
  getBoolPref: function(aPrefName) {
    return (this._getPref(aPrefName, 'BOOL'));
  },
  getIntPref: function(aPrefName) {
    return (this._getPref(aPrefName, 'INT'));
  },
  getCharPref: function(aPrefName) {
    return (this._getPref(aPrefName, 'CHAR'));
  },
  getComplexValue: function(aPrefName, aIid) {
    return (this._getPref(aPrefName, 'COMPLEX', aIid));
  },

  // Mimic the set*Pref API
  setBoolPref: function(aPrefName, aValue) {
    return (this._setPref(aPrefName, 'BOOL', aValue));
  },
  setIntPref: function(aPrefName, aValue) {
    return (this._setPref(aPrefName, 'INT', aValue));
  },
  setCharPref: function(aPrefName, aValue) {
    return (this._setPref(aPrefName, 'CHAR', aValue));
  },
  setComplexValue: function(aPrefName, aIid, aValue) {
    return (this._setPref(aPrefName, 'COMPLEX', aValue, aIid));
  },

  // Mimic the clearUserPref API
  clearUserPref: function(aPrefName) {
    var msg = {'op':'clear', 'prefName': aPrefName, 'prefType': ""};
    this._sendSyncMessage('SPPrefService', msg);
  },

  // Private pref functions to communicate to chrome
  _getPref: function(aPrefName, aPrefType, aIid) {
    var msg = {};
    if (aIid) {
      // Overloading prefValue to handle complex prefs
      msg = {'op':'get', 'prefName': aPrefName, 'prefType':aPrefType, 'prefValue':[aIid]};
    } else {
      msg = {'op':'get', 'prefName': aPrefName,'prefType': aPrefType};
    }
    var val = this._sendSyncMessage('SPPrefService', msg);

    if (val == null || val[0] == null)
      throw "Error getting pref '" + aPrefName + "'";
    return val[0];
  },
  _setPref: function(aPrefName, aPrefType, aValue, aIid) {
    var msg = {};
    if (aIid) {
      msg = {'op':'set','prefName':aPrefName, 'prefType': aPrefType, 'prefValue': [aIid,aValue]};
    } else {
      msg = {'op':'set', 'prefName': aPrefName, 'prefType': aPrefType, 'prefValue': aValue};
    }
    return(this._sendSyncMessage('SPPrefService', msg)[0]);
  },

  _getDocShell: function(window) {
    return window.QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIWebNavigation)
                 .QueryInterface(Ci.nsIDocShell);
  },
  _getMUDV: function(window) {
    return this._getDocShell(window).contentViewer;
  },
  //XXX: these APIs really ought to be removed, they're not e10s-safe.
  // (also they're pretty Firefox-specific)
  _getTopChromeWindow: function(window) {
    return window.QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIWebNavigation)
                 .QueryInterface(Ci.nsIDocShellTreeItem)
                 .rootTreeItem
                 .QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIDOMWindow)
                 .QueryInterface(Ci.nsIDOMChromeWindow);
  },
  _getAutoCompletePopup: function(window) {
    return this._getTopChromeWindow(window).document
                                           .getElementById("PopupAutoComplete");
  },
  addAutoCompletePopupEventListener: function(window, eventname, listener) {
    this._getAutoCompletePopup(window).addEventListener(eventname,
                                                        listener,
                                                        false);
  },
  removeAutoCompletePopupEventListener: function(window, eventname, listener) {
    this._getAutoCompletePopup(window).removeEventListener(eventname,
                                                           listener,
                                                           false);
  },
  get formHistory() {
    let tmp = {};
    Cu.import("resource://gre/modules/FormHistory.jsm", tmp);
    return wrapPrivileged(tmp.FormHistory);
  },
  getFormFillController: function(window) {
    return Components.classes["@mozilla.org/satchel/form-fill-controller;1"]
                     .getService(Components.interfaces.nsIFormFillController);
  },
  attachFormFillControllerTo: function(window) {
    this.getFormFillController()
        .attachToBrowser(this._getDocShell(window),
                         this._getAutoCompletePopup(window));
  },
  detachFormFillControllerFrom: function(window) {
    this.getFormFillController().detachFromBrowser(this._getDocShell(window));
  },
  isBackButtonEnabled: function(window) {
    return !this._getTopChromeWindow(window).document
                                      .getElementById("Browser:Back")
                                      .hasAttribute("disabled");
  },
  //XXX end of problematic APIs

  addChromeEventListener: function(type, listener, capture, allowUntrusted) {
    addEventListener(type, listener, capture, allowUntrusted);
  },
  removeChromeEventListener: function(type, listener, capture) {
    removeEventListener(type, listener, capture);
  },

  // Note: each call to registerConsoleListener MUST be paired with a
  // call to postConsoleSentinel; when the callback receives the
  // sentinel it will unregister itself (_after_ calling the
  // callback).  SimpleTest.expectConsoleMessages does this for you.
  // If you register more than one console listener, a call to
  // postConsoleSentinel will zap all of them.
  registerConsoleListener: function(callback) {
    let listener = new SPConsoleListener(callback);
    Services.console.registerListener(listener);
  },
  postConsoleSentinel: function() {
    Services.console.logStringMessage("SENTINEL");
  },
  resetConsole: function() {
    Services.console.reset();
  },

  getFullZoom: function(window) {
    return this._getMUDV(window).fullZoom;
  },
  setFullZoom: function(window, zoom) {
    this._getMUDV(window).fullZoom = zoom;
  },
  getTextZoom: function(window) {
    return this._getMUDV(window).textZoom;
  },
  setTextZoom: function(window, zoom) {
    this._getMUDV(window).textZoom = zoom;
  },

  emulateMedium: function(window, mediaType) {
    this._getMUDV(window).emulateMedium(mediaType);
  },
  stopEmulatingMedium: function(window) {
    this._getMUDV(window).stopEmulatingMedium();
  },

  snapshotWindowWithOptions: function (win, rect, bgcolor, options) {
    var el = this.window.get().document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    if (rect === undefined) {
      rect = { top: win.scrollY, left: win.scrollX,
               width: win.innerWidth, height: win.innerHeight };
    }
    if (bgcolor === undefined) {
      bgcolor = "rgb(255,255,255)";
    }
    if (options === undefined) {
      options = { };
    }

    el.width = rect.width;
    el.height = rect.height;
    var ctx = el.getContext("2d");
    var flags = 0;

    for (var option in options) {
      flags |= options[option] && ctx[option];
    }

    ctx.drawWindow(win,
                   rect.left, rect.top, rect.width, rect.height,
                   bgcolor,
                   flags);
    return el;
  },

  snapshotWindow: function (win, withCaret, rect, bgcolor) {
    return this.snapshotWindowWithOptions(win, rect, bgcolor,
                                          { DRAWWINDOW_DRAW_CARET: withCaret });
  },

  snapshotRect: function (win, rect, bgcolor) {
    return this.snapshotWindowWithOptions(win, rect, bgcolor);
  },

  gc: function() {
    this.DOMWindowUtils.garbageCollect();
  },

  forceGC: function() {
    Cu.forceGC();
  },

  forceCC: function() {
    Cu.forceCC();
  },

  finishCC: function() {
    Cu.finishCC();
  },

  ccSlice: function(budget) {
    Cu.ccSlice(budget);
  },

  // Due to various dependencies between JS objects and C++ objects, an ordinary
  // forceGC doesn't necessarily clear all unused objects, thus the GC and CC
  // needs to run several times and when no other JS is running.
  // The current number of iterations has been determined according to massive
  // cross platform testing.
  exactGC: function(win, callback) {
    var self = this;
    let count = 0;

    function genGCCallback(cb) {
      return function() {
        self.getDOMWindowUtils(win).cycleCollect();
        if (++count < 2) {
          Cu.schedulePreciseGC(genGCCallback(cb));
        } else if (cb) {
          cb();
        }
      }
    }

    Cu.schedulePreciseGC(genGCCallback(callback));
  },

  setGCZeal: function(zeal) {
    Cu.setGCZeal(zeal);
  },

  isMainProcess: function() {
    try {
      return Cc["@mozilla.org/xre/app-info;1"].
               getService(Ci.nsIXULRuntime).
               processType == Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT;
    } catch (e) { }
    return true;
  },

  _xpcomabi: null,

  get XPCOMABI() {
    if (this._xpcomabi != null)
      return this._xpcomabi;

    var xulRuntime = Cc["@mozilla.org/xre/app-info;1"]
                        .getService(Components.interfaces.nsIXULAppInfo)
                        .QueryInterface(Components.interfaces.nsIXULRuntime);

    this._xpcomabi = xulRuntime.XPCOMABI;
    return this._xpcomabi;
  },

  // The optional aWin parameter allows the caller to specify a given window in
  // whose scope the runnable should be dispatched. If aFun throws, the
  // exception will be reported to aWin.
  executeSoon: function(aFun, aWin) {
    // Create the runnable in the scope of aWin to avoid running into COWs.
    var runnable = {};
    if (aWin)
        runnable = Cu.createObjectIn(aWin);
    runnable.run = aFun;
    Cu.dispatch(runnable, aWin);
  },

  _os: null,

  get OS() {
    if (this._os != null)
      return this._os;

    var xulRuntime = Cc["@mozilla.org/xre/app-info;1"]
                        .getService(Components.interfaces.nsIXULAppInfo)
                        .QueryInterface(Components.interfaces.nsIXULRuntime);

    this._os = xulRuntime.OS;
    return this._os;
  },

  get isB2G() {
#ifdef MOZ_B2G
    return true;
#else
    return false;
#endif
  },

  addSystemEventListener: function(target, type, listener, useCapture) {
    Cc["@mozilla.org/eventlistenerservice;1"].
      getService(Ci.nsIEventListenerService).
      addSystemEventListener(target, type, listener, useCapture);
  },
  removeSystemEventListener: function(target, type, listener, useCapture) {
    Cc["@mozilla.org/eventlistenerservice;1"].
      getService(Ci.nsIEventListenerService).
      removeSystemEventListener(target, type, listener, useCapture);
  },

  getDOMRequestService: function() {
    var serv = Services.DOMRequest;
    var res = {};
    var props = ["createRequest", "createCursor", "fireError", "fireSuccess",
                 "fireDone", "fireDetailedError"];
    for (var i in props) {
      let prop = props[i];
      res[prop] = function() { return serv[prop].apply(serv, arguments) };
    }
    return res;
  },

  setLogFile: function(path) {
    this._mfl = new MozillaFileLogger(path);
  },

  log: function(data) {
    this._mfl.log(data);
  },

  closeLogFile: function() {
    this._mfl.close();
  },

  addCategoryEntry: function(category, entry, value, persists, replace) {
    Components.classes["@mozilla.org/categorymanager;1"].
      getService(Components.interfaces.nsICategoryManager).
      addCategoryEntry(category, entry, value, persists, replace);
  },

  deleteCategoryEntry: function(category, entry, persists) {
    Components.classes["@mozilla.org/categorymanager;1"].
      getService(Components.interfaces.nsICategoryManager).
      deleteCategoryEntry(category, entry, persists);
  },

  openDialog: function(win, args) {
    return win.openDialog.apply(win, args);
  },

  // :jdm gets credit for this.  ex: getPrivilegedProps(window, 'location.href');
  getPrivilegedProps: function(obj, props) {
    var parts = props.split('.');

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (obj[p]) {
        obj = obj[p];
      } else {
        return null;
      }
    }
    return obj;
  },

  get focusManager() {
    if (this._fm != null)
      return this._fm;

    this._fm = Components.classes["@mozilla.org/focus-manager;1"].
                        getService(Components.interfaces.nsIFocusManager);

    return this._fm;
  },

  getFocusedElementForWindow: function(targetWindow, aDeep) {
    var outParam = {};
    this.focusManager.getFocusedElementForWindow(targetWindow, aDeep, outParam);
    return outParam.value;
  },

  activeWindow: function() {
    return this.focusManager.activeWindow;
  },

  focusedWindow: function() {
    return this.focusManager.focusedWindow;
  },

  focus: function(aWindow) {
    // This is called inside TestRunner._makeIframe without aWindow, because of assertions in oop mochitests
    // With aWindow, it is called in SimpleTest.waitForFocus to allow popup window opener focus switching
    if (aWindow)
      aWindow.focus();
    sendAsyncMessage("SpecialPowers.Focus", {});
  },

  getClipboardData: function(flavor, whichClipboard) {
    if (this._cb == null)
      this._cb = Components.classes["@mozilla.org/widget/clipboard;1"].
                            getService(Components.interfaces.nsIClipboard);
    if (whichClipboard === undefined)
      whichClipboard = this._cb.kGlobalClipboard;

    var xferable = Components.classes["@mozilla.org/widget/transferable;1"].
                   createInstance(Components.interfaces.nsITransferable);
    // in e10s b-c tests |content.window| is a CPOW whereas |window| works fine.
    // for some non-e10s mochi tests, |window| is null whereas |content.window|
    // works fine.  So we take whatever is non-null!
    xferable.init(this._getDocShell(typeof(window) == "undefined" ? content.window : window)
                      .QueryInterface(Components.interfaces.nsILoadContext));
    xferable.addDataFlavor(flavor);
    this._cb.getData(xferable, whichClipboard);
    var data = {};
    try {
      xferable.getTransferData(flavor, data, {});
    } catch (e) {}
    data = data.value || null;
    if (data == null)
      return "";

    return data.QueryInterface(Components.interfaces.nsISupportsString).data;
  },

  clipboardCopyString: function(str) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].
      getService(Ci.nsIClipboardHelper).
      copyString(str);
  },

  supportsSelectionClipboard: function() {
    if (this._cb == null) {
      this._cb = Components.classes["@mozilla.org/widget/clipboard;1"].
                            getService(Components.interfaces.nsIClipboard);
    }
    return this._cb.supportsSelectionClipboard();
  },

  swapFactoryRegistration: function(cid, contractID, newFactory, oldFactory) {
    newFactory = Cu.waiveXrays(newFactory);
    oldFactory = Cu.waiveXrays(oldFactory);

    var componentRegistrar = Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);

    var unregisterFactory = newFactory;
    var registerFactory = oldFactory;

    if (cid == null) {
      if (contractID != null) {
        cid = componentRegistrar.contractIDToCID(contractID);
        oldFactory = Components.manager.getClassObject(Components.classes[contractID],
                                                            Components.interfaces.nsIFactory);
      } else {
        return {'error': "trying to register a new contract ID: Missing contractID"};
      }

      unregisterFactory = oldFactory;
      registerFactory = newFactory;
    }
    componentRegistrar.unregisterFactory(cid,
                                         unregisterFactory);

    // Restore the original factory.
    componentRegistrar.registerFactory(cid,
                                       "",
                                       contractID,
                                       registerFactory);
    return {'cid':cid, 'originalFactory':oldFactory};
  },

  _getElement: function(aWindow, id) {
    return ((typeof(id) == "string") ?
        aWindow.document.getElementById(id) : id);
  },

  dispatchEvent: function(aWindow, target, event) {
    var el = this._getElement(aWindow, target);
    return el.dispatchEvent(event);
  },

  get isDebugBuild() {
    delete SpecialPowersAPI.prototype.isDebugBuild;

    var debug = Cc["@mozilla.org/xpcom/debug;1"].getService(Ci.nsIDebug2);
    return SpecialPowersAPI.prototype.isDebugBuild = debug.isDebugBuild;
  },
  assertionCount: function() {
    var debugsvc = Cc['@mozilla.org/xpcom/debug;1'].getService(Ci.nsIDebug2);
    return debugsvc.assertionCount;
  },

  /**
   * Get the message manager associated with an <iframe mozbrowser>.
   */
  getBrowserFrameMessageManager: function(aFrameElement) {
    return this.wrap(aFrameElement.QueryInterface(Ci.nsIFrameLoaderOwner)
                                  .frameLoader
                                  .messageManager);
  },

  _getPrincipalFromArg: function(arg) {
    let principal;
    let secMan = Services.scriptSecurityManager;

    if (typeof(arg) == "string") {
      // It's an URL.
      let uri = Services.io.newURI(arg, null, null);
      principal = secMan.createCodebasePrincipal(uri, {});
    } else if (arg.manifestURL) {
      // It's a thing representing an app.
      let appsSvc = Cc["@mozilla.org/AppsService;1"]
                      .getService(Ci.nsIAppsService)
      let app = appsSvc.getAppByManifestURL(arg.manifestURL);
      if (!app) {
        throw "No app for this manifest!";
      }

      principal = app.principal;
    } else if (arg.nodePrincipal) {
      // It's a document.
      // In some tests the arg is a wrapped DOM element, so we unwrap it first.
      principal = unwrapIfWrapped(arg).nodePrincipal;
    } else {
      let uri = Services.io.newURI(arg.url, null, null);
      let attrs = arg.originAttributes || {};
      principal = secMan.createCodebasePrincipal(uri, attrs);
    }

    return principal;
  },

  addPermission: function(type, allow, arg, expireType, expireTime) {
    let principal = this._getPrincipalFromArg(arg);
    if (principal.isSystemPrincipal) {
      return; // nothing to do
    }

    let permission;
    if (typeof allow !== 'boolean') {
      permission = allow;
    } else {
      permission = allow ? Ci.nsIPermissionManager.ALLOW_ACTION
                         : Ci.nsIPermissionManager.DENY_ACTION;
    }

    var msg = {
      'op': 'add',
      'type': type,
      'permission': permission,
      'principal': principal,
      'expireType': (typeof expireType === "number") ? expireType : 0,
      'expireTime': (typeof expireTime === "number") ? expireTime : 0
    };

    this._sendSyncMessage('SPPermissionManager', msg);
  },

  removePermission: function(type, arg) {
    let principal = this._getPrincipalFromArg(arg);
    if (principal.isSystemPrincipal) {
      return; // nothing to do
    }

    var msg = {
      'op': 'remove',
      'type': type,
      'principal': principal
    };

    this._sendSyncMessage('SPPermissionManager', msg);
  },

  hasPermission: function (type, arg) {
    let principal = this._getPrincipalFromArg(arg);
    if (principal.isSystemPrincipal) {
      return true; // system principals have all permissions
    }

    var msg = {
      'op': 'has',
      'type': type,
      'principal': principal
    };

    return this._sendSyncMessage('SPPermissionManager', msg)[0];
  },

  testPermission: function (type, value, arg) {
    let principal = this._getPrincipalFromArg(arg);
    if (principal.isSystemPrincipal) {
      return true; // system principals have all permissions
    }

    var msg = {
      'op': 'test',
      'type': type,
      'value': value,
      'principal': principal
    };
    return this._sendSyncMessage('SPPermissionManager', msg)[0];
  },

  isContentWindowPrivate: function(win) {
    return PrivateBrowsingUtils.isContentWindowPrivate(win);
  },

  notifyObserversInParentProcess: function(subject, topic, data) {
    if (subject) {
      throw new Error("Can't send subject to another process!");
    }
    if (this.isMainProcess()) {
      this.notifyObservers(subject, topic, data);
      return;
    }
    var msg = {
      'op': 'notify',
      'observerTopic': topic,
      'observerData': data
    };
    this._sendSyncMessage('SPObserverService', msg);
  },

  createDOMFile: function(path, options) {
    return new File(path, options);
  },

  removeAllServiceWorkerData: function() {
    this.notifyObserversInParentProcess(null, "browser:purge-session-history", "");
  },

  removeServiceWorkerDataForExampleDomain: function() {
    this.notifyObserversInParentProcess(null, "browser:purge-domain-data", "example.com");
  },

  cleanUpSTSData: function(origin, flags) {
    return this._sendSyncMessage('SPCleanUpSTSData', {origin: origin, flags: flags || 0});
  },

  loadExtension: function(id, ext, handler) {
    if (!id) {
      let uuidGenerator = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);
      id = uuidGenerator.generateUUID().number;
    }

    let resolveStartup, resolveUnload, rejectStartup;
    let startupPromise = new Promise((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    let unloadPromise = new Promise(resolve => { resolveUnload = resolve; });

    startupPromise.catch(() => {
      this._removeMessageListener("SPExtensionMessage", listener);
    });

    handler = Cu.waiveXrays(handler);
    ext = Cu.waiveXrays(ext);

    let sp = this;
    let extension = {
      id,

      startup() {
        sp._sendAsyncMessage("SPStartupExtension", {id});
        return startupPromise;
      },

      unload() {
        sp._sendAsyncMessage("SPUnloadExtension", {id});
        return unloadPromise;
      },

      sendMessage(...args) {
        sp._sendAsyncMessage("SPExtensionMessage", {id, args});
      },
    };

    this._sendAsyncMessage("SPLoadExtension", {ext, id});

    let listener = (msg) => {
      if (msg.data.id == id) {
        if (msg.data.type == "extensionStarted") {
          resolveStartup();
        } else if (msg.data.type == "extensionFailed") {
          rejectStartup("startup failed");
        } else if (msg.data.type == "extensionUnloaded") {
          this._removeMessageListener("SPExtensionMessage", listener);
          resolveUnload();
        } else if (msg.data.type in handler) {
          handler[msg.data.type](...msg.data.args);
        } else {
          dump(`Unexpected: ${msg.data.type}\n`);
        }
      }
    };

    this._addMessageListener("SPExtensionMessage", listener);
    return extension;
  },

  invalidateExtensionStorageCache: function() {
    this.notifyObserversInParentProcess(null, "extension-invalidate-storage-cache", "");
  },
};

this.SpecialPowersAPI = SpecialPowersAPI;
this.bindDOMWindowUtils = bindDOMWindowUtils;
this.getRawComponents = getRawComponents;
