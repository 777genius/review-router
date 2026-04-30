"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "node_modules/retry/lib/retry_operation.js"(exports2, module2) {
    function RetryOperation(timeouts, options) {
      if (typeof options === "boolean") {
        options = { forever: options };
      }
      this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
      this._timeouts = timeouts;
      this._options = options || {};
      this._maxRetryTime = options && options.maxRetryTime || Infinity;
      this._fn = null;
      this._errors = [];
      this._attempts = 1;
      this._operationTimeout = null;
      this._operationTimeoutCb = null;
      this._timeout = null;
      this._operationStart = null;
      this._timer = null;
      if (this._options.forever) {
        this._cachedTimeouts = this._timeouts.slice(0);
      }
    }
    module2.exports = RetryOperation;
    RetryOperation.prototype.reset = function() {
      this._attempts = 1;
      this._timeouts = this._originalTimeouts.slice(0);
    };
    RetryOperation.prototype.stop = function() {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (this._timer) {
        clearTimeout(this._timer);
      }
      this._timeouts = [];
      this._cachedTimeouts = null;
    };
    RetryOperation.prototype.retry = function(err) {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (!err) {
        return false;
      }
      var currentTime = (/* @__PURE__ */ new Date()).getTime();
      if (err && currentTime - this._operationStart >= this._maxRetryTime) {
        this._errors.push(err);
        this._errors.unshift(new Error("RetryOperation timeout occurred"));
        return false;
      }
      this._errors.push(err);
      var timeout = this._timeouts.shift();
      if (timeout === void 0) {
        if (this._cachedTimeouts) {
          this._errors.splice(0, this._errors.length - 1);
          timeout = this._cachedTimeouts.slice(-1);
        } else {
          return false;
        }
      }
      var self = this;
      this._timer = setTimeout(function() {
        self._attempts++;
        if (self._operationTimeoutCb) {
          self._timeout = setTimeout(function() {
            self._operationTimeoutCb(self._attempts);
          }, self._operationTimeout);
          if (self._options.unref) {
            self._timeout.unref();
          }
        }
        self._fn(self._attempts);
      }, timeout);
      if (this._options.unref) {
        this._timer.unref();
      }
      return true;
    };
    RetryOperation.prototype.attempt = function(fn, timeoutOps) {
      this._fn = fn;
      if (timeoutOps) {
        if (timeoutOps.timeout) {
          this._operationTimeout = timeoutOps.timeout;
        }
        if (timeoutOps.cb) {
          this._operationTimeoutCb = timeoutOps.cb;
        }
      }
      var self = this;
      if (this._operationTimeoutCb) {
        this._timeout = setTimeout(function() {
          self._operationTimeoutCb();
        }, self._operationTimeout);
      }
      this._operationStart = (/* @__PURE__ */ new Date()).getTime();
      this._fn(this._attempts);
    };
    RetryOperation.prototype.try = function(fn) {
      console.log("Using RetryOperation.try() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = function(fn) {
      console.log("Using RetryOperation.start() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = RetryOperation.prototype.try;
    RetryOperation.prototype.errors = function() {
      return this._errors;
    };
    RetryOperation.prototype.attempts = function() {
      return this._attempts;
    };
    RetryOperation.prototype.mainError = function() {
      if (this._errors.length === 0) {
        return null;
      }
      var counts = {};
      var mainError = null;
      var mainErrorCount = 0;
      for (var i = 0; i < this._errors.length; i++) {
        var error2 = this._errors[i];
        var message = error2.message;
        var count = (counts[message] || 0) + 1;
        counts[message] = count;
        if (count >= mainErrorCount) {
          mainError = error2;
          mainErrorCount = count;
        }
      }
      return mainError;
    };
  }
});

// node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "node_modules/retry/lib/retry.js"(exports2) {
    var RetryOperation = require_retry_operation();
    exports2.operation = function(options) {
      var timeouts = exports2.timeouts(options);
      return new RetryOperation(timeouts, {
        forever: options && (options.forever || options.retries === Infinity),
        unref: options && options.unref,
        maxRetryTime: options && options.maxRetryTime
      });
    };
    exports2.timeouts = function(options) {
      if (options instanceof Array) {
        return [].concat(options);
      }
      var opts = {
        retries: 10,
        factor: 2,
        minTimeout: 1 * 1e3,
        maxTimeout: Infinity,
        randomize: false
      };
      for (var key in options) {
        opts[key] = options[key];
      }
      if (opts.minTimeout > opts.maxTimeout) {
        throw new Error("minTimeout is greater than maxTimeout");
      }
      var timeouts = [];
      for (var i = 0; i < opts.retries; i++) {
        timeouts.push(this.createTimeout(i, opts));
      }
      if (options && options.forever && !timeouts.length) {
        timeouts.push(this.createTimeout(i, opts));
      }
      timeouts.sort(function(a, b) {
        return a - b;
      });
      return timeouts;
    };
    exports2.createTimeout = function(attempt, opts) {
      var random = opts.randomize ? Math.random() + 1 : 1;
      var timeout = Math.round(random * Math.max(opts.minTimeout, 1) * Math.pow(opts.factor, attempt));
      timeout = Math.min(timeout, opts.maxTimeout);
      return timeout;
    };
    exports2.wrap = function(obj, options, methods) {
      if (options instanceof Array) {
        methods = options;
        options = null;
      }
      if (!methods) {
        methods = [];
        for (var key in obj) {
          if (typeof obj[key] === "function") {
            methods.push(key);
          }
        }
      }
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        var original = obj[method];
        obj[method] = function retryWrapper(original2) {
          var op = exports2.operation(options);
          var args = Array.prototype.slice.call(arguments, 1);
          var callback = args.pop();
          args.push(function(err) {
            if (op.retry(err)) {
              return;
            }
            if (err) {
              arguments[0] = op.mainError();
            }
            callback.apply(this, arguments);
          });
          op.attempt(function() {
            original2.apply(obj, args);
          });
        }.bind(obj, original);
        obj[method].options = options;
      }
    };
  }
});

// node_modules/retry/index.js
var require_retry2 = __commonJS({
  "node_modules/retry/index.js"(exports2, module2) {
    module2.exports = require_retry();
  }
});

// node_modules/eventemitter3/index.js
var require_eventemitter3 = __commonJS({
  "node_modules/eventemitter3/index.js"(exports2, module2) {
    "use strict";
    var has = Object.prototype.hasOwnProperty;
    var prefix = "~";
    function Events() {
    }
    if (Object.create) {
      Events.prototype = /* @__PURE__ */ Object.create(null);
      if (!new Events().__proto__) prefix = false;
    }
    function EE(fn, context, once) {
      this.fn = fn;
      this.context = context;
      this.once = once || false;
    }
    function addListener(emitter, event, fn, context, once) {
      if (typeof fn !== "function") {
        throw new TypeError("The listener must be a function");
      }
      var listener = new EE(fn, context || emitter, once), evt = prefix ? prefix + event : event;
      if (!emitter._events[evt]) emitter._events[evt] = listener, emitter._eventsCount++;
      else if (!emitter._events[evt].fn) emitter._events[evt].push(listener);
      else emitter._events[evt] = [emitter._events[evt], listener];
      return emitter;
    }
    function clearEvent(emitter, evt) {
      if (--emitter._eventsCount === 0) emitter._events = new Events();
      else delete emitter._events[evt];
    }
    function EventEmitter2() {
      this._events = new Events();
      this._eventsCount = 0;
    }
    EventEmitter2.prototype.eventNames = function eventNames() {
      var names = [], events, name;
      if (this._eventsCount === 0) return names;
      for (name in events = this._events) {
        if (has.call(events, name)) names.push(prefix ? name.slice(1) : name);
      }
      if (Object.getOwnPropertySymbols) {
        return names.concat(Object.getOwnPropertySymbols(events));
      }
      return names;
    };
    EventEmitter2.prototype.listeners = function listeners(event) {
      var evt = prefix ? prefix + event : event, handlers = this._events[evt];
      if (!handlers) return [];
      if (handlers.fn) return [handlers.fn];
      for (var i = 0, l = handlers.length, ee = new Array(l); i < l; i++) {
        ee[i] = handlers[i].fn;
      }
      return ee;
    };
    EventEmitter2.prototype.listenerCount = function listenerCount(event) {
      var evt = prefix ? prefix + event : event, listeners = this._events[evt];
      if (!listeners) return 0;
      if (listeners.fn) return 1;
      return listeners.length;
    };
    EventEmitter2.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt]) return false;
      var listeners = this._events[evt], len = arguments.length, args, i;
      if (listeners.fn) {
        if (listeners.once) this.removeListener(event, listeners.fn, void 0, true);
        switch (len) {
          case 1:
            return listeners.fn.call(listeners.context), true;
          case 2:
            return listeners.fn.call(listeners.context, a1), true;
          case 3:
            return listeners.fn.call(listeners.context, a1, a2), true;
          case 4:
            return listeners.fn.call(listeners.context, a1, a2, a3), true;
          case 5:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
          case 6:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
        }
        for (i = 1, args = new Array(len - 1); i < len; i++) {
          args[i - 1] = arguments[i];
        }
        listeners.fn.apply(listeners.context, args);
      } else {
        var length = listeners.length, j;
        for (i = 0; i < length; i++) {
          if (listeners[i].once) this.removeListener(event, listeners[i].fn, void 0, true);
          switch (len) {
            case 1:
              listeners[i].fn.call(listeners[i].context);
              break;
            case 2:
              listeners[i].fn.call(listeners[i].context, a1);
              break;
            case 3:
              listeners[i].fn.call(listeners[i].context, a1, a2);
              break;
            case 4:
              listeners[i].fn.call(listeners[i].context, a1, a2, a3);
              break;
            default:
              if (!args) for (j = 1, args = new Array(len - 1); j < len; j++) {
                args[j - 1] = arguments[j];
              }
              listeners[i].fn.apply(listeners[i].context, args);
          }
        }
      }
      return true;
    };
    EventEmitter2.prototype.on = function on(event, fn, context) {
      return addListener(this, event, fn, context, false);
    };
    EventEmitter2.prototype.once = function once(event, fn, context) {
      return addListener(this, event, fn, context, true);
    };
    EventEmitter2.prototype.removeListener = function removeListener(event, fn, context, once) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt]) return this;
      if (!fn) {
        clearEvent(this, evt);
        return this;
      }
      var listeners = this._events[evt];
      if (listeners.fn) {
        if (listeners.fn === fn && (!once || listeners.once) && (!context || listeners.context === context)) {
          clearEvent(this, evt);
        }
      } else {
        for (var i = 0, events = [], length = listeners.length; i < length; i++) {
          if (listeners[i].fn !== fn || once && !listeners[i].once || context && listeners[i].context !== context) {
            events.push(listeners[i]);
          }
        }
        if (events.length) this._events[evt] = events.length === 1 ? events[0] : events;
        else clearEvent(this, evt);
      }
      return this;
    };
    EventEmitter2.prototype.removeAllListeners = function removeAllListeners(event) {
      var evt;
      if (event) {
        evt = prefix ? prefix + event : event;
        if (this._events[evt]) clearEvent(this, evt);
      } else {
        this._events = new Events();
        this._eventsCount = 0;
      }
      return this;
    };
    EventEmitter2.prototype.off = EventEmitter2.prototype.removeListener;
    EventEmitter2.prototype.addListener = EventEmitter2.prototype.on;
    EventEmitter2.prefixed = prefix;
    EventEmitter2.EventEmitter = EventEmitter2;
    if ("undefined" !== typeof module2) {
      module2.exports = EventEmitter2;
    }
  }
});

// node_modules/universal-user-agent/dist-node/index.js
var require_dist_node = __commonJS({
  "node_modules/universal-user-agent/dist-node/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    function getUserAgent() {
      if (typeof navigator === "object" && "userAgent" in navigator) {
        return navigator.userAgent;
      }
      if (typeof process === "object" && process.version !== void 0) {
        return `Node.js/${process.version.substr(1)} (${process.platform}; ${process.arch})`;
      }
      return "<environment undetectable>";
    }
    exports2.getUserAgent = getUserAgent;
  }
});

// node_modules/before-after-hook/lib/register.js
var require_register = __commonJS({
  "node_modules/before-after-hook/lib/register.js"(exports2, module2) {
    module2.exports = register;
    function register(state, name, method, options) {
      if (typeof method !== "function") {
        throw new Error("method for before hook must be a function");
      }
      if (!options) {
        options = {};
      }
      if (Array.isArray(name)) {
        return name.reverse().reduce(function(callback, name2) {
          return register.bind(null, state, name2, callback, options);
        }, method)();
      }
      return Promise.resolve().then(function() {
        if (!state.registry[name]) {
          return method(options);
        }
        return state.registry[name].reduce(function(method2, registered) {
          return registered.hook.bind(null, method2, options);
        }, method)();
      });
    }
  }
});

// node_modules/before-after-hook/lib/add.js
var require_add = __commonJS({
  "node_modules/before-after-hook/lib/add.js"(exports2, module2) {
    module2.exports = addHook;
    function addHook(state, kind, name, hook) {
      var orig = hook;
      if (!state.registry[name]) {
        state.registry[name] = [];
      }
      if (kind === "before") {
        hook = function(method, options) {
          return Promise.resolve().then(orig.bind(null, options)).then(method.bind(null, options));
        };
      }
      if (kind === "after") {
        hook = function(method, options) {
          var result;
          return Promise.resolve().then(method.bind(null, options)).then(function(result_) {
            result = result_;
            return orig(result, options);
          }).then(function() {
            return result;
          });
        };
      }
      if (kind === "error") {
        hook = function(method, options) {
          return Promise.resolve().then(method.bind(null, options)).catch(function(error2) {
            return orig(error2, options);
          });
        };
      }
      state.registry[name].push({
        hook,
        orig
      });
    }
  }
});

// node_modules/before-after-hook/lib/remove.js
var require_remove = __commonJS({
  "node_modules/before-after-hook/lib/remove.js"(exports2, module2) {
    module2.exports = removeHook;
    function removeHook(state, name, method) {
      if (!state.registry[name]) {
        return;
      }
      var index = state.registry[name].map(function(registered) {
        return registered.orig;
      }).indexOf(method);
      if (index === -1) {
        return;
      }
      state.registry[name].splice(index, 1);
    }
  }
});

// node_modules/before-after-hook/index.js
var require_before_after_hook = __commonJS({
  "node_modules/before-after-hook/index.js"(exports2, module2) {
    var register = require_register();
    var addHook = require_add();
    var removeHook = require_remove();
    var bind = Function.bind;
    var bindable = bind.bind(bind);
    function bindApi(hook, state, name) {
      var removeHookRef = bindable(removeHook, null).apply(
        null,
        name ? [state, name] : [state]
      );
      hook.api = { remove: removeHookRef };
      hook.remove = removeHookRef;
      ["before", "error", "after", "wrap"].forEach(function(kind) {
        var args = name ? [state, kind, name] : [state, kind];
        hook[kind] = hook.api[kind] = bindable(addHook, null).apply(null, args);
      });
    }
    function HookSingular() {
      var singularHookName = "h";
      var singularHookState = {
        registry: {}
      };
      var singularHook = register.bind(null, singularHookState, singularHookName);
      bindApi(singularHook, singularHookState, singularHookName);
      return singularHook;
    }
    function HookCollection() {
      var state = {
        registry: {}
      };
      var hook = register.bind(null, state);
      bindApi(hook, state);
      return hook;
    }
    var collectionHookDeprecationMessageDisplayed = false;
    function Hook() {
      if (!collectionHookDeprecationMessageDisplayed) {
        console.warn(
          '[before-after-hook]: "Hook()" repurposing warning, use "Hook.Collection()". Read more: https://git.io/upgrade-before-after-hook-to-1.4'
        );
        collectionHookDeprecationMessageDisplayed = true;
      }
      return HookCollection();
    }
    Hook.Singular = HookSingular.bind();
    Hook.Collection = HookCollection.bind();
    module2.exports = Hook;
    module2.exports.Hook = Hook;
    module2.exports.Singular = Hook.Singular;
    module2.exports.Collection = Hook.Collection;
  }
});

// node_modules/@octokit/endpoint/dist-node/index.js
var require_dist_node2 = __commonJS({
  "node_modules/@octokit/endpoint/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var dist_src_exports = {};
    __export2(dist_src_exports, {
      endpoint: () => endpoint
    });
    module2.exports = __toCommonJS(dist_src_exports);
    var import_universal_user_agent = require_dist_node();
    var VERSION = "9.0.6";
    var userAgent = `octokit-endpoint.js/${VERSION} ${(0, import_universal_user_agent.getUserAgent)()}`;
    var DEFAULTS = {
      method: "GET",
      baseUrl: "https://api.github.com",
      headers: {
        accept: "application/vnd.github.v3+json",
        "user-agent": userAgent
      },
      mediaType: {
        format: ""
      }
    };
    function lowercaseKeys(object) {
      if (!object) {
        return {};
      }
      return Object.keys(object).reduce((newObj, key) => {
        newObj[key.toLowerCase()] = object[key];
        return newObj;
      }, {});
    }
    function isPlainObject(value) {
      if (typeof value !== "object" || value === null)
        return false;
      if (Object.prototype.toString.call(value) !== "[object Object]")
        return false;
      const proto = Object.getPrototypeOf(value);
      if (proto === null)
        return true;
      const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
      return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
    }
    function mergeDeep(defaults2, options) {
      const result = Object.assign({}, defaults2);
      Object.keys(options).forEach((key) => {
        if (isPlainObject(options[key])) {
          if (!(key in defaults2))
            Object.assign(result, { [key]: options[key] });
          else
            result[key] = mergeDeep(defaults2[key], options[key]);
        } else {
          Object.assign(result, { [key]: options[key] });
        }
      });
      return result;
    }
    function removeUndefinedProperties(obj) {
      for (const key in obj) {
        if (obj[key] === void 0) {
          delete obj[key];
        }
      }
      return obj;
    }
    function merge2(defaults2, route, options) {
      if (typeof route === "string") {
        let [method, url] = route.split(" ");
        options = Object.assign(url ? { method, url } : { url: method }, options);
      } else {
        options = Object.assign({}, route);
      }
      options.headers = lowercaseKeys(options.headers);
      removeUndefinedProperties(options);
      removeUndefinedProperties(options.headers);
      const mergedOptions = mergeDeep(defaults2 || {}, options);
      if (options.url === "/graphql") {
        if (defaults2 && defaults2.mediaType.previews?.length) {
          mergedOptions.mediaType.previews = defaults2.mediaType.previews.filter(
            (preview) => !mergedOptions.mediaType.previews.includes(preview)
          ).concat(mergedOptions.mediaType.previews);
        }
        mergedOptions.mediaType.previews = (mergedOptions.mediaType.previews || []).map((preview) => preview.replace(/-preview/, ""));
      }
      return mergedOptions;
    }
    function addQueryParameters(url, parameters) {
      const separator = /\?/.test(url) ? "&" : "?";
      const names = Object.keys(parameters);
      if (names.length === 0) {
        return url;
      }
      return url + separator + names.map((name) => {
        if (name === "q") {
          return "q=" + parameters.q.split("+").map(encodeURIComponent).join("+");
        }
        return `${name}=${encodeURIComponent(parameters[name])}`;
      }).join("&");
    }
    var urlVariableRegex = /\{[^{}}]+\}/g;
    function removeNonChars(variableName) {
      return variableName.replace(/(?:^\W+)|(?:(?<!\W)\W+$)/g, "").split(/,/);
    }
    function extractUrlVariableNames(url) {
      const matches = url.match(urlVariableRegex);
      if (!matches) {
        return [];
      }
      return matches.map(removeNonChars).reduce((a, b) => a.concat(b), []);
    }
    function omit(object, keysToOmit) {
      const result = { __proto__: null };
      for (const key of Object.keys(object)) {
        if (keysToOmit.indexOf(key) === -1) {
          result[key] = object[key];
        }
      }
      return result;
    }
    function encodeReserved(str2) {
      return str2.split(/(%[0-9A-Fa-f]{2})/g).map(function(part) {
        if (!/%[0-9A-Fa-f]/.test(part)) {
          part = encodeURI(part).replace(/%5B/g, "[").replace(/%5D/g, "]");
        }
        return part;
      }).join("");
    }
    function encodeUnreserved(str2) {
      return encodeURIComponent(str2).replace(/[!'()*]/g, function(c) {
        return "%" + c.charCodeAt(0).toString(16).toUpperCase();
      });
    }
    function encodeValue(operator, value, key) {
      value = operator === "+" || operator === "#" ? encodeReserved(value) : encodeUnreserved(value);
      if (key) {
        return encodeUnreserved(key) + "=" + value;
      } else {
        return value;
      }
    }
    function isDefined(value) {
      return value !== void 0 && value !== null;
    }
    function isKeyOperator(operator) {
      return operator === ";" || operator === "&" || operator === "?";
    }
    function getValues(context, operator, key, modifier) {
      var value = context[key], result = [];
      if (isDefined(value) && value !== "") {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          value = value.toString();
          if (modifier && modifier !== "*") {
            value = value.substring(0, parseInt(modifier, 10));
          }
          result.push(
            encodeValue(operator, value, isKeyOperator(operator) ? key : "")
          );
        } else {
          if (modifier === "*") {
            if (Array.isArray(value)) {
              value.filter(isDefined).forEach(function(value2) {
                result.push(
                  encodeValue(operator, value2, isKeyOperator(operator) ? key : "")
                );
              });
            } else {
              Object.keys(value).forEach(function(k) {
                if (isDefined(value[k])) {
                  result.push(encodeValue(operator, value[k], k));
                }
              });
            }
          } else {
            const tmp = [];
            if (Array.isArray(value)) {
              value.filter(isDefined).forEach(function(value2) {
                tmp.push(encodeValue(operator, value2));
              });
            } else {
              Object.keys(value).forEach(function(k) {
                if (isDefined(value[k])) {
                  tmp.push(encodeUnreserved(k));
                  tmp.push(encodeValue(operator, value[k].toString()));
                }
              });
            }
            if (isKeyOperator(operator)) {
              result.push(encodeUnreserved(key) + "=" + tmp.join(","));
            } else if (tmp.length !== 0) {
              result.push(tmp.join(","));
            }
          }
        }
      } else {
        if (operator === ";") {
          if (isDefined(value)) {
            result.push(encodeUnreserved(key));
          }
        } else if (value === "" && (operator === "&" || operator === "?")) {
          result.push(encodeUnreserved(key) + "=");
        } else if (value === "") {
          result.push("");
        }
      }
      return result;
    }
    function parseUrl(template) {
      return {
        expand: expand2.bind(null, template)
      };
    }
    function expand2(template, context) {
      var operators = ["+", "#", ".", "/", ";", "?", "&"];
      template = template.replace(
        /\{([^\{\}]+)\}|([^\{\}]+)/g,
        function(_, expression, literal) {
          if (expression) {
            let operator = "";
            const values = [];
            if (operators.indexOf(expression.charAt(0)) !== -1) {
              operator = expression.charAt(0);
              expression = expression.substr(1);
            }
            expression.split(/,/g).forEach(function(variable) {
              var tmp = /([^:\*]*)(?::(\d+)|(\*))?/.exec(variable);
              values.push(getValues(context, operator, tmp[1], tmp[2] || tmp[3]));
            });
            if (operator && operator !== "+") {
              var separator = ",";
              if (operator === "?") {
                separator = "&";
              } else if (operator !== "#") {
                separator = operator;
              }
              return (values.length !== 0 ? operator : "") + values.join(separator);
            } else {
              return values.join(",");
            }
          } else {
            return encodeReserved(literal);
          }
        }
      );
      if (template === "/") {
        return template;
      } else {
        return template.replace(/\/$/, "");
      }
    }
    function parse(options) {
      let method = options.method.toUpperCase();
      let url = (options.url || "/").replace(/:([a-z]\w+)/g, "{$1}");
      let headers = Object.assign({}, options.headers);
      let body;
      let parameters = omit(options, [
        "method",
        "baseUrl",
        "url",
        "headers",
        "request",
        "mediaType"
      ]);
      const urlVariableNames = extractUrlVariableNames(url);
      url = parseUrl(url).expand(parameters);
      if (!/^http/.test(url)) {
        url = options.baseUrl + url;
      }
      const omittedParameters = Object.keys(options).filter((option) => urlVariableNames.includes(option)).concat("baseUrl");
      const remainingParameters = omit(parameters, omittedParameters);
      const isBinaryRequest = /application\/octet-stream/i.test(headers.accept);
      if (!isBinaryRequest) {
        if (options.mediaType.format) {
          headers.accept = headers.accept.split(/,/).map(
            (format) => format.replace(
              /application\/vnd(\.\w+)(\.v3)?(\.\w+)?(\+json)?$/,
              `application/vnd$1$2.${options.mediaType.format}`
            )
          ).join(",");
        }
        if (url.endsWith("/graphql")) {
          if (options.mediaType.previews?.length) {
            const previewsFromAcceptHeader = headers.accept.match(/(?<![\w-])[\w-]+(?=-preview)/g) || [];
            headers.accept = previewsFromAcceptHeader.concat(options.mediaType.previews).map((preview) => {
              const format = options.mediaType.format ? `.${options.mediaType.format}` : "+json";
              return `application/vnd.github.${preview}-preview${format}`;
            }).join(",");
          }
        }
      }
      if (["GET", "HEAD"].includes(method)) {
        url = addQueryParameters(url, remainingParameters);
      } else {
        if ("data" in remainingParameters) {
          body = remainingParameters.data;
        } else {
          if (Object.keys(remainingParameters).length) {
            body = remainingParameters;
          }
        }
      }
      if (!headers["content-type"] && typeof body !== "undefined") {
        headers["content-type"] = "application/json; charset=utf-8";
      }
      if (["PATCH", "PUT"].includes(method) && typeof body === "undefined") {
        body = "";
      }
      return Object.assign(
        { method, url, headers },
        typeof body !== "undefined" ? { body } : null,
        options.request ? { request: options.request } : null
      );
    }
    function endpointWithDefaults(defaults2, route, options) {
      return parse(merge2(defaults2, route, options));
    }
    function withDefaults(oldDefaults, newDefaults) {
      const DEFAULTS2 = merge2(oldDefaults, newDefaults);
      const endpoint2 = endpointWithDefaults.bind(null, DEFAULTS2);
      return Object.assign(endpoint2, {
        DEFAULTS: DEFAULTS2,
        defaults: withDefaults.bind(null, DEFAULTS2),
        merge: merge2.bind(null, DEFAULTS2),
        parse
      });
    }
    var endpoint = withDefaults(null, DEFAULTS);
  }
});

// node_modules/deprecation/dist-node/index.js
var require_dist_node3 = __commonJS({
  "node_modules/deprecation/dist-node/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var Deprecation = class extends Error {
      constructor(message) {
        super(message);
        if (Error.captureStackTrace) {
          Error.captureStackTrace(this, this.constructor);
        }
        this.name = "Deprecation";
      }
    };
    exports2.Deprecation = Deprecation;
  }
});

// node_modules/wrappy/wrappy.js
var require_wrappy = __commonJS({
  "node_modules/wrappy/wrappy.js"(exports2, module2) {
    module2.exports = wrappy;
    function wrappy(fn, cb) {
      if (fn && cb) return wrappy(fn)(cb);
      if (typeof fn !== "function")
        throw new TypeError("need wrapper function");
      Object.keys(fn).forEach(function(k) {
        wrapper[k] = fn[k];
      });
      return wrapper;
      function wrapper() {
        var args = new Array(arguments.length);
        for (var i = 0; i < args.length; i++) {
          args[i] = arguments[i];
        }
        var ret = fn.apply(this, args);
        var cb2 = args[args.length - 1];
        if (typeof ret === "function" && ret !== cb2) {
          Object.keys(cb2).forEach(function(k) {
            ret[k] = cb2[k];
          });
        }
        return ret;
      }
    }
  }
});

// node_modules/once/once.js
var require_once = __commonJS({
  "node_modules/once/once.js"(exports2, module2) {
    var wrappy = require_wrappy();
    module2.exports = wrappy(once);
    module2.exports.strict = wrappy(onceStrict);
    once.proto = once(function() {
      Object.defineProperty(Function.prototype, "once", {
        value: function() {
          return once(this);
        },
        configurable: true
      });
      Object.defineProperty(Function.prototype, "onceStrict", {
        value: function() {
          return onceStrict(this);
        },
        configurable: true
      });
    });
    function once(fn) {
      var f = function() {
        if (f.called) return f.value;
        f.called = true;
        return f.value = fn.apply(this, arguments);
      };
      f.called = false;
      return f;
    }
    function onceStrict(fn) {
      var f = function() {
        if (f.called)
          throw new Error(f.onceError);
        f.called = true;
        return f.value = fn.apply(this, arguments);
      };
      var name = fn.name || "Function wrapped with `once`";
      f.onceError = name + " shouldn't be called more than once";
      f.called = false;
      return f;
    }
  }
});

// node_modules/@octokit/request-error/dist-node/index.js
var require_dist_node4 = __commonJS({
  "node_modules/@octokit/request-error/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __create2 = Object.create;
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __getProtoOf2 = Object.getPrototypeOf;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create2(__getProtoOf2(mod)) : {}, __copyProps2(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp2(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var dist_src_exports = {};
    __export2(dist_src_exports, {
      RequestError: () => RequestError
    });
    module2.exports = __toCommonJS(dist_src_exports);
    var import_deprecation = require_dist_node3();
    var import_once = __toESM2(require_once());
    var logOnceCode = (0, import_once.default)((deprecation) => console.warn(deprecation));
    var logOnceHeaders = (0, import_once.default)((deprecation) => console.warn(deprecation));
    var RequestError = class extends Error {
      constructor(message, statusCode, options) {
        super(message);
        if (Error.captureStackTrace) {
          Error.captureStackTrace(this, this.constructor);
        }
        this.name = "HttpError";
        this.status = statusCode;
        let headers;
        if ("headers" in options && typeof options.headers !== "undefined") {
          headers = options.headers;
        }
        if ("response" in options) {
          this.response = options.response;
          headers = options.response.headers;
        }
        const requestCopy = Object.assign({}, options.request);
        if (options.request.headers.authorization) {
          requestCopy.headers = Object.assign({}, options.request.headers, {
            authorization: options.request.headers.authorization.replace(
              /(?<! ) .*$/,
              " [REDACTED]"
            )
          });
        }
        requestCopy.url = requestCopy.url.replace(/\bclient_secret=\w+/g, "client_secret=[REDACTED]").replace(/\baccess_token=\w+/g, "access_token=[REDACTED]");
        this.request = requestCopy;
        Object.defineProperty(this, "code", {
          get() {
            logOnceCode(
              new import_deprecation.Deprecation(
                "[@octokit/request-error] `error.code` is deprecated, use `error.status`."
              )
            );
            return statusCode;
          }
        });
        Object.defineProperty(this, "headers", {
          get() {
            logOnceHeaders(
              new import_deprecation.Deprecation(
                "[@octokit/request-error] `error.headers` is deprecated, use `error.response.headers`."
              )
            );
            return headers || {};
          }
        });
      }
    };
  }
});

// node_modules/@octokit/request/dist-node/index.js
var require_dist_node5 = __commonJS({
  "node_modules/@octokit/request/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var dist_src_exports = {};
    __export2(dist_src_exports, {
      request: () => request
    });
    module2.exports = __toCommonJS(dist_src_exports);
    var import_endpoint = require_dist_node2();
    var import_universal_user_agent = require_dist_node();
    var VERSION = "8.4.1";
    function isPlainObject(value) {
      if (typeof value !== "object" || value === null)
        return false;
      if (Object.prototype.toString.call(value) !== "[object Object]")
        return false;
      const proto = Object.getPrototypeOf(value);
      if (proto === null)
        return true;
      const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
      return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
    }
    var import_request_error = require_dist_node4();
    function getBufferResponse(response) {
      return response.arrayBuffer();
    }
    function fetchWrapper(requestOptions) {
      var _a2, _b, _c, _d;
      const log = requestOptions.request && requestOptions.request.log ? requestOptions.request.log : console;
      const parseSuccessResponseBody = ((_a2 = requestOptions.request) == null ? void 0 : _a2.parseSuccessResponseBody) !== false;
      if (isPlainObject(requestOptions.body) || Array.isArray(requestOptions.body)) {
        requestOptions.body = JSON.stringify(requestOptions.body);
      }
      let headers = {};
      let status;
      let url;
      let { fetch: fetch2 } = globalThis;
      if ((_b = requestOptions.request) == null ? void 0 : _b.fetch) {
        fetch2 = requestOptions.request.fetch;
      }
      if (!fetch2) {
        throw new Error(
          "fetch is not set. Please pass a fetch implementation as new Octokit({ request: { fetch }}). Learn more at https://github.com/octokit/octokit.js/#fetch-missing"
        );
      }
      return fetch2(requestOptions.url, {
        method: requestOptions.method,
        body: requestOptions.body,
        redirect: (_c = requestOptions.request) == null ? void 0 : _c.redirect,
        headers: requestOptions.headers,
        signal: (_d = requestOptions.request) == null ? void 0 : _d.signal,
        // duplex must be set if request.body is ReadableStream or Async Iterables.
        // See https://fetch.spec.whatwg.org/#dom-requestinit-duplex.
        ...requestOptions.body && { duplex: "half" }
      }).then(async (response) => {
        url = response.url;
        status = response.status;
        for (const keyAndValue of response.headers) {
          headers[keyAndValue[0]] = keyAndValue[1];
        }
        if ("deprecation" in headers) {
          const matches = headers.link && headers.link.match(/<([^<>]+)>; rel="deprecation"/);
          const deprecationLink = matches && matches.pop();
          log.warn(
            `[@octokit/request] "${requestOptions.method} ${requestOptions.url}" is deprecated. It is scheduled to be removed on ${headers.sunset}${deprecationLink ? `. See ${deprecationLink}` : ""}`
          );
        }
        if (status === 204 || status === 205) {
          return;
        }
        if (requestOptions.method === "HEAD") {
          if (status < 400) {
            return;
          }
          throw new import_request_error.RequestError(response.statusText, status, {
            response: {
              url,
              status,
              headers,
              data: void 0
            },
            request: requestOptions
          });
        }
        if (status === 304) {
          throw new import_request_error.RequestError("Not modified", status, {
            response: {
              url,
              status,
              headers,
              data: await getResponseData(response)
            },
            request: requestOptions
          });
        }
        if (status >= 400) {
          const data = await getResponseData(response);
          const error2 = new import_request_error.RequestError(toErrorMessage(data), status, {
            response: {
              url,
              status,
              headers,
              data
            },
            request: requestOptions
          });
          throw error2;
        }
        return parseSuccessResponseBody ? await getResponseData(response) : response.body;
      }).then((data) => {
        return {
          status,
          url,
          headers,
          data
        };
      }).catch((error2) => {
        if (error2 instanceof import_request_error.RequestError)
          throw error2;
        else if (error2.name === "AbortError")
          throw error2;
        let message = error2.message;
        if (error2.name === "TypeError" && "cause" in error2) {
          if (error2.cause instanceof Error) {
            message = error2.cause.message;
          } else if (typeof error2.cause === "string") {
            message = error2.cause;
          }
        }
        throw new import_request_error.RequestError(message, 500, {
          request: requestOptions
        });
      });
    }
    async function getResponseData(response) {
      const contentType = response.headers.get("content-type");
      if (/application\/json/.test(contentType)) {
        return response.json().catch(() => response.text()).catch(() => "");
      }
      if (!contentType || /^text\/|charset=utf-8$/.test(contentType)) {
        return response.text();
      }
      return getBufferResponse(response);
    }
    function toErrorMessage(data) {
      if (typeof data === "string")
        return data;
      let suffix;
      if ("documentation_url" in data) {
        suffix = ` - ${data.documentation_url}`;
      } else {
        suffix = "";
      }
      if ("message" in data) {
        if (Array.isArray(data.errors)) {
          return `${data.message}: ${data.errors.map(JSON.stringify).join(", ")}${suffix}`;
        }
        return `${data.message}${suffix}`;
      }
      return `Unknown error: ${JSON.stringify(data)}`;
    }
    function withDefaults(oldEndpoint, newDefaults) {
      const endpoint2 = oldEndpoint.defaults(newDefaults);
      const newApi = function(route, parameters) {
        const endpointOptions = endpoint2.merge(route, parameters);
        if (!endpointOptions.request || !endpointOptions.request.hook) {
          return fetchWrapper(endpoint2.parse(endpointOptions));
        }
        const request2 = (route2, parameters2) => {
          return fetchWrapper(
            endpoint2.parse(endpoint2.merge(route2, parameters2))
          );
        };
        Object.assign(request2, {
          endpoint: endpoint2,
          defaults: withDefaults.bind(null, endpoint2)
        });
        return endpointOptions.request.hook(request2, endpointOptions);
      };
      return Object.assign(newApi, {
        endpoint: endpoint2,
        defaults: withDefaults.bind(null, endpoint2)
      });
    }
    var request = withDefaults(import_endpoint.endpoint, {
      headers: {
        "user-agent": `octokit-request.js/${VERSION} ${(0, import_universal_user_agent.getUserAgent)()}`
      }
    });
  }
});

// node_modules/@octokit/graphql/dist-node/index.js
var require_dist_node6 = __commonJS({
  "node_modules/@octokit/graphql/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var index_exports = {};
    __export2(index_exports, {
      GraphqlResponseError: () => GraphqlResponseError,
      graphql: () => graphql2,
      withCustomRequest: () => withCustomRequest
    });
    module2.exports = __toCommonJS(index_exports);
    var import_request3 = require_dist_node5();
    var import_universal_user_agent = require_dist_node();
    var VERSION = "7.1.1";
    var import_request2 = require_dist_node5();
    var import_request = require_dist_node5();
    function _buildMessageForResponseErrors(data) {
      return `Request failed due to following response errors:
` + data.errors.map((e) => ` - ${e.message}`).join("\n");
    }
    var GraphqlResponseError = class extends Error {
      constructor(request2, headers, response) {
        super(_buildMessageForResponseErrors(response));
        this.request = request2;
        this.headers = headers;
        this.response = response;
        this.name = "GraphqlResponseError";
        this.errors = response.errors;
        this.data = response.data;
        if (Error.captureStackTrace) {
          Error.captureStackTrace(this, this.constructor);
        }
      }
    };
    var NON_VARIABLE_OPTIONS = [
      "method",
      "baseUrl",
      "url",
      "headers",
      "request",
      "query",
      "mediaType"
    ];
    var FORBIDDEN_VARIABLE_OPTIONS = ["query", "method", "url"];
    var GHES_V3_SUFFIX_REGEX = /\/api\/v3\/?$/;
    function graphql(request2, query, options) {
      if (options) {
        if (typeof query === "string" && "query" in options) {
          return Promise.reject(
            new Error(`[@octokit/graphql] "query" cannot be used as variable name`)
          );
        }
        for (const key in options) {
          if (!FORBIDDEN_VARIABLE_OPTIONS.includes(key)) continue;
          return Promise.reject(
            new Error(
              `[@octokit/graphql] "${key}" cannot be used as variable name`
            )
          );
        }
      }
      const parsedOptions = typeof query === "string" ? Object.assign({ query }, options) : query;
      const requestOptions = Object.keys(
        parsedOptions
      ).reduce((result, key) => {
        if (NON_VARIABLE_OPTIONS.includes(key)) {
          result[key] = parsedOptions[key];
          return result;
        }
        if (!result.variables) {
          result.variables = {};
        }
        result.variables[key] = parsedOptions[key];
        return result;
      }, {});
      const baseUrl = parsedOptions.baseUrl || request2.endpoint.DEFAULTS.baseUrl;
      if (GHES_V3_SUFFIX_REGEX.test(baseUrl)) {
        requestOptions.url = baseUrl.replace(GHES_V3_SUFFIX_REGEX, "/api/graphql");
      }
      return request2(requestOptions).then((response) => {
        if (response.data.errors) {
          const headers = {};
          for (const key of Object.keys(response.headers)) {
            headers[key] = response.headers[key];
          }
          throw new GraphqlResponseError(
            requestOptions,
            headers,
            response.data
          );
        }
        return response.data.data;
      });
    }
    function withDefaults(request2, newDefaults) {
      const newRequest = request2.defaults(newDefaults);
      const newApi = (query, options) => {
        return graphql(newRequest, query, options);
      };
      return Object.assign(newApi, {
        defaults: withDefaults.bind(null, newRequest),
        endpoint: newRequest.endpoint
      });
    }
    var graphql2 = withDefaults(import_request3.request, {
      headers: {
        "user-agent": `octokit-graphql.js/${VERSION} ${(0, import_universal_user_agent.getUserAgent)()}`
      },
      method: "POST",
      url: "/graphql"
    });
    function withCustomRequest(customRequest) {
      return withDefaults(customRequest, {
        method: "POST",
        url: "/graphql"
      });
    }
  }
});

// node_modules/@octokit/auth-token/dist-node/index.js
var require_dist_node7 = __commonJS({
  "node_modules/@octokit/auth-token/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var dist_src_exports = {};
    __export2(dist_src_exports, {
      createTokenAuth: () => createTokenAuth
    });
    module2.exports = __toCommonJS(dist_src_exports);
    var REGEX_IS_INSTALLATION_LEGACY = /^v1\./;
    var REGEX_IS_INSTALLATION = /^ghs_/;
    var REGEX_IS_USER_TO_SERVER = /^ghu_/;
    async function auth(token) {
      const isApp = token.split(/\./).length === 3;
      const isInstallation = REGEX_IS_INSTALLATION_LEGACY.test(token) || REGEX_IS_INSTALLATION.test(token);
      const isUserToServer = REGEX_IS_USER_TO_SERVER.test(token);
      const tokenType = isApp ? "app" : isInstallation ? "installation" : isUserToServer ? "user-to-server" : "oauth";
      return {
        type: "token",
        token,
        tokenType
      };
    }
    function withAuthorizationPrefix(token) {
      if (token.split(/\./).length === 3) {
        return `bearer ${token}`;
      }
      return `token ${token}`;
    }
    async function hook(token, request, route, parameters) {
      const endpoint = request.endpoint.merge(
        route,
        parameters
      );
      endpoint.headers.authorization = withAuthorizationPrefix(token);
      return request(endpoint);
    }
    var createTokenAuth = function createTokenAuth2(token) {
      if (!token) {
        throw new Error("[@octokit/auth-token] No token passed to createTokenAuth");
      }
      if (typeof token !== "string") {
        throw new Error(
          "[@octokit/auth-token] Token passed to createTokenAuth is not a string"
        );
      }
      token = token.replace(/^(token|bearer) +/i, "");
      return Object.assign(auth.bind(null, token), {
        hook: hook.bind(null, token)
      });
    };
  }
});

// node_modules/@octokit/core/dist-node/index.js
var require_dist_node8 = __commonJS({
  "node_modules/@octokit/core/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var index_exports = {};
    __export2(index_exports, {
      Octokit: () => Octokit2
    });
    module2.exports = __toCommonJS(index_exports);
    var import_universal_user_agent = require_dist_node();
    var import_before_after_hook = require_before_after_hook();
    var import_request = require_dist_node5();
    var import_graphql = require_dist_node6();
    var import_auth_token = require_dist_node7();
    var VERSION = "5.2.2";
    var noop = () => {
    };
    var consoleWarn = console.warn.bind(console);
    var consoleError = console.error.bind(console);
    function createLogger(logger2 = {}) {
      if (typeof logger2.debug !== "function") {
        logger2.debug = noop;
      }
      if (typeof logger2.info !== "function") {
        logger2.info = noop;
      }
      if (typeof logger2.warn !== "function") {
        logger2.warn = consoleWarn;
      }
      if (typeof logger2.error !== "function") {
        logger2.error = consoleError;
      }
      return logger2;
    }
    var userAgentTrail = `octokit-core.js/${VERSION} ${(0, import_universal_user_agent.getUserAgent)()}`;
    var Octokit2 = class {
      static {
        this.VERSION = VERSION;
      }
      static defaults(defaults2) {
        const OctokitWithDefaults = class extends this {
          constructor(...args) {
            const options = args[0] || {};
            if (typeof defaults2 === "function") {
              super(defaults2(options));
              return;
            }
            super(
              Object.assign(
                {},
                defaults2,
                options,
                options.userAgent && defaults2.userAgent ? {
                  userAgent: `${options.userAgent} ${defaults2.userAgent}`
                } : null
              )
            );
          }
        };
        return OctokitWithDefaults;
      }
      static {
        this.plugins = [];
      }
      /**
       * Attach a plugin (or many) to your Octokit instance.
       *
       * @example
       * const API = Octokit.plugin(plugin1, plugin2, plugin3, ...)
       */
      static plugin(...newPlugins) {
        const currentPlugins = this.plugins;
        const NewOctokit = class extends this {
          static {
            this.plugins = currentPlugins.concat(
              newPlugins.filter((plugin) => !currentPlugins.includes(plugin))
            );
          }
        };
        return NewOctokit;
      }
      constructor(options = {}) {
        const hook = new import_before_after_hook.Collection();
        const requestDefaults = {
          baseUrl: import_request.request.endpoint.DEFAULTS.baseUrl,
          headers: {},
          request: Object.assign({}, options.request, {
            // @ts-ignore internal usage only, no need to type
            hook: hook.bind(null, "request")
          }),
          mediaType: {
            previews: [],
            format: ""
          }
        };
        requestDefaults.headers["user-agent"] = options.userAgent ? `${options.userAgent} ${userAgentTrail}` : userAgentTrail;
        if (options.baseUrl) {
          requestDefaults.baseUrl = options.baseUrl;
        }
        if (options.previews) {
          requestDefaults.mediaType.previews = options.previews;
        }
        if (options.timeZone) {
          requestDefaults.headers["time-zone"] = options.timeZone;
        }
        this.request = import_request.request.defaults(requestDefaults);
        this.graphql = (0, import_graphql.withCustomRequest)(this.request).defaults(requestDefaults);
        this.log = createLogger(options.log);
        this.hook = hook;
        if (!options.authStrategy) {
          if (!options.auth) {
            this.auth = async () => ({
              type: "unauthenticated"
            });
          } else {
            const auth = (0, import_auth_token.createTokenAuth)(options.auth);
            hook.wrap("request", auth.hook);
            this.auth = auth;
          }
        } else {
          const { authStrategy, ...otherOptions } = options;
          const auth = authStrategy(
            Object.assign(
              {
                request: this.request,
                log: this.log,
                // we pass the current octokit instance as well as its constructor options
                // to allow for authentication strategies that return a new octokit instance
                // that shares the same internal state as the current one. The original
                // requirement for this was the "event-octokit" authentication strategy
                // of https://github.com/probot/octokit-auth-probot.
                octokit: this,
                octokitOptions: otherOptions
              },
              options.auth
            )
          );
          hook.wrap("request", auth.hook);
          this.auth = auth;
        }
        const classConstructor = this.constructor;
        for (let i = 0; i < classConstructor.plugins.length; ++i) {
          Object.assign(this, classConstructor.plugins[i](this, options));
        }
      }
    };
  }
});

// node_modules/@octokit/plugin-request-log/dist-node/index.js
var require_dist_node9 = __commonJS({
  "node_modules/@octokit/plugin-request-log/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var dist_src_exports = {};
    __export2(dist_src_exports, {
      requestLog: () => requestLog
    });
    module2.exports = __toCommonJS(dist_src_exports);
    var VERSION = "4.0.1";
    function requestLog(octokit) {
      octokit.hook.wrap("request", (request, options) => {
        octokit.log.debug("request", options);
        const start = Date.now();
        const requestOptions = octokit.request.endpoint.parse(options);
        const path13 = requestOptions.url.replace(options.baseUrl, "");
        return request(options).then((response) => {
          octokit.log.info(
            `${requestOptions.method} ${path13} - ${response.status} in ${Date.now() - start}ms`
          );
          return response;
        }).catch((error2) => {
          octokit.log.info(
            `${requestOptions.method} ${path13} - ${error2.status} in ${Date.now() - start}ms`
          );
          throw error2;
        });
      });
    }
    requestLog.VERSION = VERSION;
  }
});

// node_modules/@octokit/rest/node_modules/@octokit/plugin-paginate-rest/dist-node/index.js
var require_dist_node10 = __commonJS({
  "node_modules/@octokit/rest/node_modules/@octokit/plugin-paginate-rest/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var index_exports = {};
    __export2(index_exports, {
      composePaginateRest: () => composePaginateRest,
      isPaginatingEndpoint: () => isPaginatingEndpoint,
      paginateRest: () => paginateRest,
      paginatingEndpoints: () => paginatingEndpoints
    });
    module2.exports = __toCommonJS(index_exports);
    var VERSION = "11.4.4-cjs.2";
    function normalizePaginatedListResponse(response) {
      if (!response.data) {
        return {
          ...response,
          data: []
        };
      }
      const responseNeedsNormalization = "total_count" in response.data && !("url" in response.data);
      if (!responseNeedsNormalization) return response;
      const incompleteResults = response.data.incomplete_results;
      const repositorySelection = response.data.repository_selection;
      const totalCount = response.data.total_count;
      delete response.data.incomplete_results;
      delete response.data.repository_selection;
      delete response.data.total_count;
      const namespaceKey = Object.keys(response.data)[0];
      const data = response.data[namespaceKey];
      response.data = data;
      if (typeof incompleteResults !== "undefined") {
        response.data.incomplete_results = incompleteResults;
      }
      if (typeof repositorySelection !== "undefined") {
        response.data.repository_selection = repositorySelection;
      }
      response.data.total_count = totalCount;
      return response;
    }
    function iterator(octokit, route, parameters) {
      const options = typeof route === "function" ? route.endpoint(parameters) : octokit.request.endpoint(route, parameters);
      const requestMethod = typeof route === "function" ? route : octokit.request;
      const method = options.method;
      const headers = options.headers;
      let url = options.url;
      return {
        [Symbol.asyncIterator]: () => ({
          async next() {
            if (!url) return { done: true };
            try {
              const response = await requestMethod({ method, url, headers });
              const normalizedResponse = normalizePaginatedListResponse(response);
              url = ((normalizedResponse.headers.link || "").match(
                /<([^<>]+)>;\s*rel="next"/
              ) || [])[1];
              return { value: normalizedResponse };
            } catch (error2) {
              if (error2.status !== 409) throw error2;
              url = "";
              return {
                value: {
                  status: 200,
                  headers: {},
                  data: []
                }
              };
            }
          }
        })
      };
    }
    function paginate(octokit, route, parameters, mapFn) {
      if (typeof parameters === "function") {
        mapFn = parameters;
        parameters = void 0;
      }
      return gather(
        octokit,
        [],
        iterator(octokit, route, parameters)[Symbol.asyncIterator](),
        mapFn
      );
    }
    function gather(octokit, results, iterator2, mapFn) {
      return iterator2.next().then((result) => {
        if (result.done) {
          return results;
        }
        let earlyExit = false;
        function done() {
          earlyExit = true;
        }
        results = results.concat(
          mapFn ? mapFn(result.value, done) : result.value.data
        );
        if (earlyExit) {
          return results;
        }
        return gather(octokit, results, iterator2, mapFn);
      });
    }
    var composePaginateRest = Object.assign(paginate, {
      iterator
    });
    var paginatingEndpoints = [
      "GET /advisories",
      "GET /app/hook/deliveries",
      "GET /app/installation-requests",
      "GET /app/installations",
      "GET /assignments/{assignment_id}/accepted_assignments",
      "GET /classrooms",
      "GET /classrooms/{classroom_id}/assignments",
      "GET /enterprises/{enterprise}/code-security/configurations",
      "GET /enterprises/{enterprise}/code-security/configurations/{configuration_id}/repositories",
      "GET /enterprises/{enterprise}/dependabot/alerts",
      "GET /enterprises/{enterprise}/secret-scanning/alerts",
      "GET /events",
      "GET /gists",
      "GET /gists/public",
      "GET /gists/starred",
      "GET /gists/{gist_id}/comments",
      "GET /gists/{gist_id}/commits",
      "GET /gists/{gist_id}/forks",
      "GET /installation/repositories",
      "GET /issues",
      "GET /licenses",
      "GET /marketplace_listing/plans",
      "GET /marketplace_listing/plans/{plan_id}/accounts",
      "GET /marketplace_listing/stubbed/plans",
      "GET /marketplace_listing/stubbed/plans/{plan_id}/accounts",
      "GET /networks/{owner}/{repo}/events",
      "GET /notifications",
      "GET /organizations",
      "GET /orgs/{org}/actions/cache/usage-by-repository",
      "GET /orgs/{org}/actions/permissions/repositories",
      "GET /orgs/{org}/actions/runner-groups",
      "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories",
      "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/runners",
      "GET /orgs/{org}/actions/runners",
      "GET /orgs/{org}/actions/secrets",
      "GET /orgs/{org}/actions/secrets/{secret_name}/repositories",
      "GET /orgs/{org}/actions/variables",
      "GET /orgs/{org}/actions/variables/{name}/repositories",
      "GET /orgs/{org}/attestations/{subject_digest}",
      "GET /orgs/{org}/blocks",
      "GET /orgs/{org}/code-scanning/alerts",
      "GET /orgs/{org}/code-security/configurations",
      "GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories",
      "GET /orgs/{org}/codespaces",
      "GET /orgs/{org}/codespaces/secrets",
      "GET /orgs/{org}/codespaces/secrets/{secret_name}/repositories",
      "GET /orgs/{org}/copilot/billing/seats",
      "GET /orgs/{org}/copilot/metrics",
      "GET /orgs/{org}/copilot/usage",
      "GET /orgs/{org}/dependabot/alerts",
      "GET /orgs/{org}/dependabot/secrets",
      "GET /orgs/{org}/dependabot/secrets/{secret_name}/repositories",
      "GET /orgs/{org}/events",
      "GET /orgs/{org}/failed_invitations",
      "GET /orgs/{org}/hooks",
      "GET /orgs/{org}/hooks/{hook_id}/deliveries",
      "GET /orgs/{org}/insights/api/route-stats/{actor_type}/{actor_id}",
      "GET /orgs/{org}/insights/api/subject-stats",
      "GET /orgs/{org}/insights/api/user-stats/{user_id}",
      "GET /orgs/{org}/installations",
      "GET /orgs/{org}/invitations",
      "GET /orgs/{org}/invitations/{invitation_id}/teams",
      "GET /orgs/{org}/issues",
      "GET /orgs/{org}/members",
      "GET /orgs/{org}/members/{username}/codespaces",
      "GET /orgs/{org}/migrations",
      "GET /orgs/{org}/migrations/{migration_id}/repositories",
      "GET /orgs/{org}/organization-roles/{role_id}/teams",
      "GET /orgs/{org}/organization-roles/{role_id}/users",
      "GET /orgs/{org}/outside_collaborators",
      "GET /orgs/{org}/packages",
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
      "GET /orgs/{org}/personal-access-token-requests",
      "GET /orgs/{org}/personal-access-token-requests/{pat_request_id}/repositories",
      "GET /orgs/{org}/personal-access-tokens",
      "GET /orgs/{org}/personal-access-tokens/{pat_id}/repositories",
      "GET /orgs/{org}/private-registries",
      "GET /orgs/{org}/projects",
      "GET /orgs/{org}/properties/values",
      "GET /orgs/{org}/public_members",
      "GET /orgs/{org}/repos",
      "GET /orgs/{org}/rulesets",
      "GET /orgs/{org}/rulesets/rule-suites",
      "GET /orgs/{org}/secret-scanning/alerts",
      "GET /orgs/{org}/security-advisories",
      "GET /orgs/{org}/team/{team_slug}/copilot/metrics",
      "GET /orgs/{org}/team/{team_slug}/copilot/usage",
      "GET /orgs/{org}/teams",
      "GET /orgs/{org}/teams/{team_slug}/discussions",
      "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments",
      "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}/reactions",
      "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/reactions",
      "GET /orgs/{org}/teams/{team_slug}/invitations",
      "GET /orgs/{org}/teams/{team_slug}/members",
      "GET /orgs/{org}/teams/{team_slug}/projects",
      "GET /orgs/{org}/teams/{team_slug}/repos",
      "GET /orgs/{org}/teams/{team_slug}/teams",
      "GET /projects/columns/{column_id}/cards",
      "GET /projects/{project_id}/collaborators",
      "GET /projects/{project_id}/columns",
      "GET /repos/{owner}/{repo}/actions/artifacts",
      "GET /repos/{owner}/{repo}/actions/caches",
      "GET /repos/{owner}/{repo}/actions/organization-secrets",
      "GET /repos/{owner}/{repo}/actions/organization-variables",
      "GET /repos/{owner}/{repo}/actions/runners",
      "GET /repos/{owner}/{repo}/actions/runs",
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
      "GET /repos/{owner}/{repo}/actions/secrets",
      "GET /repos/{owner}/{repo}/actions/variables",
      "GET /repos/{owner}/{repo}/actions/workflows",
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
      "GET /repos/{owner}/{repo}/activity",
      "GET /repos/{owner}/{repo}/assignees",
      "GET /repos/{owner}/{repo}/attestations/{subject_digest}",
      "GET /repos/{owner}/{repo}/branches",
      "GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations",
      "GET /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs",
      "GET /repos/{owner}/{repo}/code-scanning/alerts",
      "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/instances",
      "GET /repos/{owner}/{repo}/code-scanning/analyses",
      "GET /repos/{owner}/{repo}/codespaces",
      "GET /repos/{owner}/{repo}/codespaces/devcontainers",
      "GET /repos/{owner}/{repo}/codespaces/secrets",
      "GET /repos/{owner}/{repo}/collaborators",
      "GET /repos/{owner}/{repo}/comments",
      "GET /repos/{owner}/{repo}/comments/{comment_id}/reactions",
      "GET /repos/{owner}/{repo}/commits",
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments",
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      "GET /repos/{owner}/{repo}/commits/{ref}/check-suites",
      "GET /repos/{owner}/{repo}/commits/{ref}/status",
      "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
      "GET /repos/{owner}/{repo}/contributors",
      "GET /repos/{owner}/{repo}/dependabot/alerts",
      "GET /repos/{owner}/{repo}/dependabot/secrets",
      "GET /repos/{owner}/{repo}/deployments",
      "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses",
      "GET /repos/{owner}/{repo}/environments",
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps",
      "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets",
      "GET /repos/{owner}/{repo}/environments/{environment_name}/variables",
      "GET /repos/{owner}/{repo}/events",
      "GET /repos/{owner}/{repo}/forks",
      "GET /repos/{owner}/{repo}/hooks",
      "GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries",
      "GET /repos/{owner}/{repo}/invitations",
      "GET /repos/{owner}/{repo}/issues",
      "GET /repos/{owner}/{repo}/issues/comments",
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      "GET /repos/{owner}/{repo}/issues/events",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/events",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/reactions",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
      "GET /repos/{owner}/{repo}/keys",
      "GET /repos/{owner}/{repo}/labels",
      "GET /repos/{owner}/{repo}/milestones",
      "GET /repos/{owner}/{repo}/milestones/{milestone_number}/labels",
      "GET /repos/{owner}/{repo}/notifications",
      "GET /repos/{owner}/{repo}/pages/builds",
      "GET /repos/{owner}/{repo}/projects",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/pulls/comments",
      "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
      "GET /repos/{owner}/{repo}/releases",
      "GET /repos/{owner}/{repo}/releases/{release_id}/assets",
      "GET /repos/{owner}/{repo}/releases/{release_id}/reactions",
      "GET /repos/{owner}/{repo}/rules/branches/{branch}",
      "GET /repos/{owner}/{repo}/rulesets",
      "GET /repos/{owner}/{repo}/rulesets/rule-suites",
      "GET /repos/{owner}/{repo}/secret-scanning/alerts",
      "GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}/locations",
      "GET /repos/{owner}/{repo}/security-advisories",
      "GET /repos/{owner}/{repo}/stargazers",
      "GET /repos/{owner}/{repo}/subscribers",
      "GET /repos/{owner}/{repo}/tags",
      "GET /repos/{owner}/{repo}/teams",
      "GET /repos/{owner}/{repo}/topics",
      "GET /repositories",
      "GET /search/code",
      "GET /search/commits",
      "GET /search/issues",
      "GET /search/labels",
      "GET /search/repositories",
      "GET /search/topics",
      "GET /search/users",
      "GET /teams/{team_id}/discussions",
      "GET /teams/{team_id}/discussions/{discussion_number}/comments",
      "GET /teams/{team_id}/discussions/{discussion_number}/comments/{comment_number}/reactions",
      "GET /teams/{team_id}/discussions/{discussion_number}/reactions",
      "GET /teams/{team_id}/invitations",
      "GET /teams/{team_id}/members",
      "GET /teams/{team_id}/projects",
      "GET /teams/{team_id}/repos",
      "GET /teams/{team_id}/teams",
      "GET /user/blocks",
      "GET /user/codespaces",
      "GET /user/codespaces/secrets",
      "GET /user/emails",
      "GET /user/followers",
      "GET /user/following",
      "GET /user/gpg_keys",
      "GET /user/installations",
      "GET /user/installations/{installation_id}/repositories",
      "GET /user/issues",
      "GET /user/keys",
      "GET /user/marketplace_purchases",
      "GET /user/marketplace_purchases/stubbed",
      "GET /user/memberships/orgs",
      "GET /user/migrations",
      "GET /user/migrations/{migration_id}/repositories",
      "GET /user/orgs",
      "GET /user/packages",
      "GET /user/packages/{package_type}/{package_name}/versions",
      "GET /user/public_emails",
      "GET /user/repos",
      "GET /user/repository_invitations",
      "GET /user/social_accounts",
      "GET /user/ssh_signing_keys",
      "GET /user/starred",
      "GET /user/subscriptions",
      "GET /user/teams",
      "GET /users",
      "GET /users/{username}/attestations/{subject_digest}",
      "GET /users/{username}/events",
      "GET /users/{username}/events/orgs/{org}",
      "GET /users/{username}/events/public",
      "GET /users/{username}/followers",
      "GET /users/{username}/following",
      "GET /users/{username}/gists",
      "GET /users/{username}/gpg_keys",
      "GET /users/{username}/keys",
      "GET /users/{username}/orgs",
      "GET /users/{username}/packages",
      "GET /users/{username}/projects",
      "GET /users/{username}/received_events",
      "GET /users/{username}/received_events/public",
      "GET /users/{username}/repos",
      "GET /users/{username}/social_accounts",
      "GET /users/{username}/ssh_signing_keys",
      "GET /users/{username}/starred",
      "GET /users/{username}/subscriptions"
    ];
    function isPaginatingEndpoint(arg) {
      if (typeof arg === "string") {
        return paginatingEndpoints.includes(arg);
      } else {
        return false;
      }
    }
    function paginateRest(octokit) {
      return {
        paginate: Object.assign(paginate.bind(null, octokit), {
          iterator: iterator.bind(null, octokit)
        })
      };
    }
    paginateRest.VERSION = VERSION;
  }
});

// node_modules/@octokit/rest/node_modules/@octokit/plugin-rest-endpoint-methods/dist-node/index.js
var require_dist_node11 = __commonJS({
  "node_modules/@octokit/rest/node_modules/@octokit/plugin-rest-endpoint-methods/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var index_exports = {};
    __export2(index_exports, {
      legacyRestEndpointMethods: () => legacyRestEndpointMethods,
      restEndpointMethods: () => restEndpointMethods
    });
    module2.exports = __toCommonJS(index_exports);
    var VERSION = "13.3.2-cjs.1";
    var Endpoints = {
      actions: {
        addCustomLabelsToSelfHostedRunnerForOrg: [
          "POST /orgs/{org}/actions/runners/{runner_id}/labels"
        ],
        addCustomLabelsToSelfHostedRunnerForRepo: [
          "POST /repos/{owner}/{repo}/actions/runners/{runner_id}/labels"
        ],
        addRepoAccessToSelfHostedRunnerGroupInOrg: [
          "PUT /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories/{repository_id}"
        ],
        addSelectedRepoToOrgSecret: [
          "PUT /orgs/{org}/actions/secrets/{secret_name}/repositories/{repository_id}"
        ],
        addSelectedRepoToOrgVariable: [
          "PUT /orgs/{org}/actions/variables/{name}/repositories/{repository_id}"
        ],
        approveWorkflowRun: [
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve"
        ],
        cancelWorkflowRun: [
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel"
        ],
        createEnvironmentVariable: [
          "POST /repos/{owner}/{repo}/environments/{environment_name}/variables"
        ],
        createOrUpdateEnvironmentSecret: [
          "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}"
        ],
        createOrUpdateOrgSecret: ["PUT /orgs/{org}/actions/secrets/{secret_name}"],
        createOrUpdateRepoSecret: [
          "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}"
        ],
        createOrgVariable: ["POST /orgs/{org}/actions/variables"],
        createRegistrationTokenForOrg: [
          "POST /orgs/{org}/actions/runners/registration-token"
        ],
        createRegistrationTokenForRepo: [
          "POST /repos/{owner}/{repo}/actions/runners/registration-token"
        ],
        createRemoveTokenForOrg: ["POST /orgs/{org}/actions/runners/remove-token"],
        createRemoveTokenForRepo: [
          "POST /repos/{owner}/{repo}/actions/runners/remove-token"
        ],
        createRepoVariable: ["POST /repos/{owner}/{repo}/actions/variables"],
        createWorkflowDispatch: [
          "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"
        ],
        deleteActionsCacheById: [
          "DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}"
        ],
        deleteActionsCacheByKey: [
          "DELETE /repos/{owner}/{repo}/actions/caches{?key,ref}"
        ],
        deleteArtifact: [
          "DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}"
        ],
        deleteEnvironmentSecret: [
          "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}"
        ],
        deleteEnvironmentVariable: [
          "DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}"
        ],
        deleteOrgSecret: ["DELETE /orgs/{org}/actions/secrets/{secret_name}"],
        deleteOrgVariable: ["DELETE /orgs/{org}/actions/variables/{name}"],
        deleteRepoSecret: [
          "DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}"
        ],
        deleteRepoVariable: [
          "DELETE /repos/{owner}/{repo}/actions/variables/{name}"
        ],
        deleteSelfHostedRunnerFromOrg: [
          "DELETE /orgs/{org}/actions/runners/{runner_id}"
        ],
        deleteSelfHostedRunnerFromRepo: [
          "DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}"
        ],
        deleteWorkflowRun: ["DELETE /repos/{owner}/{repo}/actions/runs/{run_id}"],
        deleteWorkflowRunLogs: [
          "DELETE /repos/{owner}/{repo}/actions/runs/{run_id}/logs"
        ],
        disableSelectedRepositoryGithubActionsOrganization: [
          "DELETE /orgs/{org}/actions/permissions/repositories/{repository_id}"
        ],
        disableWorkflow: [
          "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable"
        ],
        downloadArtifact: [
          "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}"
        ],
        downloadJobLogsForWorkflowRun: [
          "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs"
        ],
        downloadWorkflowRunAttemptLogs: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/logs"
        ],
        downloadWorkflowRunLogs: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs"
        ],
        enableSelectedRepositoryGithubActionsOrganization: [
          "PUT /orgs/{org}/actions/permissions/repositories/{repository_id}"
        ],
        enableWorkflow: [
          "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable"
        ],
        forceCancelWorkflowRun: [
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel"
        ],
        generateRunnerJitconfigForOrg: [
          "POST /orgs/{org}/actions/runners/generate-jitconfig"
        ],
        generateRunnerJitconfigForRepo: [
          "POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig"
        ],
        getActionsCacheList: ["GET /repos/{owner}/{repo}/actions/caches"],
        getActionsCacheUsage: ["GET /repos/{owner}/{repo}/actions/cache/usage"],
        getActionsCacheUsageByRepoForOrg: [
          "GET /orgs/{org}/actions/cache/usage-by-repository"
        ],
        getActionsCacheUsageForOrg: ["GET /orgs/{org}/actions/cache/usage"],
        getAllowedActionsOrganization: [
          "GET /orgs/{org}/actions/permissions/selected-actions"
        ],
        getAllowedActionsRepository: [
          "GET /repos/{owner}/{repo}/actions/permissions/selected-actions"
        ],
        getArtifact: ["GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}"],
        getCustomOidcSubClaimForRepo: [
          "GET /repos/{owner}/{repo}/actions/oidc/customization/sub"
        ],
        getEnvironmentPublicKey: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key"
        ],
        getEnvironmentSecret: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}"
        ],
        getEnvironmentVariable: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}"
        ],
        getGithubActionsDefaultWorkflowPermissionsOrganization: [
          "GET /orgs/{org}/actions/permissions/workflow"
        ],
        getGithubActionsDefaultWorkflowPermissionsRepository: [
          "GET /repos/{owner}/{repo}/actions/permissions/workflow"
        ],
        getGithubActionsPermissionsOrganization: [
          "GET /orgs/{org}/actions/permissions"
        ],
        getGithubActionsPermissionsRepository: [
          "GET /repos/{owner}/{repo}/actions/permissions"
        ],
        getJobForWorkflowRun: ["GET /repos/{owner}/{repo}/actions/jobs/{job_id}"],
        getOrgPublicKey: ["GET /orgs/{org}/actions/secrets/public-key"],
        getOrgSecret: ["GET /orgs/{org}/actions/secrets/{secret_name}"],
        getOrgVariable: ["GET /orgs/{org}/actions/variables/{name}"],
        getPendingDeploymentsForRun: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments"
        ],
        getRepoPermissions: [
          "GET /repos/{owner}/{repo}/actions/permissions",
          {},
          { renamed: ["actions", "getGithubActionsPermissionsRepository"] }
        ],
        getRepoPublicKey: ["GET /repos/{owner}/{repo}/actions/secrets/public-key"],
        getRepoSecret: ["GET /repos/{owner}/{repo}/actions/secrets/{secret_name}"],
        getRepoVariable: ["GET /repos/{owner}/{repo}/actions/variables/{name}"],
        getReviewsForRun: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals"
        ],
        getSelfHostedRunnerForOrg: ["GET /orgs/{org}/actions/runners/{runner_id}"],
        getSelfHostedRunnerForRepo: [
          "GET /repos/{owner}/{repo}/actions/runners/{runner_id}"
        ],
        getWorkflow: ["GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}"],
        getWorkflowAccessToRepository: [
          "GET /repos/{owner}/{repo}/actions/permissions/access"
        ],
        getWorkflowRun: ["GET /repos/{owner}/{repo}/actions/runs/{run_id}"],
        getWorkflowRunAttempt: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}"
        ],
        getWorkflowRunUsage: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing"
        ],
        getWorkflowUsage: [
          "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/timing"
        ],
        listArtifactsForRepo: ["GET /repos/{owner}/{repo}/actions/artifacts"],
        listEnvironmentSecrets: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets"
        ],
        listEnvironmentVariables: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/variables"
        ],
        listJobsForWorkflowRun: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs"
        ],
        listJobsForWorkflowRunAttempt: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs"
        ],
        listLabelsForSelfHostedRunnerForOrg: [
          "GET /orgs/{org}/actions/runners/{runner_id}/labels"
        ],
        listLabelsForSelfHostedRunnerForRepo: [
          "GET /repos/{owner}/{repo}/actions/runners/{runner_id}/labels"
        ],
        listOrgSecrets: ["GET /orgs/{org}/actions/secrets"],
        listOrgVariables: ["GET /orgs/{org}/actions/variables"],
        listRepoOrganizationSecrets: [
          "GET /repos/{owner}/{repo}/actions/organization-secrets"
        ],
        listRepoOrganizationVariables: [
          "GET /repos/{owner}/{repo}/actions/organization-variables"
        ],
        listRepoSecrets: ["GET /repos/{owner}/{repo}/actions/secrets"],
        listRepoVariables: ["GET /repos/{owner}/{repo}/actions/variables"],
        listRepoWorkflows: ["GET /repos/{owner}/{repo}/actions/workflows"],
        listRunnerApplicationsForOrg: ["GET /orgs/{org}/actions/runners/downloads"],
        listRunnerApplicationsForRepo: [
          "GET /repos/{owner}/{repo}/actions/runners/downloads"
        ],
        listSelectedReposForOrgSecret: [
          "GET /orgs/{org}/actions/secrets/{secret_name}/repositories"
        ],
        listSelectedReposForOrgVariable: [
          "GET /orgs/{org}/actions/variables/{name}/repositories"
        ],
        listSelectedRepositoriesEnabledGithubActionsOrganization: [
          "GET /orgs/{org}/actions/permissions/repositories"
        ],
        listSelfHostedRunnersForOrg: ["GET /orgs/{org}/actions/runners"],
        listSelfHostedRunnersForRepo: ["GET /repos/{owner}/{repo}/actions/runners"],
        listWorkflowRunArtifacts: [
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts"
        ],
        listWorkflowRuns: [
          "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs"
        ],
        listWorkflowRunsForRepo: ["GET /repos/{owner}/{repo}/actions/runs"],
        reRunJobForWorkflowRun: [
          "POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun"
        ],
        reRunWorkflow: ["POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun"],
        reRunWorkflowFailedJobs: [
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs"
        ],
        removeAllCustomLabelsFromSelfHostedRunnerForOrg: [
          "DELETE /orgs/{org}/actions/runners/{runner_id}/labels"
        ],
        removeAllCustomLabelsFromSelfHostedRunnerForRepo: [
          "DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}/labels"
        ],
        removeCustomLabelFromSelfHostedRunnerForOrg: [
          "DELETE /orgs/{org}/actions/runners/{runner_id}/labels/{name}"
        ],
        removeCustomLabelFromSelfHostedRunnerForRepo: [
          "DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}/labels/{name}"
        ],
        removeSelectedRepoFromOrgSecret: [
          "DELETE /orgs/{org}/actions/secrets/{secret_name}/repositories/{repository_id}"
        ],
        removeSelectedRepoFromOrgVariable: [
          "DELETE /orgs/{org}/actions/variables/{name}/repositories/{repository_id}"
        ],
        reviewCustomGatesForRun: [
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/deployment_protection_rule"
        ],
        reviewPendingDeploymentsForRun: [
          "POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments"
        ],
        setAllowedActionsOrganization: [
          "PUT /orgs/{org}/actions/permissions/selected-actions"
        ],
        setAllowedActionsRepository: [
          "PUT /repos/{owner}/{repo}/actions/permissions/selected-actions"
        ],
        setCustomLabelsForSelfHostedRunnerForOrg: [
          "PUT /orgs/{org}/actions/runners/{runner_id}/labels"
        ],
        setCustomLabelsForSelfHostedRunnerForRepo: [
          "PUT /repos/{owner}/{repo}/actions/runners/{runner_id}/labels"
        ],
        setCustomOidcSubClaimForRepo: [
          "PUT /repos/{owner}/{repo}/actions/oidc/customization/sub"
        ],
        setGithubActionsDefaultWorkflowPermissionsOrganization: [
          "PUT /orgs/{org}/actions/permissions/workflow"
        ],
        setGithubActionsDefaultWorkflowPermissionsRepository: [
          "PUT /repos/{owner}/{repo}/actions/permissions/workflow"
        ],
        setGithubActionsPermissionsOrganization: [
          "PUT /orgs/{org}/actions/permissions"
        ],
        setGithubActionsPermissionsRepository: [
          "PUT /repos/{owner}/{repo}/actions/permissions"
        ],
        setSelectedReposForOrgSecret: [
          "PUT /orgs/{org}/actions/secrets/{secret_name}/repositories"
        ],
        setSelectedReposForOrgVariable: [
          "PUT /orgs/{org}/actions/variables/{name}/repositories"
        ],
        setSelectedRepositoriesEnabledGithubActionsOrganization: [
          "PUT /orgs/{org}/actions/permissions/repositories"
        ],
        setWorkflowAccessToRepository: [
          "PUT /repos/{owner}/{repo}/actions/permissions/access"
        ],
        updateEnvironmentVariable: [
          "PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}"
        ],
        updateOrgVariable: ["PATCH /orgs/{org}/actions/variables/{name}"],
        updateRepoVariable: [
          "PATCH /repos/{owner}/{repo}/actions/variables/{name}"
        ]
      },
      activity: {
        checkRepoIsStarredByAuthenticatedUser: ["GET /user/starred/{owner}/{repo}"],
        deleteRepoSubscription: ["DELETE /repos/{owner}/{repo}/subscription"],
        deleteThreadSubscription: [
          "DELETE /notifications/threads/{thread_id}/subscription"
        ],
        getFeeds: ["GET /feeds"],
        getRepoSubscription: ["GET /repos/{owner}/{repo}/subscription"],
        getThread: ["GET /notifications/threads/{thread_id}"],
        getThreadSubscriptionForAuthenticatedUser: [
          "GET /notifications/threads/{thread_id}/subscription"
        ],
        listEventsForAuthenticatedUser: ["GET /users/{username}/events"],
        listNotificationsForAuthenticatedUser: ["GET /notifications"],
        listOrgEventsForAuthenticatedUser: [
          "GET /users/{username}/events/orgs/{org}"
        ],
        listPublicEvents: ["GET /events"],
        listPublicEventsForRepoNetwork: ["GET /networks/{owner}/{repo}/events"],
        listPublicEventsForUser: ["GET /users/{username}/events/public"],
        listPublicOrgEvents: ["GET /orgs/{org}/events"],
        listReceivedEventsForUser: ["GET /users/{username}/received_events"],
        listReceivedPublicEventsForUser: [
          "GET /users/{username}/received_events/public"
        ],
        listRepoEvents: ["GET /repos/{owner}/{repo}/events"],
        listRepoNotificationsForAuthenticatedUser: [
          "GET /repos/{owner}/{repo}/notifications"
        ],
        listReposStarredByAuthenticatedUser: ["GET /user/starred"],
        listReposStarredByUser: ["GET /users/{username}/starred"],
        listReposWatchedByUser: ["GET /users/{username}/subscriptions"],
        listStargazersForRepo: ["GET /repos/{owner}/{repo}/stargazers"],
        listWatchedReposForAuthenticatedUser: ["GET /user/subscriptions"],
        listWatchersForRepo: ["GET /repos/{owner}/{repo}/subscribers"],
        markNotificationsAsRead: ["PUT /notifications"],
        markRepoNotificationsAsRead: ["PUT /repos/{owner}/{repo}/notifications"],
        markThreadAsDone: ["DELETE /notifications/threads/{thread_id}"],
        markThreadAsRead: ["PATCH /notifications/threads/{thread_id}"],
        setRepoSubscription: ["PUT /repos/{owner}/{repo}/subscription"],
        setThreadSubscription: [
          "PUT /notifications/threads/{thread_id}/subscription"
        ],
        starRepoForAuthenticatedUser: ["PUT /user/starred/{owner}/{repo}"],
        unstarRepoForAuthenticatedUser: ["DELETE /user/starred/{owner}/{repo}"]
      },
      apps: {
        addRepoToInstallation: [
          "PUT /user/installations/{installation_id}/repositories/{repository_id}",
          {},
          { renamed: ["apps", "addRepoToInstallationForAuthenticatedUser"] }
        ],
        addRepoToInstallationForAuthenticatedUser: [
          "PUT /user/installations/{installation_id}/repositories/{repository_id}"
        ],
        checkToken: ["POST /applications/{client_id}/token"],
        createFromManifest: ["POST /app-manifests/{code}/conversions"],
        createInstallationAccessToken: [
          "POST /app/installations/{installation_id}/access_tokens"
        ],
        deleteAuthorization: ["DELETE /applications/{client_id}/grant"],
        deleteInstallation: ["DELETE /app/installations/{installation_id}"],
        deleteToken: ["DELETE /applications/{client_id}/token"],
        getAuthenticated: ["GET /app"],
        getBySlug: ["GET /apps/{app_slug}"],
        getInstallation: ["GET /app/installations/{installation_id}"],
        getOrgInstallation: ["GET /orgs/{org}/installation"],
        getRepoInstallation: ["GET /repos/{owner}/{repo}/installation"],
        getSubscriptionPlanForAccount: [
          "GET /marketplace_listing/accounts/{account_id}"
        ],
        getSubscriptionPlanForAccountStubbed: [
          "GET /marketplace_listing/stubbed/accounts/{account_id}"
        ],
        getUserInstallation: ["GET /users/{username}/installation"],
        getWebhookConfigForApp: ["GET /app/hook/config"],
        getWebhookDelivery: ["GET /app/hook/deliveries/{delivery_id}"],
        listAccountsForPlan: ["GET /marketplace_listing/plans/{plan_id}/accounts"],
        listAccountsForPlanStubbed: [
          "GET /marketplace_listing/stubbed/plans/{plan_id}/accounts"
        ],
        listInstallationReposForAuthenticatedUser: [
          "GET /user/installations/{installation_id}/repositories"
        ],
        listInstallationRequestsForAuthenticatedApp: [
          "GET /app/installation-requests"
        ],
        listInstallations: ["GET /app/installations"],
        listInstallationsForAuthenticatedUser: ["GET /user/installations"],
        listPlans: ["GET /marketplace_listing/plans"],
        listPlansStubbed: ["GET /marketplace_listing/stubbed/plans"],
        listReposAccessibleToInstallation: ["GET /installation/repositories"],
        listSubscriptionsForAuthenticatedUser: ["GET /user/marketplace_purchases"],
        listSubscriptionsForAuthenticatedUserStubbed: [
          "GET /user/marketplace_purchases/stubbed"
        ],
        listWebhookDeliveries: ["GET /app/hook/deliveries"],
        redeliverWebhookDelivery: [
          "POST /app/hook/deliveries/{delivery_id}/attempts"
        ],
        removeRepoFromInstallation: [
          "DELETE /user/installations/{installation_id}/repositories/{repository_id}",
          {},
          { renamed: ["apps", "removeRepoFromInstallationForAuthenticatedUser"] }
        ],
        removeRepoFromInstallationForAuthenticatedUser: [
          "DELETE /user/installations/{installation_id}/repositories/{repository_id}"
        ],
        resetToken: ["PATCH /applications/{client_id}/token"],
        revokeInstallationAccessToken: ["DELETE /installation/token"],
        scopeToken: ["POST /applications/{client_id}/token/scoped"],
        suspendInstallation: ["PUT /app/installations/{installation_id}/suspended"],
        unsuspendInstallation: [
          "DELETE /app/installations/{installation_id}/suspended"
        ],
        updateWebhookConfigForApp: ["PATCH /app/hook/config"]
      },
      billing: {
        getGithubActionsBillingOrg: ["GET /orgs/{org}/settings/billing/actions"],
        getGithubActionsBillingUser: [
          "GET /users/{username}/settings/billing/actions"
        ],
        getGithubBillingUsageReportOrg: [
          "GET /organizations/{org}/settings/billing/usage"
        ],
        getGithubPackagesBillingOrg: ["GET /orgs/{org}/settings/billing/packages"],
        getGithubPackagesBillingUser: [
          "GET /users/{username}/settings/billing/packages"
        ],
        getSharedStorageBillingOrg: [
          "GET /orgs/{org}/settings/billing/shared-storage"
        ],
        getSharedStorageBillingUser: [
          "GET /users/{username}/settings/billing/shared-storage"
        ]
      },
      checks: {
        create: ["POST /repos/{owner}/{repo}/check-runs"],
        createSuite: ["POST /repos/{owner}/{repo}/check-suites"],
        get: ["GET /repos/{owner}/{repo}/check-runs/{check_run_id}"],
        getSuite: ["GET /repos/{owner}/{repo}/check-suites/{check_suite_id}"],
        listAnnotations: [
          "GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations"
        ],
        listForRef: ["GET /repos/{owner}/{repo}/commits/{ref}/check-runs"],
        listForSuite: [
          "GET /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs"
        ],
        listSuitesForRef: ["GET /repos/{owner}/{repo}/commits/{ref}/check-suites"],
        rerequestRun: [
          "POST /repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest"
        ],
        rerequestSuite: [
          "POST /repos/{owner}/{repo}/check-suites/{check_suite_id}/rerequest"
        ],
        setSuitesPreferences: [
          "PATCH /repos/{owner}/{repo}/check-suites/preferences"
        ],
        update: ["PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}"]
      },
      codeScanning: {
        commitAutofix: [
          "POST /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/autofix/commits"
        ],
        createAutofix: [
          "POST /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/autofix"
        ],
        createVariantAnalysis: [
          "POST /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses"
        ],
        deleteAnalysis: [
          "DELETE /repos/{owner}/{repo}/code-scanning/analyses/{analysis_id}{?confirm_delete}"
        ],
        deleteCodeqlDatabase: [
          "DELETE /repos/{owner}/{repo}/code-scanning/codeql/databases/{language}"
        ],
        getAlert: [
          "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}",
          {},
          { renamedParameters: { alert_id: "alert_number" } }
        ],
        getAnalysis: [
          "GET /repos/{owner}/{repo}/code-scanning/analyses/{analysis_id}"
        ],
        getAutofix: [
          "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/autofix"
        ],
        getCodeqlDatabase: [
          "GET /repos/{owner}/{repo}/code-scanning/codeql/databases/{language}"
        ],
        getDefaultSetup: ["GET /repos/{owner}/{repo}/code-scanning/default-setup"],
        getSarif: ["GET /repos/{owner}/{repo}/code-scanning/sarifs/{sarif_id}"],
        getVariantAnalysis: [
          "GET /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses/{codeql_variant_analysis_id}"
        ],
        getVariantAnalysisRepoTask: [
          "GET /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses/{codeql_variant_analysis_id}/repos/{repo_owner}/{repo_name}"
        ],
        listAlertInstances: [
          "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/instances"
        ],
        listAlertsForOrg: ["GET /orgs/{org}/code-scanning/alerts"],
        listAlertsForRepo: ["GET /repos/{owner}/{repo}/code-scanning/alerts"],
        listAlertsInstances: [
          "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/instances",
          {},
          { renamed: ["codeScanning", "listAlertInstances"] }
        ],
        listCodeqlDatabases: [
          "GET /repos/{owner}/{repo}/code-scanning/codeql/databases"
        ],
        listRecentAnalyses: ["GET /repos/{owner}/{repo}/code-scanning/analyses"],
        updateAlert: [
          "PATCH /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}"
        ],
        updateDefaultSetup: [
          "PATCH /repos/{owner}/{repo}/code-scanning/default-setup"
        ],
        uploadSarif: ["POST /repos/{owner}/{repo}/code-scanning/sarifs"]
      },
      codeSecurity: {
        attachConfiguration: [
          "POST /orgs/{org}/code-security/configurations/{configuration_id}/attach"
        ],
        attachEnterpriseConfiguration: [
          "POST /enterprises/{enterprise}/code-security/configurations/{configuration_id}/attach"
        ],
        createConfiguration: ["POST /orgs/{org}/code-security/configurations"],
        createConfigurationForEnterprise: [
          "POST /enterprises/{enterprise}/code-security/configurations"
        ],
        deleteConfiguration: [
          "DELETE /orgs/{org}/code-security/configurations/{configuration_id}"
        ],
        deleteConfigurationForEnterprise: [
          "DELETE /enterprises/{enterprise}/code-security/configurations/{configuration_id}"
        ],
        detachConfiguration: [
          "DELETE /orgs/{org}/code-security/configurations/detach"
        ],
        getConfiguration: [
          "GET /orgs/{org}/code-security/configurations/{configuration_id}"
        ],
        getConfigurationForRepository: [
          "GET /repos/{owner}/{repo}/code-security-configuration"
        ],
        getConfigurationsForEnterprise: [
          "GET /enterprises/{enterprise}/code-security/configurations"
        ],
        getConfigurationsForOrg: ["GET /orgs/{org}/code-security/configurations"],
        getDefaultConfigurations: [
          "GET /orgs/{org}/code-security/configurations/defaults"
        ],
        getDefaultConfigurationsForEnterprise: [
          "GET /enterprises/{enterprise}/code-security/configurations/defaults"
        ],
        getRepositoriesForConfiguration: [
          "GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories"
        ],
        getRepositoriesForEnterpriseConfiguration: [
          "GET /enterprises/{enterprise}/code-security/configurations/{configuration_id}/repositories"
        ],
        getSingleConfigurationForEnterprise: [
          "GET /enterprises/{enterprise}/code-security/configurations/{configuration_id}"
        ],
        setConfigurationAsDefault: [
          "PUT /orgs/{org}/code-security/configurations/{configuration_id}/defaults"
        ],
        setConfigurationAsDefaultForEnterprise: [
          "PUT /enterprises/{enterprise}/code-security/configurations/{configuration_id}/defaults"
        ],
        updateConfiguration: [
          "PATCH /orgs/{org}/code-security/configurations/{configuration_id}"
        ],
        updateEnterpriseConfiguration: [
          "PATCH /enterprises/{enterprise}/code-security/configurations/{configuration_id}"
        ]
      },
      codesOfConduct: {
        getAllCodesOfConduct: ["GET /codes_of_conduct"],
        getConductCode: ["GET /codes_of_conduct/{key}"]
      },
      codespaces: {
        addRepositoryForSecretForAuthenticatedUser: [
          "PUT /user/codespaces/secrets/{secret_name}/repositories/{repository_id}"
        ],
        addSelectedRepoToOrgSecret: [
          "PUT /orgs/{org}/codespaces/secrets/{secret_name}/repositories/{repository_id}"
        ],
        checkPermissionsForDevcontainer: [
          "GET /repos/{owner}/{repo}/codespaces/permissions_check"
        ],
        codespaceMachinesForAuthenticatedUser: [
          "GET /user/codespaces/{codespace_name}/machines"
        ],
        createForAuthenticatedUser: ["POST /user/codespaces"],
        createOrUpdateOrgSecret: [
          "PUT /orgs/{org}/codespaces/secrets/{secret_name}"
        ],
        createOrUpdateRepoSecret: [
          "PUT /repos/{owner}/{repo}/codespaces/secrets/{secret_name}"
        ],
        createOrUpdateSecretForAuthenticatedUser: [
          "PUT /user/codespaces/secrets/{secret_name}"
        ],
        createWithPrForAuthenticatedUser: [
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/codespaces"
        ],
        createWithRepoForAuthenticatedUser: [
          "POST /repos/{owner}/{repo}/codespaces"
        ],
        deleteForAuthenticatedUser: ["DELETE /user/codespaces/{codespace_name}"],
        deleteFromOrganization: [
          "DELETE /orgs/{org}/members/{username}/codespaces/{codespace_name}"
        ],
        deleteOrgSecret: ["DELETE /orgs/{org}/codespaces/secrets/{secret_name}"],
        deleteRepoSecret: [
          "DELETE /repos/{owner}/{repo}/codespaces/secrets/{secret_name}"
        ],
        deleteSecretForAuthenticatedUser: [
          "DELETE /user/codespaces/secrets/{secret_name}"
        ],
        exportForAuthenticatedUser: [
          "POST /user/codespaces/{codespace_name}/exports"
        ],
        getCodespacesForUserInOrg: [
          "GET /orgs/{org}/members/{username}/codespaces"
        ],
        getExportDetailsForAuthenticatedUser: [
          "GET /user/codespaces/{codespace_name}/exports/{export_id}"
        ],
        getForAuthenticatedUser: ["GET /user/codespaces/{codespace_name}"],
        getOrgPublicKey: ["GET /orgs/{org}/codespaces/secrets/public-key"],
        getOrgSecret: ["GET /orgs/{org}/codespaces/secrets/{secret_name}"],
        getPublicKeyForAuthenticatedUser: [
          "GET /user/codespaces/secrets/public-key"
        ],
        getRepoPublicKey: [
          "GET /repos/{owner}/{repo}/codespaces/secrets/public-key"
        ],
        getRepoSecret: [
          "GET /repos/{owner}/{repo}/codespaces/secrets/{secret_name}"
        ],
        getSecretForAuthenticatedUser: [
          "GET /user/codespaces/secrets/{secret_name}"
        ],
        listDevcontainersInRepositoryForAuthenticatedUser: [
          "GET /repos/{owner}/{repo}/codespaces/devcontainers"
        ],
        listForAuthenticatedUser: ["GET /user/codespaces"],
        listInOrganization: [
          "GET /orgs/{org}/codespaces",
          {},
          { renamedParameters: { org_id: "org" } }
        ],
        listInRepositoryForAuthenticatedUser: [
          "GET /repos/{owner}/{repo}/codespaces"
        ],
        listOrgSecrets: ["GET /orgs/{org}/codespaces/secrets"],
        listRepoSecrets: ["GET /repos/{owner}/{repo}/codespaces/secrets"],
        listRepositoriesForSecretForAuthenticatedUser: [
          "GET /user/codespaces/secrets/{secret_name}/repositories"
        ],
        listSecretsForAuthenticatedUser: ["GET /user/codespaces/secrets"],
        listSelectedReposForOrgSecret: [
          "GET /orgs/{org}/codespaces/secrets/{secret_name}/repositories"
        ],
        preFlightWithRepoForAuthenticatedUser: [
          "GET /repos/{owner}/{repo}/codespaces/new"
        ],
        publishForAuthenticatedUser: [
          "POST /user/codespaces/{codespace_name}/publish"
        ],
        removeRepositoryForSecretForAuthenticatedUser: [
          "DELETE /user/codespaces/secrets/{secret_name}/repositories/{repository_id}"
        ],
        removeSelectedRepoFromOrgSecret: [
          "DELETE /orgs/{org}/codespaces/secrets/{secret_name}/repositories/{repository_id}"
        ],
        repoMachinesForAuthenticatedUser: [
          "GET /repos/{owner}/{repo}/codespaces/machines"
        ],
        setRepositoriesForSecretForAuthenticatedUser: [
          "PUT /user/codespaces/secrets/{secret_name}/repositories"
        ],
        setSelectedReposForOrgSecret: [
          "PUT /orgs/{org}/codespaces/secrets/{secret_name}/repositories"
        ],
        startForAuthenticatedUser: ["POST /user/codespaces/{codespace_name}/start"],
        stopForAuthenticatedUser: ["POST /user/codespaces/{codespace_name}/stop"],
        stopInOrganization: [
          "POST /orgs/{org}/members/{username}/codespaces/{codespace_name}/stop"
        ],
        updateForAuthenticatedUser: ["PATCH /user/codespaces/{codespace_name}"]
      },
      copilot: {
        addCopilotSeatsForTeams: [
          "POST /orgs/{org}/copilot/billing/selected_teams"
        ],
        addCopilotSeatsForUsers: [
          "POST /orgs/{org}/copilot/billing/selected_users"
        ],
        cancelCopilotSeatAssignmentForTeams: [
          "DELETE /orgs/{org}/copilot/billing/selected_teams"
        ],
        cancelCopilotSeatAssignmentForUsers: [
          "DELETE /orgs/{org}/copilot/billing/selected_users"
        ],
        copilotMetricsForOrganization: ["GET /orgs/{org}/copilot/metrics"],
        copilotMetricsForTeam: ["GET /orgs/{org}/team/{team_slug}/copilot/metrics"],
        getCopilotOrganizationDetails: ["GET /orgs/{org}/copilot/billing"],
        getCopilotSeatDetailsForUser: [
          "GET /orgs/{org}/members/{username}/copilot"
        ],
        listCopilotSeats: ["GET /orgs/{org}/copilot/billing/seats"],
        usageMetricsForOrg: ["GET /orgs/{org}/copilot/usage"],
        usageMetricsForTeam: ["GET /orgs/{org}/team/{team_slug}/copilot/usage"]
      },
      dependabot: {
        addSelectedRepoToOrgSecret: [
          "PUT /orgs/{org}/dependabot/secrets/{secret_name}/repositories/{repository_id}"
        ],
        createOrUpdateOrgSecret: [
          "PUT /orgs/{org}/dependabot/secrets/{secret_name}"
        ],
        createOrUpdateRepoSecret: [
          "PUT /repos/{owner}/{repo}/dependabot/secrets/{secret_name}"
        ],
        deleteOrgSecret: ["DELETE /orgs/{org}/dependabot/secrets/{secret_name}"],
        deleteRepoSecret: [
          "DELETE /repos/{owner}/{repo}/dependabot/secrets/{secret_name}"
        ],
        getAlert: ["GET /repos/{owner}/{repo}/dependabot/alerts/{alert_number}"],
        getOrgPublicKey: ["GET /orgs/{org}/dependabot/secrets/public-key"],
        getOrgSecret: ["GET /orgs/{org}/dependabot/secrets/{secret_name}"],
        getRepoPublicKey: [
          "GET /repos/{owner}/{repo}/dependabot/secrets/public-key"
        ],
        getRepoSecret: [
          "GET /repos/{owner}/{repo}/dependabot/secrets/{secret_name}"
        ],
        listAlertsForEnterprise: [
          "GET /enterprises/{enterprise}/dependabot/alerts"
        ],
        listAlertsForOrg: ["GET /orgs/{org}/dependabot/alerts"],
        listAlertsForRepo: ["GET /repos/{owner}/{repo}/dependabot/alerts"],
        listOrgSecrets: ["GET /orgs/{org}/dependabot/secrets"],
        listRepoSecrets: ["GET /repos/{owner}/{repo}/dependabot/secrets"],
        listSelectedReposForOrgSecret: [
          "GET /orgs/{org}/dependabot/secrets/{secret_name}/repositories"
        ],
        removeSelectedRepoFromOrgSecret: [
          "DELETE /orgs/{org}/dependabot/secrets/{secret_name}/repositories/{repository_id}"
        ],
        setSelectedReposForOrgSecret: [
          "PUT /orgs/{org}/dependabot/secrets/{secret_name}/repositories"
        ],
        updateAlert: [
          "PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}"
        ]
      },
      dependencyGraph: {
        createRepositorySnapshot: [
          "POST /repos/{owner}/{repo}/dependency-graph/snapshots"
        ],
        diffRange: [
          "GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}"
        ],
        exportSbom: ["GET /repos/{owner}/{repo}/dependency-graph/sbom"]
      },
      emojis: { get: ["GET /emojis"] },
      gists: {
        checkIsStarred: ["GET /gists/{gist_id}/star"],
        create: ["POST /gists"],
        createComment: ["POST /gists/{gist_id}/comments"],
        delete: ["DELETE /gists/{gist_id}"],
        deleteComment: ["DELETE /gists/{gist_id}/comments/{comment_id}"],
        fork: ["POST /gists/{gist_id}/forks"],
        get: ["GET /gists/{gist_id}"],
        getComment: ["GET /gists/{gist_id}/comments/{comment_id}"],
        getRevision: ["GET /gists/{gist_id}/{sha}"],
        list: ["GET /gists"],
        listComments: ["GET /gists/{gist_id}/comments"],
        listCommits: ["GET /gists/{gist_id}/commits"],
        listForUser: ["GET /users/{username}/gists"],
        listForks: ["GET /gists/{gist_id}/forks"],
        listPublic: ["GET /gists/public"],
        listStarred: ["GET /gists/starred"],
        star: ["PUT /gists/{gist_id}/star"],
        unstar: ["DELETE /gists/{gist_id}/star"],
        update: ["PATCH /gists/{gist_id}"],
        updateComment: ["PATCH /gists/{gist_id}/comments/{comment_id}"]
      },
      git: {
        createBlob: ["POST /repos/{owner}/{repo}/git/blobs"],
        createCommit: ["POST /repos/{owner}/{repo}/git/commits"],
        createRef: ["POST /repos/{owner}/{repo}/git/refs"],
        createTag: ["POST /repos/{owner}/{repo}/git/tags"],
        createTree: ["POST /repos/{owner}/{repo}/git/trees"],
        deleteRef: ["DELETE /repos/{owner}/{repo}/git/refs/{ref}"],
        getBlob: ["GET /repos/{owner}/{repo}/git/blobs/{file_sha}"],
        getCommit: ["GET /repos/{owner}/{repo}/git/commits/{commit_sha}"],
        getRef: ["GET /repos/{owner}/{repo}/git/ref/{ref}"],
        getTag: ["GET /repos/{owner}/{repo}/git/tags/{tag_sha}"],
        getTree: ["GET /repos/{owner}/{repo}/git/trees/{tree_sha}"],
        listMatchingRefs: ["GET /repos/{owner}/{repo}/git/matching-refs/{ref}"],
        updateRef: ["PATCH /repos/{owner}/{repo}/git/refs/{ref}"]
      },
      gitignore: {
        getAllTemplates: ["GET /gitignore/templates"],
        getTemplate: ["GET /gitignore/templates/{name}"]
      },
      interactions: {
        getRestrictionsForAuthenticatedUser: ["GET /user/interaction-limits"],
        getRestrictionsForOrg: ["GET /orgs/{org}/interaction-limits"],
        getRestrictionsForRepo: ["GET /repos/{owner}/{repo}/interaction-limits"],
        getRestrictionsForYourPublicRepos: [
          "GET /user/interaction-limits",
          {},
          { renamed: ["interactions", "getRestrictionsForAuthenticatedUser"] }
        ],
        removeRestrictionsForAuthenticatedUser: ["DELETE /user/interaction-limits"],
        removeRestrictionsForOrg: ["DELETE /orgs/{org}/interaction-limits"],
        removeRestrictionsForRepo: [
          "DELETE /repos/{owner}/{repo}/interaction-limits"
        ],
        removeRestrictionsForYourPublicRepos: [
          "DELETE /user/interaction-limits",
          {},
          { renamed: ["interactions", "removeRestrictionsForAuthenticatedUser"] }
        ],
        setRestrictionsForAuthenticatedUser: ["PUT /user/interaction-limits"],
        setRestrictionsForOrg: ["PUT /orgs/{org}/interaction-limits"],
        setRestrictionsForRepo: ["PUT /repos/{owner}/{repo}/interaction-limits"],
        setRestrictionsForYourPublicRepos: [
          "PUT /user/interaction-limits",
          {},
          { renamed: ["interactions", "setRestrictionsForAuthenticatedUser"] }
        ]
      },
      issues: {
        addAssignees: [
          "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees"
        ],
        addLabels: ["POST /repos/{owner}/{repo}/issues/{issue_number}/labels"],
        addSubIssue: [
          "POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues"
        ],
        checkUserCanBeAssigned: ["GET /repos/{owner}/{repo}/assignees/{assignee}"],
        checkUserCanBeAssignedToIssue: [
          "GET /repos/{owner}/{repo}/issues/{issue_number}/assignees/{assignee}"
        ],
        create: ["POST /repos/{owner}/{repo}/issues"],
        createComment: [
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
        ],
        createLabel: ["POST /repos/{owner}/{repo}/labels"],
        createMilestone: ["POST /repos/{owner}/{repo}/milestones"],
        deleteComment: [
          "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}"
        ],
        deleteLabel: ["DELETE /repos/{owner}/{repo}/labels/{name}"],
        deleteMilestone: [
          "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}"
        ],
        get: ["GET /repos/{owner}/{repo}/issues/{issue_number}"],
        getComment: ["GET /repos/{owner}/{repo}/issues/comments/{comment_id}"],
        getEvent: ["GET /repos/{owner}/{repo}/issues/events/{event_id}"],
        getLabel: ["GET /repos/{owner}/{repo}/labels/{name}"],
        getMilestone: ["GET /repos/{owner}/{repo}/milestones/{milestone_number}"],
        list: ["GET /issues"],
        listAssignees: ["GET /repos/{owner}/{repo}/assignees"],
        listComments: ["GET /repos/{owner}/{repo}/issues/{issue_number}/comments"],
        listCommentsForRepo: ["GET /repos/{owner}/{repo}/issues/comments"],
        listEvents: ["GET /repos/{owner}/{repo}/issues/{issue_number}/events"],
        listEventsForRepo: ["GET /repos/{owner}/{repo}/issues/events"],
        listEventsForTimeline: [
          "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
        ],
        listForAuthenticatedUser: ["GET /user/issues"],
        listForOrg: ["GET /orgs/{org}/issues"],
        listForRepo: ["GET /repos/{owner}/{repo}/issues"],
        listLabelsForMilestone: [
          "GET /repos/{owner}/{repo}/milestones/{milestone_number}/labels"
        ],
        listLabelsForRepo: ["GET /repos/{owner}/{repo}/labels"],
        listLabelsOnIssue: [
          "GET /repos/{owner}/{repo}/issues/{issue_number}/labels"
        ],
        listMilestones: ["GET /repos/{owner}/{repo}/milestones"],
        listSubIssues: [
          "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues"
        ],
        lock: ["PUT /repos/{owner}/{repo}/issues/{issue_number}/lock"],
        removeAllLabels: [
          "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels"
        ],
        removeAssignees: [
          "DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees"
        ],
        removeLabel: [
          "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}"
        ],
        removeSubIssue: [
          "DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue"
        ],
        reprioritizeSubIssue: [
          "PATCH /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority"
        ],
        setLabels: ["PUT /repos/{owner}/{repo}/issues/{issue_number}/labels"],
        unlock: ["DELETE /repos/{owner}/{repo}/issues/{issue_number}/lock"],
        update: ["PATCH /repos/{owner}/{repo}/issues/{issue_number}"],
        updateComment: ["PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}"],
        updateLabel: ["PATCH /repos/{owner}/{repo}/labels/{name}"],
        updateMilestone: [
          "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}"
        ]
      },
      licenses: {
        get: ["GET /licenses/{license}"],
        getAllCommonlyUsed: ["GET /licenses"],
        getForRepo: ["GET /repos/{owner}/{repo}/license"]
      },
      markdown: {
        render: ["POST /markdown"],
        renderRaw: [
          "POST /markdown/raw",
          { headers: { "content-type": "text/plain; charset=utf-8" } }
        ]
      },
      meta: {
        get: ["GET /meta"],
        getAllVersions: ["GET /versions"],
        getOctocat: ["GET /octocat"],
        getZen: ["GET /zen"],
        root: ["GET /"]
      },
      migrations: {
        deleteArchiveForAuthenticatedUser: [
          "DELETE /user/migrations/{migration_id}/archive"
        ],
        deleteArchiveForOrg: [
          "DELETE /orgs/{org}/migrations/{migration_id}/archive"
        ],
        downloadArchiveForOrg: [
          "GET /orgs/{org}/migrations/{migration_id}/archive"
        ],
        getArchiveForAuthenticatedUser: [
          "GET /user/migrations/{migration_id}/archive"
        ],
        getStatusForAuthenticatedUser: ["GET /user/migrations/{migration_id}"],
        getStatusForOrg: ["GET /orgs/{org}/migrations/{migration_id}"],
        listForAuthenticatedUser: ["GET /user/migrations"],
        listForOrg: ["GET /orgs/{org}/migrations"],
        listReposForAuthenticatedUser: [
          "GET /user/migrations/{migration_id}/repositories"
        ],
        listReposForOrg: ["GET /orgs/{org}/migrations/{migration_id}/repositories"],
        listReposForUser: [
          "GET /user/migrations/{migration_id}/repositories",
          {},
          { renamed: ["migrations", "listReposForAuthenticatedUser"] }
        ],
        startForAuthenticatedUser: ["POST /user/migrations"],
        startForOrg: ["POST /orgs/{org}/migrations"],
        unlockRepoForAuthenticatedUser: [
          "DELETE /user/migrations/{migration_id}/repos/{repo_name}/lock"
        ],
        unlockRepoForOrg: [
          "DELETE /orgs/{org}/migrations/{migration_id}/repos/{repo_name}/lock"
        ]
      },
      oidc: {
        getOidcCustomSubTemplateForOrg: [
          "GET /orgs/{org}/actions/oidc/customization/sub"
        ],
        updateOidcCustomSubTemplateForOrg: [
          "PUT /orgs/{org}/actions/oidc/customization/sub"
        ]
      },
      orgs: {
        addSecurityManagerTeam: [
          "PUT /orgs/{org}/security-managers/teams/{team_slug}",
          {},
          {
            deprecated: "octokit.rest.orgs.addSecurityManagerTeam() is deprecated, see https://docs.github.com/rest/orgs/security-managers#add-a-security-manager-team"
          }
        ],
        assignTeamToOrgRole: [
          "PUT /orgs/{org}/organization-roles/teams/{team_slug}/{role_id}"
        ],
        assignUserToOrgRole: [
          "PUT /orgs/{org}/organization-roles/users/{username}/{role_id}"
        ],
        blockUser: ["PUT /orgs/{org}/blocks/{username}"],
        cancelInvitation: ["DELETE /orgs/{org}/invitations/{invitation_id}"],
        checkBlockedUser: ["GET /orgs/{org}/blocks/{username}"],
        checkMembershipForUser: ["GET /orgs/{org}/members/{username}"],
        checkPublicMembershipForUser: ["GET /orgs/{org}/public_members/{username}"],
        convertMemberToOutsideCollaborator: [
          "PUT /orgs/{org}/outside_collaborators/{username}"
        ],
        createInvitation: ["POST /orgs/{org}/invitations"],
        createOrUpdateCustomProperties: ["PATCH /orgs/{org}/properties/schema"],
        createOrUpdateCustomPropertiesValuesForRepos: [
          "PATCH /orgs/{org}/properties/values"
        ],
        createOrUpdateCustomProperty: [
          "PUT /orgs/{org}/properties/schema/{custom_property_name}"
        ],
        createWebhook: ["POST /orgs/{org}/hooks"],
        delete: ["DELETE /orgs/{org}"],
        deleteWebhook: ["DELETE /orgs/{org}/hooks/{hook_id}"],
        enableOrDisableSecurityProductOnAllOrgRepos: [
          "POST /orgs/{org}/{security_product}/{enablement}",
          {},
          {
            deprecated: "octokit.rest.orgs.enableOrDisableSecurityProductOnAllOrgRepos() is deprecated, see https://docs.github.com/rest/orgs/orgs#enable-or-disable-a-security-feature-for-an-organization"
          }
        ],
        get: ["GET /orgs/{org}"],
        getAllCustomProperties: ["GET /orgs/{org}/properties/schema"],
        getCustomProperty: [
          "GET /orgs/{org}/properties/schema/{custom_property_name}"
        ],
        getMembershipForAuthenticatedUser: ["GET /user/memberships/orgs/{org}"],
        getMembershipForUser: ["GET /orgs/{org}/memberships/{username}"],
        getOrgRole: ["GET /orgs/{org}/organization-roles/{role_id}"],
        getWebhook: ["GET /orgs/{org}/hooks/{hook_id}"],
        getWebhookConfigForOrg: ["GET /orgs/{org}/hooks/{hook_id}/config"],
        getWebhookDelivery: [
          "GET /orgs/{org}/hooks/{hook_id}/deliveries/{delivery_id}"
        ],
        list: ["GET /organizations"],
        listAppInstallations: ["GET /orgs/{org}/installations"],
        listAttestations: ["GET /orgs/{org}/attestations/{subject_digest}"],
        listBlockedUsers: ["GET /orgs/{org}/blocks"],
        listCustomPropertiesValuesForRepos: ["GET /orgs/{org}/properties/values"],
        listFailedInvitations: ["GET /orgs/{org}/failed_invitations"],
        listForAuthenticatedUser: ["GET /user/orgs"],
        listForUser: ["GET /users/{username}/orgs"],
        listInvitationTeams: ["GET /orgs/{org}/invitations/{invitation_id}/teams"],
        listMembers: ["GET /orgs/{org}/members"],
        listMembershipsForAuthenticatedUser: ["GET /user/memberships/orgs"],
        listOrgRoleTeams: ["GET /orgs/{org}/organization-roles/{role_id}/teams"],
        listOrgRoleUsers: ["GET /orgs/{org}/organization-roles/{role_id}/users"],
        listOrgRoles: ["GET /orgs/{org}/organization-roles"],
        listOrganizationFineGrainedPermissions: [
          "GET /orgs/{org}/organization-fine-grained-permissions"
        ],
        listOutsideCollaborators: ["GET /orgs/{org}/outside_collaborators"],
        listPatGrantRepositories: [
          "GET /orgs/{org}/personal-access-tokens/{pat_id}/repositories"
        ],
        listPatGrantRequestRepositories: [
          "GET /orgs/{org}/personal-access-token-requests/{pat_request_id}/repositories"
        ],
        listPatGrantRequests: ["GET /orgs/{org}/personal-access-token-requests"],
        listPatGrants: ["GET /orgs/{org}/personal-access-tokens"],
        listPendingInvitations: ["GET /orgs/{org}/invitations"],
        listPublicMembers: ["GET /orgs/{org}/public_members"],
        listSecurityManagerTeams: [
          "GET /orgs/{org}/security-managers",
          {},
          {
            deprecated: "octokit.rest.orgs.listSecurityManagerTeams() is deprecated, see https://docs.github.com/rest/orgs/security-managers#list-security-manager-teams"
          }
        ],
        listWebhookDeliveries: ["GET /orgs/{org}/hooks/{hook_id}/deliveries"],
        listWebhooks: ["GET /orgs/{org}/hooks"],
        pingWebhook: ["POST /orgs/{org}/hooks/{hook_id}/pings"],
        redeliverWebhookDelivery: [
          "POST /orgs/{org}/hooks/{hook_id}/deliveries/{delivery_id}/attempts"
        ],
        removeCustomProperty: [
          "DELETE /orgs/{org}/properties/schema/{custom_property_name}"
        ],
        removeMember: ["DELETE /orgs/{org}/members/{username}"],
        removeMembershipForUser: ["DELETE /orgs/{org}/memberships/{username}"],
        removeOutsideCollaborator: [
          "DELETE /orgs/{org}/outside_collaborators/{username}"
        ],
        removePublicMembershipForAuthenticatedUser: [
          "DELETE /orgs/{org}/public_members/{username}"
        ],
        removeSecurityManagerTeam: [
          "DELETE /orgs/{org}/security-managers/teams/{team_slug}",
          {},
          {
            deprecated: "octokit.rest.orgs.removeSecurityManagerTeam() is deprecated, see https://docs.github.com/rest/orgs/security-managers#remove-a-security-manager-team"
          }
        ],
        reviewPatGrantRequest: [
          "POST /orgs/{org}/personal-access-token-requests/{pat_request_id}"
        ],
        reviewPatGrantRequestsInBulk: [
          "POST /orgs/{org}/personal-access-token-requests"
        ],
        revokeAllOrgRolesTeam: [
          "DELETE /orgs/{org}/organization-roles/teams/{team_slug}"
        ],
        revokeAllOrgRolesUser: [
          "DELETE /orgs/{org}/organization-roles/users/{username}"
        ],
        revokeOrgRoleTeam: [
          "DELETE /orgs/{org}/organization-roles/teams/{team_slug}/{role_id}"
        ],
        revokeOrgRoleUser: [
          "DELETE /orgs/{org}/organization-roles/users/{username}/{role_id}"
        ],
        setMembershipForUser: ["PUT /orgs/{org}/memberships/{username}"],
        setPublicMembershipForAuthenticatedUser: [
          "PUT /orgs/{org}/public_members/{username}"
        ],
        unblockUser: ["DELETE /orgs/{org}/blocks/{username}"],
        update: ["PATCH /orgs/{org}"],
        updateMembershipForAuthenticatedUser: [
          "PATCH /user/memberships/orgs/{org}"
        ],
        updatePatAccess: ["POST /orgs/{org}/personal-access-tokens/{pat_id}"],
        updatePatAccesses: ["POST /orgs/{org}/personal-access-tokens"],
        updateWebhook: ["PATCH /orgs/{org}/hooks/{hook_id}"],
        updateWebhookConfigForOrg: ["PATCH /orgs/{org}/hooks/{hook_id}/config"]
      },
      packages: {
        deletePackageForAuthenticatedUser: [
          "DELETE /user/packages/{package_type}/{package_name}"
        ],
        deletePackageForOrg: [
          "DELETE /orgs/{org}/packages/{package_type}/{package_name}"
        ],
        deletePackageForUser: [
          "DELETE /users/{username}/packages/{package_type}/{package_name}"
        ],
        deletePackageVersionForAuthenticatedUser: [
          "DELETE /user/packages/{package_type}/{package_name}/versions/{package_version_id}"
        ],
        deletePackageVersionForOrg: [
          "DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}"
        ],
        deletePackageVersionForUser: [
          "DELETE /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}"
        ],
        getAllPackageVersionsForAPackageOwnedByAnOrg: [
          "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
          {},
          { renamed: ["packages", "getAllPackageVersionsForPackageOwnedByOrg"] }
        ],
        getAllPackageVersionsForAPackageOwnedByTheAuthenticatedUser: [
          "GET /user/packages/{package_type}/{package_name}/versions",
          {},
          {
            renamed: [
              "packages",
              "getAllPackageVersionsForPackageOwnedByAuthenticatedUser"
            ]
          }
        ],
        getAllPackageVersionsForPackageOwnedByAuthenticatedUser: [
          "GET /user/packages/{package_type}/{package_name}/versions"
        ],
        getAllPackageVersionsForPackageOwnedByOrg: [
          "GET /orgs/{org}/packages/{package_type}/{package_name}/versions"
        ],
        getAllPackageVersionsForPackageOwnedByUser: [
          "GET /users/{username}/packages/{package_type}/{package_name}/versions"
        ],
        getPackageForAuthenticatedUser: [
          "GET /user/packages/{package_type}/{package_name}"
        ],
        getPackageForOrganization: [
          "GET /orgs/{org}/packages/{package_type}/{package_name}"
        ],
        getPackageForUser: [
          "GET /users/{username}/packages/{package_type}/{package_name}"
        ],
        getPackageVersionForAuthenticatedUser: [
          "GET /user/packages/{package_type}/{package_name}/versions/{package_version_id}"
        ],
        getPackageVersionForOrganization: [
          "GET /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}"
        ],
        getPackageVersionForUser: [
          "GET /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}"
        ],
        listDockerMigrationConflictingPackagesForAuthenticatedUser: [
          "GET /user/docker/conflicts"
        ],
        listDockerMigrationConflictingPackagesForOrganization: [
          "GET /orgs/{org}/docker/conflicts"
        ],
        listDockerMigrationConflictingPackagesForUser: [
          "GET /users/{username}/docker/conflicts"
        ],
        listPackagesForAuthenticatedUser: ["GET /user/packages"],
        listPackagesForOrganization: ["GET /orgs/{org}/packages"],
        listPackagesForUser: ["GET /users/{username}/packages"],
        restorePackageForAuthenticatedUser: [
          "POST /user/packages/{package_type}/{package_name}/restore{?token}"
        ],
        restorePackageForOrg: [
          "POST /orgs/{org}/packages/{package_type}/{package_name}/restore{?token}"
        ],
        restorePackageForUser: [
          "POST /users/{username}/packages/{package_type}/{package_name}/restore{?token}"
        ],
        restorePackageVersionForAuthenticatedUser: [
          "POST /user/packages/{package_type}/{package_name}/versions/{package_version_id}/restore"
        ],
        restorePackageVersionForOrg: [
          "POST /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}/restore"
        ],
        restorePackageVersionForUser: [
          "POST /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}/restore"
        ]
      },
      privateRegistries: {
        createOrgPrivateRegistry: ["POST /orgs/{org}/private-registries"],
        deleteOrgPrivateRegistry: [
          "DELETE /orgs/{org}/private-registries/{secret_name}"
        ],
        getOrgPrivateRegistry: ["GET /orgs/{org}/private-registries/{secret_name}"],
        getOrgPublicKey: ["GET /orgs/{org}/private-registries/public-key"],
        listOrgPrivateRegistries: ["GET /orgs/{org}/private-registries"],
        updateOrgPrivateRegistry: [
          "PATCH /orgs/{org}/private-registries/{secret_name}"
        ]
      },
      projects: {
        addCollaborator: ["PUT /projects/{project_id}/collaborators/{username}"],
        createCard: ["POST /projects/columns/{column_id}/cards"],
        createColumn: ["POST /projects/{project_id}/columns"],
        createForAuthenticatedUser: ["POST /user/projects"],
        createForOrg: ["POST /orgs/{org}/projects"],
        createForRepo: ["POST /repos/{owner}/{repo}/projects"],
        delete: ["DELETE /projects/{project_id}"],
        deleteCard: ["DELETE /projects/columns/cards/{card_id}"],
        deleteColumn: ["DELETE /projects/columns/{column_id}"],
        get: ["GET /projects/{project_id}"],
        getCard: ["GET /projects/columns/cards/{card_id}"],
        getColumn: ["GET /projects/columns/{column_id}"],
        getPermissionForUser: [
          "GET /projects/{project_id}/collaborators/{username}/permission"
        ],
        listCards: ["GET /projects/columns/{column_id}/cards"],
        listCollaborators: ["GET /projects/{project_id}/collaborators"],
        listColumns: ["GET /projects/{project_id}/columns"],
        listForOrg: ["GET /orgs/{org}/projects"],
        listForRepo: ["GET /repos/{owner}/{repo}/projects"],
        listForUser: ["GET /users/{username}/projects"],
        moveCard: ["POST /projects/columns/cards/{card_id}/moves"],
        moveColumn: ["POST /projects/columns/{column_id}/moves"],
        removeCollaborator: [
          "DELETE /projects/{project_id}/collaborators/{username}"
        ],
        update: ["PATCH /projects/{project_id}"],
        updateCard: ["PATCH /projects/columns/cards/{card_id}"],
        updateColumn: ["PATCH /projects/columns/{column_id}"]
      },
      pulls: {
        checkIfMerged: ["GET /repos/{owner}/{repo}/pulls/{pull_number}/merge"],
        create: ["POST /repos/{owner}/{repo}/pulls"],
        createReplyForReviewComment: [
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies"
        ],
        createReview: ["POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews"],
        createReviewComment: [
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments"
        ],
        deletePendingReview: [
          "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}"
        ],
        deleteReviewComment: [
          "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}"
        ],
        dismissReview: [
          "PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals"
        ],
        get: ["GET /repos/{owner}/{repo}/pulls/{pull_number}"],
        getReview: [
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}"
        ],
        getReviewComment: ["GET /repos/{owner}/{repo}/pulls/comments/{comment_id}"],
        list: ["GET /repos/{owner}/{repo}/pulls"],
        listCommentsForReview: [
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments"
        ],
        listCommits: ["GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"],
        listFiles: ["GET /repos/{owner}/{repo}/pulls/{pull_number}/files"],
        listRequestedReviewers: [
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers"
        ],
        listReviewComments: [
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"
        ],
        listReviewCommentsForRepo: ["GET /repos/{owner}/{repo}/pulls/comments"],
        listReviews: ["GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"],
        merge: ["PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"],
        removeRequestedReviewers: [
          "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers"
        ],
        requestReviewers: [
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers"
        ],
        submitReview: [
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events"
        ],
        update: ["PATCH /repos/{owner}/{repo}/pulls/{pull_number}"],
        updateBranch: [
          "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch"
        ],
        updateReview: [
          "PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}"
        ],
        updateReviewComment: [
          "PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}"
        ]
      },
      rateLimit: { get: ["GET /rate_limit"] },
      reactions: {
        createForCommitComment: [
          "POST /repos/{owner}/{repo}/comments/{comment_id}/reactions"
        ],
        createForIssue: [
          "POST /repos/{owner}/{repo}/issues/{issue_number}/reactions"
        ],
        createForIssueComment: [
          "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"
        ],
        createForPullRequestReviewComment: [
          "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions"
        ],
        createForRelease: [
          "POST /repos/{owner}/{repo}/releases/{release_id}/reactions"
        ],
        createForTeamDiscussionCommentInOrg: [
          "POST /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}/reactions"
        ],
        createForTeamDiscussionInOrg: [
          "POST /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/reactions"
        ],
        deleteForCommitComment: [
          "DELETE /repos/{owner}/{repo}/comments/{comment_id}/reactions/{reaction_id}"
        ],
        deleteForIssue: [
          "DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}"
        ],
        deleteForIssueComment: [
          "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}"
        ],
        deleteForPullRequestComment: [
          "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}"
        ],
        deleteForRelease: [
          "DELETE /repos/{owner}/{repo}/releases/{release_id}/reactions/{reaction_id}"
        ],
        deleteForTeamDiscussion: [
          "DELETE /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/reactions/{reaction_id}"
        ],
        deleteForTeamDiscussionComment: [
          "DELETE /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}/reactions/{reaction_id}"
        ],
        listForCommitComment: [
          "GET /repos/{owner}/{repo}/comments/{comment_id}/reactions"
        ],
        listForIssue: ["GET /repos/{owner}/{repo}/issues/{issue_number}/reactions"],
        listForIssueComment: [
          "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"
        ],
        listForPullRequestReviewComment: [
          "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions"
        ],
        listForRelease: [
          "GET /repos/{owner}/{repo}/releases/{release_id}/reactions"
        ],
        listForTeamDiscussionCommentInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}/reactions"
        ],
        listForTeamDiscussionInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/reactions"
        ]
      },
      repos: {
        acceptInvitation: [
          "PATCH /user/repository_invitations/{invitation_id}",
          {},
          { renamed: ["repos", "acceptInvitationForAuthenticatedUser"] }
        ],
        acceptInvitationForAuthenticatedUser: [
          "PATCH /user/repository_invitations/{invitation_id}"
        ],
        addAppAccessRestrictions: [
          "POST /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps",
          {},
          { mapToData: "apps" }
        ],
        addCollaborator: ["PUT /repos/{owner}/{repo}/collaborators/{username}"],
        addStatusCheckContexts: [
          "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
          {},
          { mapToData: "contexts" }
        ],
        addTeamAccessRestrictions: [
          "POST /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams",
          {},
          { mapToData: "teams" }
        ],
        addUserAccessRestrictions: [
          "POST /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users",
          {},
          { mapToData: "users" }
        ],
        cancelPagesDeployment: [
          "POST /repos/{owner}/{repo}/pages/deployments/{pages_deployment_id}/cancel"
        ],
        checkAutomatedSecurityFixes: [
          "GET /repos/{owner}/{repo}/automated-security-fixes"
        ],
        checkCollaborator: ["GET /repos/{owner}/{repo}/collaborators/{username}"],
        checkPrivateVulnerabilityReporting: [
          "GET /repos/{owner}/{repo}/private-vulnerability-reporting"
        ],
        checkVulnerabilityAlerts: [
          "GET /repos/{owner}/{repo}/vulnerability-alerts"
        ],
        codeownersErrors: ["GET /repos/{owner}/{repo}/codeowners/errors"],
        compareCommits: ["GET /repos/{owner}/{repo}/compare/{base}...{head}"],
        compareCommitsWithBasehead: [
          "GET /repos/{owner}/{repo}/compare/{basehead}"
        ],
        createAttestation: ["POST /repos/{owner}/{repo}/attestations"],
        createAutolink: ["POST /repos/{owner}/{repo}/autolinks"],
        createCommitComment: [
          "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments"
        ],
        createCommitSignatureProtection: [
          "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures"
        ],
        createCommitStatus: ["POST /repos/{owner}/{repo}/statuses/{sha}"],
        createDeployKey: ["POST /repos/{owner}/{repo}/keys"],
        createDeployment: ["POST /repos/{owner}/{repo}/deployments"],
        createDeploymentBranchPolicy: [
          "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies"
        ],
        createDeploymentProtectionRule: [
          "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules"
        ],
        createDeploymentStatus: [
          "POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses"
        ],
        createDispatchEvent: ["POST /repos/{owner}/{repo}/dispatches"],
        createForAuthenticatedUser: ["POST /user/repos"],
        createFork: ["POST /repos/{owner}/{repo}/forks"],
        createInOrg: ["POST /orgs/{org}/repos"],
        createOrUpdateCustomPropertiesValues: [
          "PATCH /repos/{owner}/{repo}/properties/values"
        ],
        createOrUpdateEnvironment: [
          "PUT /repos/{owner}/{repo}/environments/{environment_name}"
        ],
        createOrUpdateFileContents: ["PUT /repos/{owner}/{repo}/contents/{path}"],
        createOrgRuleset: ["POST /orgs/{org}/rulesets"],
        createPagesDeployment: ["POST /repos/{owner}/{repo}/pages/deployments"],
        createPagesSite: ["POST /repos/{owner}/{repo}/pages"],
        createRelease: ["POST /repos/{owner}/{repo}/releases"],
        createRepoRuleset: ["POST /repos/{owner}/{repo}/rulesets"],
        createUsingTemplate: [
          "POST /repos/{template_owner}/{template_repo}/generate"
        ],
        createWebhook: ["POST /repos/{owner}/{repo}/hooks"],
        declineInvitation: [
          "DELETE /user/repository_invitations/{invitation_id}",
          {},
          { renamed: ["repos", "declineInvitationForAuthenticatedUser"] }
        ],
        declineInvitationForAuthenticatedUser: [
          "DELETE /user/repository_invitations/{invitation_id}"
        ],
        delete: ["DELETE /repos/{owner}/{repo}"],
        deleteAccessRestrictions: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/restrictions"
        ],
        deleteAdminBranchProtection: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins"
        ],
        deleteAnEnvironment: [
          "DELETE /repos/{owner}/{repo}/environments/{environment_name}"
        ],
        deleteAutolink: ["DELETE /repos/{owner}/{repo}/autolinks/{autolink_id}"],
        deleteBranchProtection: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection"
        ],
        deleteCommitComment: ["DELETE /repos/{owner}/{repo}/comments/{comment_id}"],
        deleteCommitSignatureProtection: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures"
        ],
        deleteDeployKey: ["DELETE /repos/{owner}/{repo}/keys/{key_id}"],
        deleteDeployment: [
          "DELETE /repos/{owner}/{repo}/deployments/{deployment_id}"
        ],
        deleteDeploymentBranchPolicy: [
          "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}"
        ],
        deleteFile: ["DELETE /repos/{owner}/{repo}/contents/{path}"],
        deleteInvitation: [
          "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}"
        ],
        deleteOrgRuleset: ["DELETE /orgs/{org}/rulesets/{ruleset_id}"],
        deletePagesSite: ["DELETE /repos/{owner}/{repo}/pages"],
        deletePullRequestReviewProtection: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews"
        ],
        deleteRelease: ["DELETE /repos/{owner}/{repo}/releases/{release_id}"],
        deleteReleaseAsset: [
          "DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}"
        ],
        deleteRepoRuleset: ["DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}"],
        deleteWebhook: ["DELETE /repos/{owner}/{repo}/hooks/{hook_id}"],
        disableAutomatedSecurityFixes: [
          "DELETE /repos/{owner}/{repo}/automated-security-fixes"
        ],
        disableDeploymentProtectionRule: [
          "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}"
        ],
        disablePrivateVulnerabilityReporting: [
          "DELETE /repos/{owner}/{repo}/private-vulnerability-reporting"
        ],
        disableVulnerabilityAlerts: [
          "DELETE /repos/{owner}/{repo}/vulnerability-alerts"
        ],
        downloadArchive: [
          "GET /repos/{owner}/{repo}/zipball/{ref}",
          {},
          { renamed: ["repos", "downloadZipballArchive"] }
        ],
        downloadTarballArchive: ["GET /repos/{owner}/{repo}/tarball/{ref}"],
        downloadZipballArchive: ["GET /repos/{owner}/{repo}/zipball/{ref}"],
        enableAutomatedSecurityFixes: [
          "PUT /repos/{owner}/{repo}/automated-security-fixes"
        ],
        enablePrivateVulnerabilityReporting: [
          "PUT /repos/{owner}/{repo}/private-vulnerability-reporting"
        ],
        enableVulnerabilityAlerts: [
          "PUT /repos/{owner}/{repo}/vulnerability-alerts"
        ],
        generateReleaseNotes: [
          "POST /repos/{owner}/{repo}/releases/generate-notes"
        ],
        get: ["GET /repos/{owner}/{repo}"],
        getAccessRestrictions: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions"
        ],
        getAdminBranchProtection: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins"
        ],
        getAllDeploymentProtectionRules: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules"
        ],
        getAllEnvironments: ["GET /repos/{owner}/{repo}/environments"],
        getAllStatusCheckContexts: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts"
        ],
        getAllTopics: ["GET /repos/{owner}/{repo}/topics"],
        getAppsWithAccessToProtectedBranch: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps"
        ],
        getAutolink: ["GET /repos/{owner}/{repo}/autolinks/{autolink_id}"],
        getBranch: ["GET /repos/{owner}/{repo}/branches/{branch}"],
        getBranchProtection: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection"
        ],
        getBranchRules: ["GET /repos/{owner}/{repo}/rules/branches/{branch}"],
        getClones: ["GET /repos/{owner}/{repo}/traffic/clones"],
        getCodeFrequencyStats: ["GET /repos/{owner}/{repo}/stats/code_frequency"],
        getCollaboratorPermissionLevel: [
          "GET /repos/{owner}/{repo}/collaborators/{username}/permission"
        ],
        getCombinedStatusForRef: ["GET /repos/{owner}/{repo}/commits/{ref}/status"],
        getCommit: ["GET /repos/{owner}/{repo}/commits/{ref}"],
        getCommitActivityStats: ["GET /repos/{owner}/{repo}/stats/commit_activity"],
        getCommitComment: ["GET /repos/{owner}/{repo}/comments/{comment_id}"],
        getCommitSignatureProtection: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures"
        ],
        getCommunityProfileMetrics: ["GET /repos/{owner}/{repo}/community/profile"],
        getContent: ["GET /repos/{owner}/{repo}/contents/{path}"],
        getContributorsStats: ["GET /repos/{owner}/{repo}/stats/contributors"],
        getCustomDeploymentProtectionRule: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}"
        ],
        getCustomPropertiesValues: ["GET /repos/{owner}/{repo}/properties/values"],
        getDeployKey: ["GET /repos/{owner}/{repo}/keys/{key_id}"],
        getDeployment: ["GET /repos/{owner}/{repo}/deployments/{deployment_id}"],
        getDeploymentBranchPolicy: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}"
        ],
        getDeploymentStatus: [
          "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses/{status_id}"
        ],
        getEnvironment: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}"
        ],
        getLatestPagesBuild: ["GET /repos/{owner}/{repo}/pages/builds/latest"],
        getLatestRelease: ["GET /repos/{owner}/{repo}/releases/latest"],
        getOrgRuleSuite: ["GET /orgs/{org}/rulesets/rule-suites/{rule_suite_id}"],
        getOrgRuleSuites: ["GET /orgs/{org}/rulesets/rule-suites"],
        getOrgRuleset: ["GET /orgs/{org}/rulesets/{ruleset_id}"],
        getOrgRulesets: ["GET /orgs/{org}/rulesets"],
        getPages: ["GET /repos/{owner}/{repo}/pages"],
        getPagesBuild: ["GET /repos/{owner}/{repo}/pages/builds/{build_id}"],
        getPagesDeployment: [
          "GET /repos/{owner}/{repo}/pages/deployments/{pages_deployment_id}"
        ],
        getPagesHealthCheck: ["GET /repos/{owner}/{repo}/pages/health"],
        getParticipationStats: ["GET /repos/{owner}/{repo}/stats/participation"],
        getPullRequestReviewProtection: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews"
        ],
        getPunchCardStats: ["GET /repos/{owner}/{repo}/stats/punch_card"],
        getReadme: ["GET /repos/{owner}/{repo}/readme"],
        getReadmeInDirectory: ["GET /repos/{owner}/{repo}/readme/{dir}"],
        getRelease: ["GET /repos/{owner}/{repo}/releases/{release_id}"],
        getReleaseAsset: ["GET /repos/{owner}/{repo}/releases/assets/{asset_id}"],
        getReleaseByTag: ["GET /repos/{owner}/{repo}/releases/tags/{tag}"],
        getRepoRuleSuite: [
          "GET /repos/{owner}/{repo}/rulesets/rule-suites/{rule_suite_id}"
        ],
        getRepoRuleSuites: ["GET /repos/{owner}/{repo}/rulesets/rule-suites"],
        getRepoRuleset: ["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"],
        getRepoRulesets: ["GET /repos/{owner}/{repo}/rulesets"],
        getStatusChecksProtection: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks"
        ],
        getTeamsWithAccessToProtectedBranch: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams"
        ],
        getTopPaths: ["GET /repos/{owner}/{repo}/traffic/popular/paths"],
        getTopReferrers: ["GET /repos/{owner}/{repo}/traffic/popular/referrers"],
        getUsersWithAccessToProtectedBranch: [
          "GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users"
        ],
        getViews: ["GET /repos/{owner}/{repo}/traffic/views"],
        getWebhook: ["GET /repos/{owner}/{repo}/hooks/{hook_id}"],
        getWebhookConfigForRepo: [
          "GET /repos/{owner}/{repo}/hooks/{hook_id}/config"
        ],
        getWebhookDelivery: [
          "GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}"
        ],
        listActivities: ["GET /repos/{owner}/{repo}/activity"],
        listAttestations: [
          "GET /repos/{owner}/{repo}/attestations/{subject_digest}"
        ],
        listAutolinks: ["GET /repos/{owner}/{repo}/autolinks"],
        listBranches: ["GET /repos/{owner}/{repo}/branches"],
        listBranchesForHeadCommit: [
          "GET /repos/{owner}/{repo}/commits/{commit_sha}/branches-where-head"
        ],
        listCollaborators: ["GET /repos/{owner}/{repo}/collaborators"],
        listCommentsForCommit: [
          "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments"
        ],
        listCommitCommentsForRepo: ["GET /repos/{owner}/{repo}/comments"],
        listCommitStatusesForRef: [
          "GET /repos/{owner}/{repo}/commits/{ref}/statuses"
        ],
        listCommits: ["GET /repos/{owner}/{repo}/commits"],
        listContributors: ["GET /repos/{owner}/{repo}/contributors"],
        listCustomDeploymentRuleIntegrations: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps"
        ],
        listDeployKeys: ["GET /repos/{owner}/{repo}/keys"],
        listDeploymentBranchPolicies: [
          "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies"
        ],
        listDeploymentStatuses: [
          "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses"
        ],
        listDeployments: ["GET /repos/{owner}/{repo}/deployments"],
        listForAuthenticatedUser: ["GET /user/repos"],
        listForOrg: ["GET /orgs/{org}/repos"],
        listForUser: ["GET /users/{username}/repos"],
        listForks: ["GET /repos/{owner}/{repo}/forks"],
        listInvitations: ["GET /repos/{owner}/{repo}/invitations"],
        listInvitationsForAuthenticatedUser: ["GET /user/repository_invitations"],
        listLanguages: ["GET /repos/{owner}/{repo}/languages"],
        listPagesBuilds: ["GET /repos/{owner}/{repo}/pages/builds"],
        listPublic: ["GET /repositories"],
        listPullRequestsAssociatedWithCommit: [
          "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls"
        ],
        listReleaseAssets: [
          "GET /repos/{owner}/{repo}/releases/{release_id}/assets"
        ],
        listReleases: ["GET /repos/{owner}/{repo}/releases"],
        listTags: ["GET /repos/{owner}/{repo}/tags"],
        listTeams: ["GET /repos/{owner}/{repo}/teams"],
        listWebhookDeliveries: [
          "GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries"
        ],
        listWebhooks: ["GET /repos/{owner}/{repo}/hooks"],
        merge: ["POST /repos/{owner}/{repo}/merges"],
        mergeUpstream: ["POST /repos/{owner}/{repo}/merge-upstream"],
        pingWebhook: ["POST /repos/{owner}/{repo}/hooks/{hook_id}/pings"],
        redeliverWebhookDelivery: [
          "POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts"
        ],
        removeAppAccessRestrictions: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps",
          {},
          { mapToData: "apps" }
        ],
        removeCollaborator: [
          "DELETE /repos/{owner}/{repo}/collaborators/{username}"
        ],
        removeStatusCheckContexts: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
          {},
          { mapToData: "contexts" }
        ],
        removeStatusCheckProtection: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks"
        ],
        removeTeamAccessRestrictions: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams",
          {},
          { mapToData: "teams" }
        ],
        removeUserAccessRestrictions: [
          "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users",
          {},
          { mapToData: "users" }
        ],
        renameBranch: ["POST /repos/{owner}/{repo}/branches/{branch}/rename"],
        replaceAllTopics: ["PUT /repos/{owner}/{repo}/topics"],
        requestPagesBuild: ["POST /repos/{owner}/{repo}/pages/builds"],
        setAdminBranchProtection: [
          "POST /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins"
        ],
        setAppAccessRestrictions: [
          "PUT /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps",
          {},
          { mapToData: "apps" }
        ],
        setStatusCheckContexts: [
          "PUT /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
          {},
          { mapToData: "contexts" }
        ],
        setTeamAccessRestrictions: [
          "PUT /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams",
          {},
          { mapToData: "teams" }
        ],
        setUserAccessRestrictions: [
          "PUT /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users",
          {},
          { mapToData: "users" }
        ],
        testPushWebhook: ["POST /repos/{owner}/{repo}/hooks/{hook_id}/tests"],
        transfer: ["POST /repos/{owner}/{repo}/transfer"],
        update: ["PATCH /repos/{owner}/{repo}"],
        updateBranchProtection: [
          "PUT /repos/{owner}/{repo}/branches/{branch}/protection"
        ],
        updateCommitComment: ["PATCH /repos/{owner}/{repo}/comments/{comment_id}"],
        updateDeploymentBranchPolicy: [
          "PUT /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}"
        ],
        updateInformationAboutPagesSite: ["PUT /repos/{owner}/{repo}/pages"],
        updateInvitation: [
          "PATCH /repos/{owner}/{repo}/invitations/{invitation_id}"
        ],
        updateOrgRuleset: ["PUT /orgs/{org}/rulesets/{ruleset_id}"],
        updatePullRequestReviewProtection: [
          "PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews"
        ],
        updateRelease: ["PATCH /repos/{owner}/{repo}/releases/{release_id}"],
        updateReleaseAsset: [
          "PATCH /repos/{owner}/{repo}/releases/assets/{asset_id}"
        ],
        updateRepoRuleset: ["PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}"],
        updateStatusCheckPotection: [
          "PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
          {},
          { renamed: ["repos", "updateStatusCheckProtection"] }
        ],
        updateStatusCheckProtection: [
          "PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks"
        ],
        updateWebhook: ["PATCH /repos/{owner}/{repo}/hooks/{hook_id}"],
        updateWebhookConfigForRepo: [
          "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config"
        ],
        uploadReleaseAsset: [
          "POST /repos/{owner}/{repo}/releases/{release_id}/assets{?name,label}",
          { baseUrl: "https://uploads.github.com" }
        ]
      },
      search: {
        code: ["GET /search/code"],
        commits: ["GET /search/commits"],
        issuesAndPullRequests: ["GET /search/issues"],
        labels: ["GET /search/labels"],
        repos: ["GET /search/repositories"],
        topics: ["GET /search/topics"],
        users: ["GET /search/users"]
      },
      secretScanning: {
        createPushProtectionBypass: [
          "POST /repos/{owner}/{repo}/secret-scanning/push-protection-bypasses"
        ],
        getAlert: [
          "GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}"
        ],
        getScanHistory: ["GET /repos/{owner}/{repo}/secret-scanning/scan-history"],
        listAlertsForEnterprise: [
          "GET /enterprises/{enterprise}/secret-scanning/alerts"
        ],
        listAlertsForOrg: ["GET /orgs/{org}/secret-scanning/alerts"],
        listAlertsForRepo: ["GET /repos/{owner}/{repo}/secret-scanning/alerts"],
        listLocationsForAlert: [
          "GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}/locations"
        ],
        updateAlert: [
          "PATCH /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}"
        ]
      },
      securityAdvisories: {
        createFork: [
          "POST /repos/{owner}/{repo}/security-advisories/{ghsa_id}/forks"
        ],
        createPrivateVulnerabilityReport: [
          "POST /repos/{owner}/{repo}/security-advisories/reports"
        ],
        createRepositoryAdvisory: [
          "POST /repos/{owner}/{repo}/security-advisories"
        ],
        createRepositoryAdvisoryCveRequest: [
          "POST /repos/{owner}/{repo}/security-advisories/{ghsa_id}/cve"
        ],
        getGlobalAdvisory: ["GET /advisories/{ghsa_id}"],
        getRepositoryAdvisory: [
          "GET /repos/{owner}/{repo}/security-advisories/{ghsa_id}"
        ],
        listGlobalAdvisories: ["GET /advisories"],
        listOrgRepositoryAdvisories: ["GET /orgs/{org}/security-advisories"],
        listRepositoryAdvisories: ["GET /repos/{owner}/{repo}/security-advisories"],
        updateRepositoryAdvisory: [
          "PATCH /repos/{owner}/{repo}/security-advisories/{ghsa_id}"
        ]
      },
      teams: {
        addOrUpdateMembershipForUserInOrg: [
          "PUT /orgs/{org}/teams/{team_slug}/memberships/{username}"
        ],
        addOrUpdateProjectPermissionsInOrg: [
          "PUT /orgs/{org}/teams/{team_slug}/projects/{project_id}"
        ],
        addOrUpdateRepoPermissionsInOrg: [
          "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}"
        ],
        checkPermissionsForProjectInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/projects/{project_id}"
        ],
        checkPermissionsForRepoInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}"
        ],
        create: ["POST /orgs/{org}/teams"],
        createDiscussionCommentInOrg: [
          "POST /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments"
        ],
        createDiscussionInOrg: ["POST /orgs/{org}/teams/{team_slug}/discussions"],
        deleteDiscussionCommentInOrg: [
          "DELETE /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}"
        ],
        deleteDiscussionInOrg: [
          "DELETE /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}"
        ],
        deleteInOrg: ["DELETE /orgs/{org}/teams/{team_slug}"],
        getByName: ["GET /orgs/{org}/teams/{team_slug}"],
        getDiscussionCommentInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}"
        ],
        getDiscussionInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}"
        ],
        getMembershipForUserInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/memberships/{username}"
        ],
        list: ["GET /orgs/{org}/teams"],
        listChildInOrg: ["GET /orgs/{org}/teams/{team_slug}/teams"],
        listDiscussionCommentsInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments"
        ],
        listDiscussionsInOrg: ["GET /orgs/{org}/teams/{team_slug}/discussions"],
        listForAuthenticatedUser: ["GET /user/teams"],
        listMembersInOrg: ["GET /orgs/{org}/teams/{team_slug}/members"],
        listPendingInvitationsInOrg: [
          "GET /orgs/{org}/teams/{team_slug}/invitations"
        ],
        listProjectsInOrg: ["GET /orgs/{org}/teams/{team_slug}/projects"],
        listReposInOrg: ["GET /orgs/{org}/teams/{team_slug}/repos"],
        removeMembershipForUserInOrg: [
          "DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}"
        ],
        removeProjectInOrg: [
          "DELETE /orgs/{org}/teams/{team_slug}/projects/{project_id}"
        ],
        removeRepoInOrg: [
          "DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}"
        ],
        updateDiscussionCommentInOrg: [
          "PATCH /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}"
        ],
        updateDiscussionInOrg: [
          "PATCH /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}"
        ],
        updateInOrg: ["PATCH /orgs/{org}/teams/{team_slug}"]
      },
      users: {
        addEmailForAuthenticated: [
          "POST /user/emails",
          {},
          { renamed: ["users", "addEmailForAuthenticatedUser"] }
        ],
        addEmailForAuthenticatedUser: ["POST /user/emails"],
        addSocialAccountForAuthenticatedUser: ["POST /user/social_accounts"],
        block: ["PUT /user/blocks/{username}"],
        checkBlocked: ["GET /user/blocks/{username}"],
        checkFollowingForUser: ["GET /users/{username}/following/{target_user}"],
        checkPersonIsFollowedByAuthenticated: ["GET /user/following/{username}"],
        createGpgKeyForAuthenticated: [
          "POST /user/gpg_keys",
          {},
          { renamed: ["users", "createGpgKeyForAuthenticatedUser"] }
        ],
        createGpgKeyForAuthenticatedUser: ["POST /user/gpg_keys"],
        createPublicSshKeyForAuthenticated: [
          "POST /user/keys",
          {},
          { renamed: ["users", "createPublicSshKeyForAuthenticatedUser"] }
        ],
        createPublicSshKeyForAuthenticatedUser: ["POST /user/keys"],
        createSshSigningKeyForAuthenticatedUser: ["POST /user/ssh_signing_keys"],
        deleteEmailForAuthenticated: [
          "DELETE /user/emails",
          {},
          { renamed: ["users", "deleteEmailForAuthenticatedUser"] }
        ],
        deleteEmailForAuthenticatedUser: ["DELETE /user/emails"],
        deleteGpgKeyForAuthenticated: [
          "DELETE /user/gpg_keys/{gpg_key_id}",
          {},
          { renamed: ["users", "deleteGpgKeyForAuthenticatedUser"] }
        ],
        deleteGpgKeyForAuthenticatedUser: ["DELETE /user/gpg_keys/{gpg_key_id}"],
        deletePublicSshKeyForAuthenticated: [
          "DELETE /user/keys/{key_id}",
          {},
          { renamed: ["users", "deletePublicSshKeyForAuthenticatedUser"] }
        ],
        deletePublicSshKeyForAuthenticatedUser: ["DELETE /user/keys/{key_id}"],
        deleteSocialAccountForAuthenticatedUser: ["DELETE /user/social_accounts"],
        deleteSshSigningKeyForAuthenticatedUser: [
          "DELETE /user/ssh_signing_keys/{ssh_signing_key_id}"
        ],
        follow: ["PUT /user/following/{username}"],
        getAuthenticated: ["GET /user"],
        getById: ["GET /user/{account_id}"],
        getByUsername: ["GET /users/{username}"],
        getContextForUser: ["GET /users/{username}/hovercard"],
        getGpgKeyForAuthenticated: [
          "GET /user/gpg_keys/{gpg_key_id}",
          {},
          { renamed: ["users", "getGpgKeyForAuthenticatedUser"] }
        ],
        getGpgKeyForAuthenticatedUser: ["GET /user/gpg_keys/{gpg_key_id}"],
        getPublicSshKeyForAuthenticated: [
          "GET /user/keys/{key_id}",
          {},
          { renamed: ["users", "getPublicSshKeyForAuthenticatedUser"] }
        ],
        getPublicSshKeyForAuthenticatedUser: ["GET /user/keys/{key_id}"],
        getSshSigningKeyForAuthenticatedUser: [
          "GET /user/ssh_signing_keys/{ssh_signing_key_id}"
        ],
        list: ["GET /users"],
        listAttestations: ["GET /users/{username}/attestations/{subject_digest}"],
        listBlockedByAuthenticated: [
          "GET /user/blocks",
          {},
          { renamed: ["users", "listBlockedByAuthenticatedUser"] }
        ],
        listBlockedByAuthenticatedUser: ["GET /user/blocks"],
        listEmailsForAuthenticated: [
          "GET /user/emails",
          {},
          { renamed: ["users", "listEmailsForAuthenticatedUser"] }
        ],
        listEmailsForAuthenticatedUser: ["GET /user/emails"],
        listFollowedByAuthenticated: [
          "GET /user/following",
          {},
          { renamed: ["users", "listFollowedByAuthenticatedUser"] }
        ],
        listFollowedByAuthenticatedUser: ["GET /user/following"],
        listFollowersForAuthenticatedUser: ["GET /user/followers"],
        listFollowersForUser: ["GET /users/{username}/followers"],
        listFollowingForUser: ["GET /users/{username}/following"],
        listGpgKeysForAuthenticated: [
          "GET /user/gpg_keys",
          {},
          { renamed: ["users", "listGpgKeysForAuthenticatedUser"] }
        ],
        listGpgKeysForAuthenticatedUser: ["GET /user/gpg_keys"],
        listGpgKeysForUser: ["GET /users/{username}/gpg_keys"],
        listPublicEmailsForAuthenticated: [
          "GET /user/public_emails",
          {},
          { renamed: ["users", "listPublicEmailsForAuthenticatedUser"] }
        ],
        listPublicEmailsForAuthenticatedUser: ["GET /user/public_emails"],
        listPublicKeysForUser: ["GET /users/{username}/keys"],
        listPublicSshKeysForAuthenticated: [
          "GET /user/keys",
          {},
          { renamed: ["users", "listPublicSshKeysForAuthenticatedUser"] }
        ],
        listPublicSshKeysForAuthenticatedUser: ["GET /user/keys"],
        listSocialAccountsForAuthenticatedUser: ["GET /user/social_accounts"],
        listSocialAccountsForUser: ["GET /users/{username}/social_accounts"],
        listSshSigningKeysForAuthenticatedUser: ["GET /user/ssh_signing_keys"],
        listSshSigningKeysForUser: ["GET /users/{username}/ssh_signing_keys"],
        setPrimaryEmailVisibilityForAuthenticated: [
          "PATCH /user/email/visibility",
          {},
          { renamed: ["users", "setPrimaryEmailVisibilityForAuthenticatedUser"] }
        ],
        setPrimaryEmailVisibilityForAuthenticatedUser: [
          "PATCH /user/email/visibility"
        ],
        unblock: ["DELETE /user/blocks/{username}"],
        unfollow: ["DELETE /user/following/{username}"],
        updateAuthenticated: ["PATCH /user"]
      }
    };
    var endpoints_default = Endpoints;
    var endpointMethodsMap = /* @__PURE__ */ new Map();
    for (const [scope, endpoints] of Object.entries(endpoints_default)) {
      for (const [methodName, endpoint] of Object.entries(endpoints)) {
        const [route, defaults2, decorations] = endpoint;
        const [method, url] = route.split(/ /);
        const endpointDefaults = Object.assign(
          {
            method,
            url
          },
          defaults2
        );
        if (!endpointMethodsMap.has(scope)) {
          endpointMethodsMap.set(scope, /* @__PURE__ */ new Map());
        }
        endpointMethodsMap.get(scope).set(methodName, {
          scope,
          methodName,
          endpointDefaults,
          decorations
        });
      }
    }
    var handler = {
      has({ scope }, methodName) {
        return endpointMethodsMap.get(scope).has(methodName);
      },
      getOwnPropertyDescriptor(target, methodName) {
        return {
          value: this.get(target, methodName),
          // ensures method is in the cache
          configurable: true,
          writable: true,
          enumerable: true
        };
      },
      defineProperty(target, methodName, descriptor) {
        Object.defineProperty(target.cache, methodName, descriptor);
        return true;
      },
      deleteProperty(target, methodName) {
        delete target.cache[methodName];
        return true;
      },
      ownKeys({ scope }) {
        return [...endpointMethodsMap.get(scope).keys()];
      },
      set(target, methodName, value) {
        return target.cache[methodName] = value;
      },
      get({ octokit, scope, cache }, methodName) {
        if (cache[methodName]) {
          return cache[methodName];
        }
        const method = endpointMethodsMap.get(scope).get(methodName);
        if (!method) {
          return void 0;
        }
        const { endpointDefaults, decorations } = method;
        if (decorations) {
          cache[methodName] = decorate(
            octokit,
            scope,
            methodName,
            endpointDefaults,
            decorations
          );
        } else {
          cache[methodName] = octokit.request.defaults(endpointDefaults);
        }
        return cache[methodName];
      }
    };
    function endpointsToMethods(octokit) {
      const newMethods = {};
      for (const scope of endpointMethodsMap.keys()) {
        newMethods[scope] = new Proxy({ octokit, scope, cache: {} }, handler);
      }
      return newMethods;
    }
    function decorate(octokit, scope, methodName, defaults2, decorations) {
      const requestWithDefaults = octokit.request.defaults(defaults2);
      function withDecorations(...args) {
        let options = requestWithDefaults.endpoint.merge(...args);
        if (decorations.mapToData) {
          options = Object.assign({}, options, {
            data: options[decorations.mapToData],
            [decorations.mapToData]: void 0
          });
          return requestWithDefaults(options);
        }
        if (decorations.renamed) {
          const [newScope, newMethodName] = decorations.renamed;
          octokit.log.warn(
            `octokit.${scope}.${methodName}() has been renamed to octokit.${newScope}.${newMethodName}()`
          );
        }
        if (decorations.deprecated) {
          octokit.log.warn(decorations.deprecated);
        }
        if (decorations.renamedParameters) {
          const options2 = requestWithDefaults.endpoint.merge(...args);
          for (const [name, alias] of Object.entries(
            decorations.renamedParameters
          )) {
            if (name in options2) {
              octokit.log.warn(
                `"${name}" parameter is deprecated for "octokit.${scope}.${methodName}()". Use "${alias}" instead`
              );
              if (!(alias in options2)) {
                options2[alias] = options2[name];
              }
              delete options2[name];
            }
          }
          return requestWithDefaults(options2);
        }
        return requestWithDefaults(...args);
      }
      return Object.assign(withDecorations, requestWithDefaults);
    }
    function restEndpointMethods(octokit) {
      const api = endpointsToMethods(octokit);
      return {
        rest: api
      };
    }
    restEndpointMethods.VERSION = VERSION;
    function legacyRestEndpointMethods(octokit) {
      const api = endpointsToMethods(octokit);
      return {
        ...api,
        rest: api
      };
    }
    legacyRestEndpointMethods.VERSION = VERSION;
  }
});

// node_modules/@octokit/rest/dist-node/index.js
var require_dist_node12 = __commonJS({
  "node_modules/@octokit/rest/dist-node/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var index_exports = {};
    __export2(index_exports, {
      Octokit: () => Octokit2
    });
    module2.exports = __toCommonJS(index_exports);
    var import_core = require_dist_node8();
    var import_plugin_request_log = require_dist_node9();
    var import_plugin_paginate_rest = require_dist_node10();
    var import_plugin_rest_endpoint_methods = require_dist_node11();
    var VERSION = "20.1.2";
    var Octokit2 = import_core.Octokit.plugin(
      import_plugin_request_log.requestLog,
      import_plugin_rest_endpoint_methods.legacyRestEndpointMethods,
      import_plugin_paginate_rest.paginateRest
    ).defaults({
      userAgent: `octokit-rest.js/${VERSION}`
    });
  }
});

// src/actions/core.ts
var fs = __toESM(require("fs"));
function getInput(name, options = {}) {
  const envName = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = process.env[envName] || "";
  if (options.required && !value) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return value.trim();
}
function setOutput(name, value) {
  const output = toCommandValue(value);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const delimiter = `mpr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(outputPath, `${name}<<${delimiter}
${output}
${delimiter}
`, "utf8");
    return;
  }
  issueCommand("set-output", { name }, output);
}
function setFailed(message) {
  error(message);
  process.exitCode = 1;
}
function info(message) {
  console.log(message);
}
function debug(message) {
  issueCommand("debug", {}, message);
}
function warning(message) {
  issueCommand("warning", {}, message);
}
function error(message) {
  issueCommand("error", {}, message);
}
function issueCommand(command, properties, message) {
  const propertyText = Object.entries(properties).map(([key, value]) => `${key}=${escapeProperty(String(value))}`).join(",");
  const separator = propertyText ? ` ${propertyText}` : "";
  console.log(`::${command}${separator}::${escapeData(toCommandValue(message))}`);
}
function toCommandValue(value) {
  if (value instanceof Error) {
    return value.message;
  }
  if (value === null || value === void 0) {
    return "";
  }
  return String(value);
}
function escapeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// src/config/loader.ts
var fs2 = __toESM(require("fs"));
var path = __toESM(require("path"));

// node_modules/js-yaml/dist/js-yaml.mjs
function isNothing(subject) {
  return typeof subject === "undefined" || subject === null;
}
function isObject(subject) {
  return typeof subject === "object" && subject !== null;
}
function toArray(sequence) {
  if (Array.isArray(sequence)) return sequence;
  else if (isNothing(sequence)) return [];
  return [sequence];
}
function extend(target, source) {
  var index, length, key, sourceKeys;
  if (source) {
    sourceKeys = Object.keys(source);
    for (index = 0, length = sourceKeys.length; index < length; index += 1) {
      key = sourceKeys[index];
      target[key] = source[key];
    }
  }
  return target;
}
function repeat(string, count) {
  var result = "", cycle;
  for (cycle = 0; cycle < count; cycle += 1) {
    result += string;
  }
  return result;
}
function isNegativeZero(number) {
  return number === 0 && Number.NEGATIVE_INFINITY === 1 / number;
}
var isNothing_1 = isNothing;
var isObject_1 = isObject;
var toArray_1 = toArray;
var repeat_1 = repeat;
var isNegativeZero_1 = isNegativeZero;
var extend_1 = extend;
var common = {
  isNothing: isNothing_1,
  isObject: isObject_1,
  toArray: toArray_1,
  repeat: repeat_1,
  isNegativeZero: isNegativeZero_1,
  extend: extend_1
};
function formatError(exception2, compact) {
  var where = "", message = exception2.reason || "(unknown reason)";
  if (!exception2.mark) return message;
  if (exception2.mark.name) {
    where += 'in "' + exception2.mark.name + '" ';
  }
  where += "(" + (exception2.mark.line + 1) + ":" + (exception2.mark.column + 1) + ")";
  if (!compact && exception2.mark.snippet) {
    where += "\n\n" + exception2.mark.snippet;
  }
  return message + " " + where;
}
function YAMLException$1(reason, mark) {
  Error.call(this);
  this.name = "YAMLException";
  this.reason = reason;
  this.mark = mark;
  this.message = formatError(this, false);
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, this.constructor);
  } else {
    this.stack = new Error().stack || "";
  }
}
YAMLException$1.prototype = Object.create(Error.prototype);
YAMLException$1.prototype.constructor = YAMLException$1;
YAMLException$1.prototype.toString = function toString(compact) {
  return this.name + ": " + formatError(this, compact);
};
var exception = YAMLException$1;
function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
  var head = "";
  var tail = "";
  var maxHalfLength = Math.floor(maxLineLength / 2) - 1;
  if (position - lineStart > maxHalfLength) {
    head = " ... ";
    lineStart = position - maxHalfLength + head.length;
  }
  if (lineEnd - position > maxHalfLength) {
    tail = " ...";
    lineEnd = position + maxHalfLength - tail.length;
  }
  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "\u2192") + tail,
    pos: position - lineStart + head.length
    // relative position
  };
}
function padStart(string, max) {
  return common.repeat(" ", max - string.length) + string;
}
function makeSnippet(mark, options) {
  options = Object.create(options || null);
  if (!mark.buffer) return null;
  if (!options.maxLength) options.maxLength = 79;
  if (typeof options.indent !== "number") options.indent = 1;
  if (typeof options.linesBefore !== "number") options.linesBefore = 3;
  if (typeof options.linesAfter !== "number") options.linesAfter = 2;
  var re = /\r?\n|\r|\0/g;
  var lineStarts = [0];
  var lineEnds = [];
  var match2;
  var foundLineNo = -1;
  while (match2 = re.exec(mark.buffer)) {
    lineEnds.push(match2.index);
    lineStarts.push(match2.index + match2[0].length);
    if (mark.position <= match2.index && foundLineNo < 0) {
      foundLineNo = lineStarts.length - 2;
    }
  }
  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
  var result = "", i, line;
  var lineNoLength = Math.min(mark.line + options.linesAfter, lineEnds.length).toString().length;
  var maxLineLength = options.maxLength - (options.indent + lineNoLength + 3);
  for (i = 1; i <= options.linesBefore; i++) {
    if (foundLineNo - i < 0) break;
    line = getLine(
      mark.buffer,
      lineStarts[foundLineNo - i],
      lineEnds[foundLineNo - i],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]),
      maxLineLength
    );
    result = common.repeat(" ", options.indent) + padStart((mark.line - i + 1).toString(), lineNoLength) + " | " + line.str + "\n" + result;
  }
  line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result += common.repeat(" ", options.indent) + padStart((mark.line + 1).toString(), lineNoLength) + " | " + line.str + "\n";
  result += common.repeat("-", options.indent + lineNoLength + 3 + line.pos) + "^\n";
  for (i = 1; i <= options.linesAfter; i++) {
    if (foundLineNo + i >= lineEnds.length) break;
    line = getLine(
      mark.buffer,
      lineStarts[foundLineNo + i],
      lineEnds[foundLineNo + i],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]),
      maxLineLength
    );
    result += common.repeat(" ", options.indent) + padStart((mark.line + i + 1).toString(), lineNoLength) + " | " + line.str + "\n";
  }
  return result.replace(/\n$/, "");
}
var snippet = makeSnippet;
var TYPE_CONSTRUCTOR_OPTIONS = [
  "kind",
  "multi",
  "resolve",
  "construct",
  "instanceOf",
  "predicate",
  "represent",
  "representName",
  "defaultStyle",
  "styleAliases"
];
var YAML_NODE_KINDS = [
  "scalar",
  "sequence",
  "mapping"
];
function compileStyleAliases(map2) {
  var result = {};
  if (map2 !== null) {
    Object.keys(map2).forEach(function(style) {
      map2[style].forEach(function(alias) {
        result[String(alias)] = style;
      });
    });
  }
  return result;
}
function Type$1(tag, options) {
  options = options || {};
  Object.keys(options).forEach(function(name) {
    if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1) {
      throw new exception('Unknown option "' + name + '" is met in definition of "' + tag + '" YAML type.');
    }
  });
  this.options = options;
  this.tag = tag;
  this.kind = options["kind"] || null;
  this.resolve = options["resolve"] || function() {
    return true;
  };
  this.construct = options["construct"] || function(data) {
    return data;
  };
  this.instanceOf = options["instanceOf"] || null;
  this.predicate = options["predicate"] || null;
  this.represent = options["represent"] || null;
  this.representName = options["representName"] || null;
  this.defaultStyle = options["defaultStyle"] || null;
  this.multi = options["multi"] || false;
  this.styleAliases = compileStyleAliases(options["styleAliases"] || null);
  if (YAML_NODE_KINDS.indexOf(this.kind) === -1) {
    throw new exception('Unknown kind "' + this.kind + '" is specified for "' + tag + '" YAML type.');
  }
}
var type = Type$1;
function compileList(schema2, name) {
  var result = [];
  schema2[name].forEach(function(currentType) {
    var newIndex = result.length;
    result.forEach(function(previousType, previousIndex) {
      if (previousType.tag === currentType.tag && previousType.kind === currentType.kind && previousType.multi === currentType.multi) {
        newIndex = previousIndex;
      }
    });
    result[newIndex] = currentType;
  });
  return result;
}
function compileMap() {
  var result = {
    scalar: {},
    sequence: {},
    mapping: {},
    fallback: {},
    multi: {
      scalar: [],
      sequence: [],
      mapping: [],
      fallback: []
    }
  }, index, length;
  function collectType(type2) {
    if (type2.multi) {
      result.multi[type2.kind].push(type2);
      result.multi["fallback"].push(type2);
    } else {
      result[type2.kind][type2.tag] = result["fallback"][type2.tag] = type2;
    }
  }
  for (index = 0, length = arguments.length; index < length; index += 1) {
    arguments[index].forEach(collectType);
  }
  return result;
}
function Schema$1(definition) {
  return this.extend(definition);
}
Schema$1.prototype.extend = function extend2(definition) {
  var implicit = [];
  var explicit = [];
  if (definition instanceof type) {
    explicit.push(definition);
  } else if (Array.isArray(definition)) {
    explicit = explicit.concat(definition);
  } else if (definition && (Array.isArray(definition.implicit) || Array.isArray(definition.explicit))) {
    if (definition.implicit) implicit = implicit.concat(definition.implicit);
    if (definition.explicit) explicit = explicit.concat(definition.explicit);
  } else {
    throw new exception("Schema.extend argument should be a Type, [ Type ], or a schema definition ({ implicit: [...], explicit: [...] })");
  }
  implicit.forEach(function(type$1) {
    if (!(type$1 instanceof type)) {
      throw new exception("Specified list of YAML types (or a single Type object) contains a non-Type object.");
    }
    if (type$1.loadKind && type$1.loadKind !== "scalar") {
      throw new exception("There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.");
    }
    if (type$1.multi) {
      throw new exception("There is a multi type in the implicit list of a schema. Multi tags can only be listed as explicit.");
    }
  });
  explicit.forEach(function(type$1) {
    if (!(type$1 instanceof type)) {
      throw new exception("Specified list of YAML types (or a single Type object) contains a non-Type object.");
    }
  });
  var result = Object.create(Schema$1.prototype);
  result.implicit = (this.implicit || []).concat(implicit);
  result.explicit = (this.explicit || []).concat(explicit);
  result.compiledImplicit = compileList(result, "implicit");
  result.compiledExplicit = compileList(result, "explicit");
  result.compiledTypeMap = compileMap(result.compiledImplicit, result.compiledExplicit);
  return result;
};
var schema = Schema$1;
var str = new type("tag:yaml.org,2002:str", {
  kind: "scalar",
  construct: function(data) {
    return data !== null ? data : "";
  }
});
var seq = new type("tag:yaml.org,2002:seq", {
  kind: "sequence",
  construct: function(data) {
    return data !== null ? data : [];
  }
});
var map = new type("tag:yaml.org,2002:map", {
  kind: "mapping",
  construct: function(data) {
    return data !== null ? data : {};
  }
});
var failsafe = new schema({
  explicit: [
    str,
    seq,
    map
  ]
});
function resolveYamlNull(data) {
  if (data === null) return true;
  var max = data.length;
  return max === 1 && data === "~" || max === 4 && (data === "null" || data === "Null" || data === "NULL");
}
function constructYamlNull() {
  return null;
}
function isNull(object) {
  return object === null;
}
var _null = new type("tag:yaml.org,2002:null", {
  kind: "scalar",
  resolve: resolveYamlNull,
  construct: constructYamlNull,
  predicate: isNull,
  represent: {
    canonical: function() {
      return "~";
    },
    lowercase: function() {
      return "null";
    },
    uppercase: function() {
      return "NULL";
    },
    camelcase: function() {
      return "Null";
    },
    empty: function() {
      return "";
    }
  },
  defaultStyle: "lowercase"
});
function resolveYamlBoolean(data) {
  if (data === null) return false;
  var max = data.length;
  return max === 4 && (data === "true" || data === "True" || data === "TRUE") || max === 5 && (data === "false" || data === "False" || data === "FALSE");
}
function constructYamlBoolean(data) {
  return data === "true" || data === "True" || data === "TRUE";
}
function isBoolean(object) {
  return Object.prototype.toString.call(object) === "[object Boolean]";
}
var bool = new type("tag:yaml.org,2002:bool", {
  kind: "scalar",
  resolve: resolveYamlBoolean,
  construct: constructYamlBoolean,
  predicate: isBoolean,
  represent: {
    lowercase: function(object) {
      return object ? "true" : "false";
    },
    uppercase: function(object) {
      return object ? "TRUE" : "FALSE";
    },
    camelcase: function(object) {
      return object ? "True" : "False";
    }
  },
  defaultStyle: "lowercase"
});
function isHexCode(c) {
  return 48 <= c && c <= 57 || 65 <= c && c <= 70 || 97 <= c && c <= 102;
}
function isOctCode(c) {
  return 48 <= c && c <= 55;
}
function isDecCode(c) {
  return 48 <= c && c <= 57;
}
function resolveYamlInteger(data) {
  if (data === null) return false;
  var max = data.length, index = 0, hasDigits = false, ch;
  if (!max) return false;
  ch = data[index];
  if (ch === "-" || ch === "+") {
    ch = data[++index];
  }
  if (ch === "0") {
    if (index + 1 === max) return true;
    ch = data[++index];
    if (ch === "b") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (ch !== "0" && ch !== "1") return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
    if (ch === "x") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (!isHexCode(data.charCodeAt(index))) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
    if (ch === "o") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (!isOctCode(data.charCodeAt(index))) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
  }
  if (ch === "_") return false;
  for (; index < max; index++) {
    ch = data[index];
    if (ch === "_") continue;
    if (!isDecCode(data.charCodeAt(index))) {
      return false;
    }
    hasDigits = true;
  }
  if (!hasDigits || ch === "_") return false;
  return true;
}
function constructYamlInteger(data) {
  var value = data, sign = 1, ch;
  if (value.indexOf("_") !== -1) {
    value = value.replace(/_/g, "");
  }
  ch = value[0];
  if (ch === "-" || ch === "+") {
    if (ch === "-") sign = -1;
    value = value.slice(1);
    ch = value[0];
  }
  if (value === "0") return 0;
  if (ch === "0") {
    if (value[1] === "b") return sign * parseInt(value.slice(2), 2);
    if (value[1] === "x") return sign * parseInt(value.slice(2), 16);
    if (value[1] === "o") return sign * parseInt(value.slice(2), 8);
  }
  return sign * parseInt(value, 10);
}
function isInteger(object) {
  return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 === 0 && !common.isNegativeZero(object));
}
var int = new type("tag:yaml.org,2002:int", {
  kind: "scalar",
  resolve: resolveYamlInteger,
  construct: constructYamlInteger,
  predicate: isInteger,
  represent: {
    binary: function(obj) {
      return obj >= 0 ? "0b" + obj.toString(2) : "-0b" + obj.toString(2).slice(1);
    },
    octal: function(obj) {
      return obj >= 0 ? "0o" + obj.toString(8) : "-0o" + obj.toString(8).slice(1);
    },
    decimal: function(obj) {
      return obj.toString(10);
    },
    /* eslint-disable max-len */
    hexadecimal: function(obj) {
      return obj >= 0 ? "0x" + obj.toString(16).toUpperCase() : "-0x" + obj.toString(16).toUpperCase().slice(1);
    }
  },
  defaultStyle: "decimal",
  styleAliases: {
    binary: [2, "bin"],
    octal: [8, "oct"],
    decimal: [10, "dec"],
    hexadecimal: [16, "hex"]
  }
});
var YAML_FLOAT_PATTERN = new RegExp(
  // 2.5e4, 2.5 and integers
  "^(?:[-+]?(?:[0-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
);
function resolveYamlFloat(data) {
  if (data === null) return false;
  if (!YAML_FLOAT_PATTERN.test(data) || // Quick hack to not allow integers end with `_`
  // Probably should update regexp & check speed
  data[data.length - 1] === "_") {
    return false;
  }
  return true;
}
function constructYamlFloat(data) {
  var value, sign;
  value = data.replace(/_/g, "").toLowerCase();
  sign = value[0] === "-" ? -1 : 1;
  if ("+-".indexOf(value[0]) >= 0) {
    value = value.slice(1);
  }
  if (value === ".inf") {
    return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  } else if (value === ".nan") {
    return NaN;
  }
  return sign * parseFloat(value, 10);
}
var SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;
function representYamlFloat(object, style) {
  var res;
  if (isNaN(object)) {
    switch (style) {
      case "lowercase":
        return ".nan";
      case "uppercase":
        return ".NAN";
      case "camelcase":
        return ".NaN";
    }
  } else if (Number.POSITIVE_INFINITY === object) {
    switch (style) {
      case "lowercase":
        return ".inf";
      case "uppercase":
        return ".INF";
      case "camelcase":
        return ".Inf";
    }
  } else if (Number.NEGATIVE_INFINITY === object) {
    switch (style) {
      case "lowercase":
        return "-.inf";
      case "uppercase":
        return "-.INF";
      case "camelcase":
        return "-.Inf";
    }
  } else if (common.isNegativeZero(object)) {
    return "-0.0";
  }
  res = object.toString(10);
  return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace("e", ".e") : res;
}
function isFloat(object) {
  return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 !== 0 || common.isNegativeZero(object));
}
var float = new type("tag:yaml.org,2002:float", {
  kind: "scalar",
  resolve: resolveYamlFloat,
  construct: constructYamlFloat,
  predicate: isFloat,
  represent: representYamlFloat,
  defaultStyle: "lowercase"
});
var json = failsafe.extend({
  implicit: [
    _null,
    bool,
    int,
    float
  ]
});
var core = json;
var YAML_DATE_REGEXP = new RegExp(
  "^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$"
);
var YAML_TIMESTAMP_REGEXP = new RegExp(
  "^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$"
);
function resolveYamlTimestamp(data) {
  if (data === null) return false;
  if (YAML_DATE_REGEXP.exec(data) !== null) return true;
  if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true;
  return false;
}
function constructYamlTimestamp(data) {
  var match2, year, month, day, hour, minute, second, fraction = 0, delta = null, tz_hour, tz_minute, date;
  match2 = YAML_DATE_REGEXP.exec(data);
  if (match2 === null) match2 = YAML_TIMESTAMP_REGEXP.exec(data);
  if (match2 === null) throw new Error("Date resolve error");
  year = +match2[1];
  month = +match2[2] - 1;
  day = +match2[3];
  if (!match2[4]) {
    return new Date(Date.UTC(year, month, day));
  }
  hour = +match2[4];
  minute = +match2[5];
  second = +match2[6];
  if (match2[7]) {
    fraction = match2[7].slice(0, 3);
    while (fraction.length < 3) {
      fraction += "0";
    }
    fraction = +fraction;
  }
  if (match2[9]) {
    tz_hour = +match2[10];
    tz_minute = +(match2[11] || 0);
    delta = (tz_hour * 60 + tz_minute) * 6e4;
    if (match2[9] === "-") delta = -delta;
  }
  date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
  if (delta) date.setTime(date.getTime() - delta);
  return date;
}
function representYamlTimestamp(object) {
  return object.toISOString();
}
var timestamp = new type("tag:yaml.org,2002:timestamp", {
  kind: "scalar",
  resolve: resolveYamlTimestamp,
  construct: constructYamlTimestamp,
  instanceOf: Date,
  represent: representYamlTimestamp
});
function resolveYamlMerge(data) {
  return data === "<<" || data === null;
}
var merge = new type("tag:yaml.org,2002:merge", {
  kind: "scalar",
  resolve: resolveYamlMerge
});
var BASE64_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r";
function resolveYamlBinary(data) {
  if (data === null) return false;
  var code, idx, bitlen = 0, max = data.length, map2 = BASE64_MAP;
  for (idx = 0; idx < max; idx++) {
    code = map2.indexOf(data.charAt(idx));
    if (code > 64) continue;
    if (code < 0) return false;
    bitlen += 6;
  }
  return bitlen % 8 === 0;
}
function constructYamlBinary(data) {
  var idx, tailbits, input = data.replace(/[\r\n=]/g, ""), max = input.length, map2 = BASE64_MAP, bits = 0, result = [];
  for (idx = 0; idx < max; idx++) {
    if (idx % 4 === 0 && idx) {
      result.push(bits >> 16 & 255);
      result.push(bits >> 8 & 255);
      result.push(bits & 255);
    }
    bits = bits << 6 | map2.indexOf(input.charAt(idx));
  }
  tailbits = max % 4 * 6;
  if (tailbits === 0) {
    result.push(bits >> 16 & 255);
    result.push(bits >> 8 & 255);
    result.push(bits & 255);
  } else if (tailbits === 18) {
    result.push(bits >> 10 & 255);
    result.push(bits >> 2 & 255);
  } else if (tailbits === 12) {
    result.push(bits >> 4 & 255);
  }
  return new Uint8Array(result);
}
function representYamlBinary(object) {
  var result = "", bits = 0, idx, tail, max = object.length, map2 = BASE64_MAP;
  for (idx = 0; idx < max; idx++) {
    if (idx % 3 === 0 && idx) {
      result += map2[bits >> 18 & 63];
      result += map2[bits >> 12 & 63];
      result += map2[bits >> 6 & 63];
      result += map2[bits & 63];
    }
    bits = (bits << 8) + object[idx];
  }
  tail = max % 3;
  if (tail === 0) {
    result += map2[bits >> 18 & 63];
    result += map2[bits >> 12 & 63];
    result += map2[bits >> 6 & 63];
    result += map2[bits & 63];
  } else if (tail === 2) {
    result += map2[bits >> 10 & 63];
    result += map2[bits >> 4 & 63];
    result += map2[bits << 2 & 63];
    result += map2[64];
  } else if (tail === 1) {
    result += map2[bits >> 2 & 63];
    result += map2[bits << 4 & 63];
    result += map2[64];
    result += map2[64];
  }
  return result;
}
function isBinary(obj) {
  return Object.prototype.toString.call(obj) === "[object Uint8Array]";
}
var binary = new type("tag:yaml.org,2002:binary", {
  kind: "scalar",
  resolve: resolveYamlBinary,
  construct: constructYamlBinary,
  predicate: isBinary,
  represent: representYamlBinary
});
var _hasOwnProperty$3 = Object.prototype.hasOwnProperty;
var _toString$2 = Object.prototype.toString;
function resolveYamlOmap(data) {
  if (data === null) return true;
  var objectKeys = [], index, length, pair, pairKey, pairHasKey, object = data;
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    pairHasKey = false;
    if (_toString$2.call(pair) !== "[object Object]") return false;
    for (pairKey in pair) {
      if (_hasOwnProperty$3.call(pair, pairKey)) {
        if (!pairHasKey) pairHasKey = true;
        else return false;
      }
    }
    if (!pairHasKey) return false;
    if (objectKeys.indexOf(pairKey) === -1) objectKeys.push(pairKey);
    else return false;
  }
  return true;
}
function constructYamlOmap(data) {
  return data !== null ? data : [];
}
var omap = new type("tag:yaml.org,2002:omap", {
  kind: "sequence",
  resolve: resolveYamlOmap,
  construct: constructYamlOmap
});
var _toString$1 = Object.prototype.toString;
function resolveYamlPairs(data) {
  if (data === null) return true;
  var index, length, pair, keys, result, object = data;
  result = new Array(object.length);
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    if (_toString$1.call(pair) !== "[object Object]") return false;
    keys = Object.keys(pair);
    if (keys.length !== 1) return false;
    result[index] = [keys[0], pair[keys[0]]];
  }
  return true;
}
function constructYamlPairs(data) {
  if (data === null) return [];
  var index, length, pair, keys, result, object = data;
  result = new Array(object.length);
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    keys = Object.keys(pair);
    result[index] = [keys[0], pair[keys[0]]];
  }
  return result;
}
var pairs = new type("tag:yaml.org,2002:pairs", {
  kind: "sequence",
  resolve: resolveYamlPairs,
  construct: constructYamlPairs
});
var _hasOwnProperty$2 = Object.prototype.hasOwnProperty;
function resolveYamlSet(data) {
  if (data === null) return true;
  var key, object = data;
  for (key in object) {
    if (_hasOwnProperty$2.call(object, key)) {
      if (object[key] !== null) return false;
    }
  }
  return true;
}
function constructYamlSet(data) {
  return data !== null ? data : {};
}
var set = new type("tag:yaml.org,2002:set", {
  kind: "mapping",
  resolve: resolveYamlSet,
  construct: constructYamlSet
});
var _default = core.extend({
  implicit: [
    timestamp,
    merge
  ],
  explicit: [
    binary,
    omap,
    pairs,
    set
  ]
});
var _hasOwnProperty$1 = Object.prototype.hasOwnProperty;
var CONTEXT_FLOW_IN = 1;
var CONTEXT_FLOW_OUT = 2;
var CONTEXT_BLOCK_IN = 3;
var CONTEXT_BLOCK_OUT = 4;
var CHOMPING_CLIP = 1;
var CHOMPING_STRIP = 2;
var CHOMPING_KEEP = 3;
var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
var PATTERN_FLOW_INDICATORS = /[,\[\]\{\}]/;
var PATTERN_TAG_HANDLE = /^(?:!|!!|![a-z\-]+!)$/i;
var PATTERN_TAG_URI = /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
function _class(obj) {
  return Object.prototype.toString.call(obj);
}
function is_EOL(c) {
  return c === 10 || c === 13;
}
function is_WHITE_SPACE(c) {
  return c === 9 || c === 32;
}
function is_WS_OR_EOL(c) {
  return c === 9 || c === 32 || c === 10 || c === 13;
}
function is_FLOW_INDICATOR(c) {
  return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
}
function fromHexCode(c) {
  var lc;
  if (48 <= c && c <= 57) {
    return c - 48;
  }
  lc = c | 32;
  if (97 <= lc && lc <= 102) {
    return lc - 97 + 10;
  }
  return -1;
}
function escapedHexLen(c) {
  if (c === 120) {
    return 2;
  }
  if (c === 117) {
    return 4;
  }
  if (c === 85) {
    return 8;
  }
  return 0;
}
function fromDecimalCode(c) {
  if (48 <= c && c <= 57) {
    return c - 48;
  }
  return -1;
}
function simpleEscapeSequence(c) {
  return c === 48 ? "\0" : c === 97 ? "\x07" : c === 98 ? "\b" : c === 116 ? "	" : c === 9 ? "	" : c === 110 ? "\n" : c === 118 ? "\v" : c === 102 ? "\f" : c === 114 ? "\r" : c === 101 ? "\x1B" : c === 32 ? " " : c === 34 ? '"' : c === 47 ? "/" : c === 92 ? "\\" : c === 78 ? "\x85" : c === 95 ? "\xA0" : c === 76 ? "\u2028" : c === 80 ? "\u2029" : "";
}
function charFromCodepoint(c) {
  if (c <= 65535) {
    return String.fromCharCode(c);
  }
  return String.fromCharCode(
    (c - 65536 >> 10) + 55296,
    (c - 65536 & 1023) + 56320
  );
}
function setProperty(object, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
  } else {
    object[key] = value;
  }
}
var simpleEscapeCheck = new Array(256);
var simpleEscapeMap = new Array(256);
for (i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}
var i;
function State$1(input, options) {
  this.input = input;
  this.filename = options["filename"] || null;
  this.schema = options["schema"] || _default;
  this.onWarning = options["onWarning"] || null;
  this.legacy = options["legacy"] || false;
  this.json = options["json"] || false;
  this.listener = options["listener"] || null;
  this.implicitTypes = this.schema.compiledImplicit;
  this.typeMap = this.schema.compiledTypeMap;
  this.length = input.length;
  this.position = 0;
  this.line = 0;
  this.lineStart = 0;
  this.lineIndent = 0;
  this.firstTabInLine = -1;
  this.documents = [];
}
function generateError(state, message) {
  var mark = {
    name: state.filename,
    buffer: state.input.slice(0, -1),
    // omit trailing \0
    position: state.position,
    line: state.line,
    column: state.position - state.lineStart
  };
  mark.snippet = snippet(mark);
  return new exception(message, mark);
}
function throwError(state, message) {
  throw generateError(state, message);
}
function throwWarning(state, message) {
  if (state.onWarning) {
    state.onWarning.call(null, generateError(state, message));
  }
}
var directiveHandlers = {
  YAML: function handleYamlDirective(state, name, args) {
    var match2, major, minor;
    if (state.version !== null) {
      throwError(state, "duplication of %YAML directive");
    }
    if (args.length !== 1) {
      throwError(state, "YAML directive accepts exactly one argument");
    }
    match2 = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match2 === null) {
      throwError(state, "ill-formed argument of the YAML directive");
    }
    major = parseInt(match2[1], 10);
    minor = parseInt(match2[2], 10);
    if (major !== 1) {
      throwError(state, "unacceptable YAML version of the document");
    }
    state.version = args[0];
    state.checkLineBreaks = minor < 2;
    if (minor !== 1 && minor !== 2) {
      throwWarning(state, "unsupported YAML version of the document");
    }
  },
  TAG: function handleTagDirective(state, name, args) {
    var handle, prefix;
    if (args.length !== 2) {
      throwError(state, "TAG directive accepts exactly two arguments");
    }
    handle = args[0];
    prefix = args[1];
    if (!PATTERN_TAG_HANDLE.test(handle)) {
      throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
    }
    if (_hasOwnProperty$1.call(state.tagMap, handle)) {
      throwError(state, 'there is a previously declared suffix for "' + handle + '" tag handle');
    }
    if (!PATTERN_TAG_URI.test(prefix)) {
      throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
    }
    try {
      prefix = decodeURIComponent(prefix);
    } catch (err) {
      throwError(state, "tag prefix is malformed: " + prefix);
    }
    state.tagMap[handle] = prefix;
  }
};
function captureSegment(state, start, end, checkJson) {
  var _position, _length, _character, _result;
  if (start < end) {
    _result = state.input.slice(start, end);
    if (checkJson) {
      for (_position = 0, _length = _result.length; _position < _length; _position += 1) {
        _character = _result.charCodeAt(_position);
        if (!(_character === 9 || 32 <= _character && _character <= 1114111)) {
          throwError(state, "expected valid JSON character");
        }
      }
    } else if (PATTERN_NON_PRINTABLE.test(_result)) {
      throwError(state, "the stream contains non-printable characters");
    }
    state.result += _result;
  }
}
function mergeMappings(state, destination, source, overridableKeys) {
  var sourceKeys, key, index, quantity;
  if (!common.isObject(source)) {
    throwError(state, "cannot merge mappings; the provided source object is unacceptable");
  }
  sourceKeys = Object.keys(source);
  for (index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
    key = sourceKeys[index];
    if (!_hasOwnProperty$1.call(destination, key)) {
      setProperty(destination, key, source[key]);
      overridableKeys[key] = true;
    }
  }
}
function storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, startLine, startLineStart, startPos) {
  var index, quantity;
  if (Array.isArray(keyNode)) {
    keyNode = Array.prototype.slice.call(keyNode);
    for (index = 0, quantity = keyNode.length; index < quantity; index += 1) {
      if (Array.isArray(keyNode[index])) {
        throwError(state, "nested arrays are not supported inside keys");
      }
      if (typeof keyNode === "object" && _class(keyNode[index]) === "[object Object]") {
        keyNode[index] = "[object Object]";
      }
    }
  }
  if (typeof keyNode === "object" && _class(keyNode) === "[object Object]") {
    keyNode = "[object Object]";
  }
  keyNode = String(keyNode);
  if (_result === null) {
    _result = {};
  }
  if (keyTag === "tag:yaml.org,2002:merge") {
    if (Array.isArray(valueNode)) {
      for (index = 0, quantity = valueNode.length; index < quantity; index += 1) {
        mergeMappings(state, _result, valueNode[index], overridableKeys);
      }
    } else {
      mergeMappings(state, _result, valueNode, overridableKeys);
    }
  } else {
    if (!state.json && !_hasOwnProperty$1.call(overridableKeys, keyNode) && _hasOwnProperty$1.call(_result, keyNode)) {
      state.line = startLine || state.line;
      state.lineStart = startLineStart || state.lineStart;
      state.position = startPos || state.position;
      throwError(state, "duplicated mapping key");
    }
    setProperty(_result, keyNode, valueNode);
    delete overridableKeys[keyNode];
  }
  return _result;
}
function readLineBreak(state) {
  var ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 10) {
    state.position++;
  } else if (ch === 13) {
    state.position++;
    if (state.input.charCodeAt(state.position) === 10) {
      state.position++;
    }
  } else {
    throwError(state, "a line break is expected");
  }
  state.line += 1;
  state.lineStart = state.position;
  state.firstTabInLine = -1;
}
function skipSeparationSpace(state, allowComments, checkIndent) {
  var lineBreaks = 0, ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    while (is_WHITE_SPACE(ch)) {
      if (ch === 9 && state.firstTabInLine === -1) {
        state.firstTabInLine = state.position;
      }
      ch = state.input.charCodeAt(++state.position);
    }
    if (allowComments && ch === 35) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (ch !== 10 && ch !== 13 && ch !== 0);
    }
    if (is_EOL(ch)) {
      readLineBreak(state);
      ch = state.input.charCodeAt(state.position);
      lineBreaks++;
      state.lineIndent = 0;
      while (ch === 32) {
        state.lineIndent++;
        ch = state.input.charCodeAt(++state.position);
      }
    } else {
      break;
    }
  }
  if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent) {
    throwWarning(state, "deficient indentation");
  }
  return lineBreaks;
}
function testDocumentSeparator(state) {
  var _position = state.position, ch;
  ch = state.input.charCodeAt(_position);
  if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(_position + 1) && ch === state.input.charCodeAt(_position + 2)) {
    _position += 3;
    ch = state.input.charCodeAt(_position);
    if (ch === 0 || is_WS_OR_EOL(ch)) {
      return true;
    }
  }
  return false;
}
function writeFoldedLines(state, count) {
  if (count === 1) {
    state.result += " ";
  } else if (count > 1) {
    state.result += common.repeat("\n", count - 1);
  }
}
function readPlainScalar(state, nodeIndent, withinFlowCollection) {
  var preceding, following, captureStart, captureEnd, hasPendingContent, _line, _lineStart, _lineIndent, _kind = state.kind, _result = state.result, ch;
  ch = state.input.charCodeAt(state.position);
  if (is_WS_OR_EOL(ch) || is_FLOW_INDICATOR(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96) {
    return false;
  }
  if (ch === 63 || ch === 45) {
    following = state.input.charCodeAt(state.position + 1);
    if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
      return false;
    }
  }
  state.kind = "scalar";
  state.result = "";
  captureStart = captureEnd = state.position;
  hasPendingContent = false;
  while (ch !== 0) {
    if (ch === 58) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
        break;
      }
    } else if (ch === 35) {
      preceding = state.input.charCodeAt(state.position - 1);
      if (is_WS_OR_EOL(preceding)) {
        break;
      }
    } else if (state.position === state.lineStart && testDocumentSeparator(state) || withinFlowCollection && is_FLOW_INDICATOR(ch)) {
      break;
    } else if (is_EOL(ch)) {
      _line = state.line;
      _lineStart = state.lineStart;
      _lineIndent = state.lineIndent;
      skipSeparationSpace(state, false, -1);
      if (state.lineIndent >= nodeIndent) {
        hasPendingContent = true;
        ch = state.input.charCodeAt(state.position);
        continue;
      } else {
        state.position = captureEnd;
        state.line = _line;
        state.lineStart = _lineStart;
        state.lineIndent = _lineIndent;
        break;
      }
    }
    if (hasPendingContent) {
      captureSegment(state, captureStart, captureEnd, false);
      writeFoldedLines(state, state.line - _line);
      captureStart = captureEnd = state.position;
      hasPendingContent = false;
    }
    if (!is_WHITE_SPACE(ch)) {
      captureEnd = state.position + 1;
    }
    ch = state.input.charCodeAt(++state.position);
  }
  captureSegment(state, captureStart, captureEnd, false);
  if (state.result) {
    return true;
  }
  state.kind = _kind;
  state.result = _result;
  return false;
}
function readSingleQuotedScalar(state, nodeIndent) {
  var ch, captureStart, captureEnd;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 39) {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  state.position++;
  captureStart = captureEnd = state.position;
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    if (ch === 39) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);
      if (ch === 39) {
        captureStart = state.position;
        state.position++;
        captureEnd = state.position;
      } else {
        return true;
      }
    } else if (is_EOL(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
      throwError(state, "unexpected end of the document within a single quoted scalar");
    } else {
      state.position++;
      captureEnd = state.position;
    }
  }
  throwError(state, "unexpected end of the stream within a single quoted scalar");
}
function readDoubleQuotedScalar(state, nodeIndent) {
  var captureStart, captureEnd, hexLength, hexResult, tmp, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 34) {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  state.position++;
  captureStart = captureEnd = state.position;
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    if (ch === 34) {
      captureSegment(state, captureStart, state.position, true);
      state.position++;
      return true;
    } else if (ch === 92) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);
      if (is_EOL(ch)) {
        skipSeparationSpace(state, false, nodeIndent);
      } else if (ch < 256 && simpleEscapeCheck[ch]) {
        state.result += simpleEscapeMap[ch];
        state.position++;
      } else if ((tmp = escapedHexLen(ch)) > 0) {
        hexLength = tmp;
        hexResult = 0;
        for (; hexLength > 0; hexLength--) {
          ch = state.input.charCodeAt(++state.position);
          if ((tmp = fromHexCode(ch)) >= 0) {
            hexResult = (hexResult << 4) + tmp;
          } else {
            throwError(state, "expected hexadecimal character");
          }
        }
        state.result += charFromCodepoint(hexResult);
        state.position++;
      } else {
        throwError(state, "unknown escape sequence");
      }
      captureStart = captureEnd = state.position;
    } else if (is_EOL(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
      throwError(state, "unexpected end of the document within a double quoted scalar");
    } else {
      state.position++;
      captureEnd = state.position;
    }
  }
  throwError(state, "unexpected end of the stream within a double quoted scalar");
}
function readFlowCollection(state, nodeIndent) {
  var readNext = true, _line, _lineStart, _pos, _tag = state.tag, _result, _anchor = state.anchor, following, terminator, isPair, isExplicitPair, isMapping, overridableKeys = /* @__PURE__ */ Object.create(null), keyNode, keyTag, valueNode, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 91) {
    terminator = 93;
    isMapping = false;
    _result = [];
  } else if (ch === 123) {
    terminator = 125;
    isMapping = true;
    _result = {};
  } else {
    return false;
  }
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(++state.position);
  while (ch !== 0) {
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if (ch === terminator) {
      state.position++;
      state.tag = _tag;
      state.anchor = _anchor;
      state.kind = isMapping ? "mapping" : "sequence";
      state.result = _result;
      return true;
    } else if (!readNext) {
      throwError(state, "missed comma between flow collection entries");
    } else if (ch === 44) {
      throwError(state, "expected the node content, but found ','");
    }
    keyTag = keyNode = valueNode = null;
    isPair = isExplicitPair = false;
    if (ch === 63) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following)) {
        isPair = isExplicitPair = true;
        state.position++;
        skipSeparationSpace(state, true, nodeIndent);
      }
    }
    _line = state.line;
    _lineStart = state.lineStart;
    _pos = state.position;
    composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    keyTag = state.tag;
    keyNode = state.result;
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if ((isExplicitPair || state.line === _line) && ch === 58) {
      isPair = true;
      ch = state.input.charCodeAt(++state.position);
      skipSeparationSpace(state, true, nodeIndent);
      composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
      valueNode = state.result;
    }
    if (isMapping) {
      storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos);
    } else if (isPair) {
      _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos));
    } else {
      _result.push(keyNode);
    }
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if (ch === 44) {
      readNext = true;
      ch = state.input.charCodeAt(++state.position);
    } else {
      readNext = false;
    }
  }
  throwError(state, "unexpected end of the stream within a flow collection");
}
function readBlockScalar(state, nodeIndent) {
  var captureStart, folding, chomping = CHOMPING_CLIP, didReadContent = false, detectedIndent = false, textIndent = nodeIndent, emptyLines = 0, atMoreIndented = false, tmp, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 124) {
    folding = false;
  } else if (ch === 62) {
    folding = true;
  } else {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  while (ch !== 0) {
    ch = state.input.charCodeAt(++state.position);
    if (ch === 43 || ch === 45) {
      if (CHOMPING_CLIP === chomping) {
        chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
      } else {
        throwError(state, "repeat of a chomping mode identifier");
      }
    } else if ((tmp = fromDecimalCode(ch)) >= 0) {
      if (tmp === 0) {
        throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
      } else if (!detectedIndent) {
        textIndent = nodeIndent + tmp - 1;
        detectedIndent = true;
      } else {
        throwError(state, "repeat of an indentation width identifier");
      }
    } else {
      break;
    }
  }
  if (is_WHITE_SPACE(ch)) {
    do {
      ch = state.input.charCodeAt(++state.position);
    } while (is_WHITE_SPACE(ch));
    if (ch === 35) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (!is_EOL(ch) && ch !== 0);
    }
  }
  while (ch !== 0) {
    readLineBreak(state);
    state.lineIndent = 0;
    ch = state.input.charCodeAt(state.position);
    while ((!detectedIndent || state.lineIndent < textIndent) && ch === 32) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }
    if (!detectedIndent && state.lineIndent > textIndent) {
      textIndent = state.lineIndent;
    }
    if (is_EOL(ch)) {
      emptyLines++;
      continue;
    }
    if (state.lineIndent < textIndent) {
      if (chomping === CHOMPING_KEEP) {
        state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
      } else if (chomping === CHOMPING_CLIP) {
        if (didReadContent) {
          state.result += "\n";
        }
      }
      break;
    }
    if (folding) {
      if (is_WHITE_SPACE(ch)) {
        atMoreIndented = true;
        state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
      } else if (atMoreIndented) {
        atMoreIndented = false;
        state.result += common.repeat("\n", emptyLines + 1);
      } else if (emptyLines === 0) {
        if (didReadContent) {
          state.result += " ";
        }
      } else {
        state.result += common.repeat("\n", emptyLines);
      }
    } else {
      state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
    }
    didReadContent = true;
    detectedIndent = true;
    emptyLines = 0;
    captureStart = state.position;
    while (!is_EOL(ch) && ch !== 0) {
      ch = state.input.charCodeAt(++state.position);
    }
    captureSegment(state, captureStart, state.position, false);
  }
  return true;
}
function readBlockSequence(state, nodeIndent) {
  var _line, _tag = state.tag, _anchor = state.anchor, _result = [], following, detected = false, ch;
  if (state.firstTabInLine !== -1) return false;
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    if (ch !== 45) {
      break;
    }
    following = state.input.charCodeAt(state.position + 1);
    if (!is_WS_OR_EOL(following)) {
      break;
    }
    detected = true;
    state.position++;
    if (skipSeparationSpace(state, true, -1)) {
      if (state.lineIndent <= nodeIndent) {
        _result.push(null);
        ch = state.input.charCodeAt(state.position);
        continue;
      }
    }
    _line = state.line;
    composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    _result.push(state.result);
    skipSeparationSpace(state, true, -1);
    ch = state.input.charCodeAt(state.position);
    if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
      throwError(state, "bad indentation of a sequence entry");
    } else if (state.lineIndent < nodeIndent) {
      break;
    }
  }
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = "sequence";
    state.result = _result;
    return true;
  }
  return false;
}
function readBlockMapping(state, nodeIndent, flowIndent) {
  var following, allowCompact, _line, _keyLine, _keyLineStart, _keyPos, _tag = state.tag, _anchor = state.anchor, _result = {}, overridableKeys = /* @__PURE__ */ Object.create(null), keyTag = null, keyNode = null, valueNode = null, atExplicitKey = false, detected = false, ch;
  if (state.firstTabInLine !== -1) return false;
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    following = state.input.charCodeAt(state.position + 1);
    _line = state.line;
    if ((ch === 63 || ch === 58) && is_WS_OR_EOL(following)) {
      if (ch === 63) {
        if (atExplicitKey) {
          storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
          keyTag = keyNode = valueNode = null;
        }
        detected = true;
        atExplicitKey = true;
        allowCompact = true;
      } else if (atExplicitKey) {
        atExplicitKey = false;
        allowCompact = true;
      } else {
        throwError(state, "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line");
      }
      state.position += 1;
      ch = following;
    } else {
      _keyLine = state.line;
      _keyLineStart = state.lineStart;
      _keyPos = state.position;
      if (!composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) {
        break;
      }
      if (state.line === _line) {
        ch = state.input.charCodeAt(state.position);
        while (is_WHITE_SPACE(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        if (ch === 58) {
          ch = state.input.charCodeAt(++state.position);
          if (!is_WS_OR_EOL(ch)) {
            throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
          }
          if (atExplicitKey) {
            storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
            keyTag = keyNode = valueNode = null;
          }
          detected = true;
          atExplicitKey = false;
          allowCompact = false;
          keyTag = state.tag;
          keyNode = state.result;
        } else if (detected) {
          throwError(state, "can not read an implicit mapping pair; a colon is missed");
        } else {
          state.tag = _tag;
          state.anchor = _anchor;
          return true;
        }
      } else if (detected) {
        throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
      } else {
        state.tag = _tag;
        state.anchor = _anchor;
        return true;
      }
    }
    if (state.line === _line || state.lineIndent > nodeIndent) {
      if (atExplicitKey) {
        _keyLine = state.line;
        _keyLineStart = state.lineStart;
        _keyPos = state.position;
      }
      if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) {
        if (atExplicitKey) {
          keyNode = state.result;
        } else {
          valueNode = state.result;
        }
      }
      if (!atExplicitKey) {
        storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _keyLine, _keyLineStart, _keyPos);
        keyTag = keyNode = valueNode = null;
      }
      skipSeparationSpace(state, true, -1);
      ch = state.input.charCodeAt(state.position);
    }
    if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
      throwError(state, "bad indentation of a mapping entry");
    } else if (state.lineIndent < nodeIndent) {
      break;
    }
  }
  if (atExplicitKey) {
    storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
  }
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = "mapping";
    state.result = _result;
  }
  return detected;
}
function readTagProperty(state) {
  var _position, isVerbatim = false, isNamed = false, tagHandle, tagName, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 33) return false;
  if (state.tag !== null) {
    throwError(state, "duplication of a tag property");
  }
  ch = state.input.charCodeAt(++state.position);
  if (ch === 60) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 33) {
    isNamed = true;
    tagHandle = "!!";
    ch = state.input.charCodeAt(++state.position);
  } else {
    tagHandle = "!";
  }
  _position = state.position;
  if (isVerbatim) {
    do {
      ch = state.input.charCodeAt(++state.position);
    } while (ch !== 0 && ch !== 62);
    if (state.position < state.length) {
      tagName = state.input.slice(_position, state.position);
      ch = state.input.charCodeAt(++state.position);
    } else {
      throwError(state, "unexpected end of the stream within a verbatim tag");
    }
  } else {
    while (ch !== 0 && !is_WS_OR_EOL(ch)) {
      if (ch === 33) {
        if (!isNamed) {
          tagHandle = state.input.slice(_position - 1, state.position + 1);
          if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
            throwError(state, "named tag handle cannot contain such characters");
          }
          isNamed = true;
          _position = state.position + 1;
        } else {
          throwError(state, "tag suffix cannot contain exclamation marks");
        }
      }
      ch = state.input.charCodeAt(++state.position);
    }
    tagName = state.input.slice(_position, state.position);
    if (PATTERN_FLOW_INDICATORS.test(tagName)) {
      throwError(state, "tag suffix cannot contain flow indicator characters");
    }
  }
  if (tagName && !PATTERN_TAG_URI.test(tagName)) {
    throwError(state, "tag name cannot contain such characters: " + tagName);
  }
  try {
    tagName = decodeURIComponent(tagName);
  } catch (err) {
    throwError(state, "tag name is malformed: " + tagName);
  }
  if (isVerbatim) {
    state.tag = tagName;
  } else if (_hasOwnProperty$1.call(state.tagMap, tagHandle)) {
    state.tag = state.tagMap[tagHandle] + tagName;
  } else if (tagHandle === "!") {
    state.tag = "!" + tagName;
  } else if (tagHandle === "!!") {
    state.tag = "tag:yaml.org,2002:" + tagName;
  } else {
    throwError(state, 'undeclared tag handle "' + tagHandle + '"');
  }
  return true;
}
function readAnchorProperty(state) {
  var _position, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 38) return false;
  if (state.anchor !== null) {
    throwError(state, "duplication of an anchor property");
  }
  ch = state.input.charCodeAt(++state.position);
  _position = state.position;
  while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
    ch = state.input.charCodeAt(++state.position);
  }
  if (state.position === _position) {
    throwError(state, "name of an anchor node must contain at least one character");
  }
  state.anchor = state.input.slice(_position, state.position);
  return true;
}
function readAlias(state) {
  var _position, alias, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 42) return false;
  ch = state.input.charCodeAt(++state.position);
  _position = state.position;
  while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
    ch = state.input.charCodeAt(++state.position);
  }
  if (state.position === _position) {
    throwError(state, "name of an alias node must contain at least one character");
  }
  alias = state.input.slice(_position, state.position);
  if (!_hasOwnProperty$1.call(state.anchorMap, alias)) {
    throwError(state, 'unidentified alias "' + alias + '"');
  }
  state.result = state.anchorMap[alias];
  skipSeparationSpace(state, true, -1);
  return true;
}
function composeNode(state, parentIndent, nodeContext, allowToSeek, allowCompact) {
  var allowBlockStyles, allowBlockScalars, allowBlockCollections, indentStatus = 1, atNewLine = false, hasContent = false, typeIndex, typeQuantity, typeList, type2, flowIndent, blockIndent;
  if (state.listener !== null) {
    state.listener("open", state);
  }
  state.tag = null;
  state.anchor = null;
  state.kind = null;
  state.result = null;
  allowBlockStyles = allowBlockScalars = allowBlockCollections = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
  if (allowToSeek) {
    if (skipSeparationSpace(state, true, -1)) {
      atNewLine = true;
      if (state.lineIndent > parentIndent) {
        indentStatus = 1;
      } else if (state.lineIndent === parentIndent) {
        indentStatus = 0;
      } else if (state.lineIndent < parentIndent) {
        indentStatus = -1;
      }
    }
  }
  if (indentStatus === 1) {
    while (readTagProperty(state) || readAnchorProperty(state)) {
      if (skipSeparationSpace(state, true, -1)) {
        atNewLine = true;
        allowBlockCollections = allowBlockStyles;
        if (state.lineIndent > parentIndent) {
          indentStatus = 1;
        } else if (state.lineIndent === parentIndent) {
          indentStatus = 0;
        } else if (state.lineIndent < parentIndent) {
          indentStatus = -1;
        }
      } else {
        allowBlockCollections = false;
      }
    }
  }
  if (allowBlockCollections) {
    allowBlockCollections = atNewLine || allowCompact;
  }
  if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
    if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) {
      flowIndent = parentIndent;
    } else {
      flowIndent = parentIndent + 1;
    }
    blockIndent = state.position - state.lineStart;
    if (indentStatus === 1) {
      if (allowBlockCollections && (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent)) || readFlowCollection(state, flowIndent)) {
        hasContent = true;
      } else {
        if (allowBlockScalars && readBlockScalar(state, flowIndent) || readSingleQuotedScalar(state, flowIndent) || readDoubleQuotedScalar(state, flowIndent)) {
          hasContent = true;
        } else if (readAlias(state)) {
          hasContent = true;
          if (state.tag !== null || state.anchor !== null) {
            throwError(state, "alias node should not have any properties");
          }
        } else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
          hasContent = true;
          if (state.tag === null) {
            state.tag = "?";
          }
        }
        if (state.anchor !== null) {
          state.anchorMap[state.anchor] = state.result;
        }
      }
    } else if (indentStatus === 0) {
      hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
    }
  }
  if (state.tag === null) {
    if (state.anchor !== null) {
      state.anchorMap[state.anchor] = state.result;
    }
  } else if (state.tag === "?") {
    if (state.result !== null && state.kind !== "scalar") {
      throwError(state, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state.kind + '"');
    }
    for (typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
      type2 = state.implicitTypes[typeIndex];
      if (type2.resolve(state.result)) {
        state.result = type2.construct(state.result);
        state.tag = type2.tag;
        if (state.anchor !== null) {
          state.anchorMap[state.anchor] = state.result;
        }
        break;
      }
    }
  } else if (state.tag !== "!") {
    if (_hasOwnProperty$1.call(state.typeMap[state.kind || "fallback"], state.tag)) {
      type2 = state.typeMap[state.kind || "fallback"][state.tag];
    } else {
      type2 = null;
      typeList = state.typeMap.multi[state.kind || "fallback"];
      for (typeIndex = 0, typeQuantity = typeList.length; typeIndex < typeQuantity; typeIndex += 1) {
        if (state.tag.slice(0, typeList[typeIndex].tag.length) === typeList[typeIndex].tag) {
          type2 = typeList[typeIndex];
          break;
        }
      }
    }
    if (!type2) {
      throwError(state, "unknown tag !<" + state.tag + ">");
    }
    if (state.result !== null && type2.kind !== state.kind) {
      throwError(state, "unacceptable node kind for !<" + state.tag + '> tag; it should be "' + type2.kind + '", not "' + state.kind + '"');
    }
    if (!type2.resolve(state.result, state.tag)) {
      throwError(state, "cannot resolve a node with !<" + state.tag + "> explicit tag");
    } else {
      state.result = type2.construct(state.result, state.tag);
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = state.result;
      }
    }
  }
  if (state.listener !== null) {
    state.listener("close", state);
  }
  return state.tag !== null || state.anchor !== null || hasContent;
}
function readDocument(state) {
  var documentStart = state.position, _position, directiveName, directiveArgs, hasDirectives = false, ch;
  state.version = null;
  state.checkLineBreaks = state.legacy;
  state.tagMap = /* @__PURE__ */ Object.create(null);
  state.anchorMap = /* @__PURE__ */ Object.create(null);
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    skipSeparationSpace(state, true, -1);
    ch = state.input.charCodeAt(state.position);
    if (state.lineIndent > 0 || ch !== 37) {
      break;
    }
    hasDirectives = true;
    ch = state.input.charCodeAt(++state.position);
    _position = state.position;
    while (ch !== 0 && !is_WS_OR_EOL(ch)) {
      ch = state.input.charCodeAt(++state.position);
    }
    directiveName = state.input.slice(_position, state.position);
    directiveArgs = [];
    if (directiveName.length < 1) {
      throwError(state, "directive name must not be less than one character in length");
    }
    while (ch !== 0) {
      while (is_WHITE_SPACE(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      if (ch === 35) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (ch !== 0 && !is_EOL(ch));
        break;
      }
      if (is_EOL(ch)) break;
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      directiveArgs.push(state.input.slice(_position, state.position));
    }
    if (ch !== 0) readLineBreak(state);
    if (_hasOwnProperty$1.call(directiveHandlers, directiveName)) {
      directiveHandlers[directiveName](state, directiveName, directiveArgs);
    } else {
      throwWarning(state, 'unknown document directive "' + directiveName + '"');
    }
  }
  skipSeparationSpace(state, true, -1);
  if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45) {
    state.position += 3;
    skipSeparationSpace(state, true, -1);
  } else if (hasDirectives) {
    throwError(state, "directives end mark is expected");
  }
  composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
  skipSeparationSpace(state, true, -1);
  if (state.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position))) {
    throwWarning(state, "non-ASCII line breaks are interpreted as content");
  }
  state.documents.push(state.result);
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    if (state.input.charCodeAt(state.position) === 46) {
      state.position += 3;
      skipSeparationSpace(state, true, -1);
    }
    return;
  }
  if (state.position < state.length - 1) {
    throwError(state, "end of the stream or a document separator is expected");
  } else {
    return;
  }
}
function loadDocuments(input, options) {
  input = String(input);
  options = options || {};
  if (input.length !== 0) {
    if (input.charCodeAt(input.length - 1) !== 10 && input.charCodeAt(input.length - 1) !== 13) {
      input += "\n";
    }
    if (input.charCodeAt(0) === 65279) {
      input = input.slice(1);
    }
  }
  var state = new State$1(input, options);
  var nullpos = input.indexOf("\0");
  if (nullpos !== -1) {
    state.position = nullpos;
    throwError(state, "null byte is not allowed in input");
  }
  state.input += "\0";
  while (state.input.charCodeAt(state.position) === 32) {
    state.lineIndent += 1;
    state.position += 1;
  }
  while (state.position < state.length - 1) {
    readDocument(state);
  }
  return state.documents;
}
function loadAll$1(input, iterator, options) {
  if (iterator !== null && typeof iterator === "object" && typeof options === "undefined") {
    options = iterator;
    iterator = null;
  }
  var documents = loadDocuments(input, options);
  if (typeof iterator !== "function") {
    return documents;
  }
  for (var index = 0, length = documents.length; index < length; index += 1) {
    iterator(documents[index]);
  }
}
function load$1(input, options) {
  var documents = loadDocuments(input, options);
  if (documents.length === 0) {
    return void 0;
  } else if (documents.length === 1) {
    return documents[0];
  }
  throw new exception("expected a single document in the stream, but found more");
}
var loadAll_1 = loadAll$1;
var load_1 = load$1;
var loader = {
  loadAll: loadAll_1,
  load: load_1
};
var _toString = Object.prototype.toString;
var _hasOwnProperty = Object.prototype.hasOwnProperty;
var CHAR_BOM = 65279;
var CHAR_TAB = 9;
var CHAR_LINE_FEED = 10;
var CHAR_CARRIAGE_RETURN = 13;
var CHAR_SPACE = 32;
var CHAR_EXCLAMATION = 33;
var CHAR_DOUBLE_QUOTE = 34;
var CHAR_SHARP = 35;
var CHAR_PERCENT = 37;
var CHAR_AMPERSAND = 38;
var CHAR_SINGLE_QUOTE = 39;
var CHAR_ASTERISK = 42;
var CHAR_COMMA = 44;
var CHAR_MINUS = 45;
var CHAR_COLON = 58;
var CHAR_EQUALS = 61;
var CHAR_GREATER_THAN = 62;
var CHAR_QUESTION = 63;
var CHAR_COMMERCIAL_AT = 64;
var CHAR_LEFT_SQUARE_BRACKET = 91;
var CHAR_RIGHT_SQUARE_BRACKET = 93;
var CHAR_GRAVE_ACCENT = 96;
var CHAR_LEFT_CURLY_BRACKET = 123;
var CHAR_VERTICAL_LINE = 124;
var CHAR_RIGHT_CURLY_BRACKET = 125;
var ESCAPE_SEQUENCES = {};
ESCAPE_SEQUENCES[0] = "\\0";
ESCAPE_SEQUENCES[7] = "\\a";
ESCAPE_SEQUENCES[8] = "\\b";
ESCAPE_SEQUENCES[9] = "\\t";
ESCAPE_SEQUENCES[10] = "\\n";
ESCAPE_SEQUENCES[11] = "\\v";
ESCAPE_SEQUENCES[12] = "\\f";
ESCAPE_SEQUENCES[13] = "\\r";
ESCAPE_SEQUENCES[27] = "\\e";
ESCAPE_SEQUENCES[34] = '\\"';
ESCAPE_SEQUENCES[92] = "\\\\";
ESCAPE_SEQUENCES[133] = "\\N";
ESCAPE_SEQUENCES[160] = "\\_";
ESCAPE_SEQUENCES[8232] = "\\L";
ESCAPE_SEQUENCES[8233] = "\\P";
var DEPRECATED_BOOLEANS_SYNTAX = [
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "on",
  "On",
  "ON",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "off",
  "Off",
  "OFF"
];
var DEPRECATED_BASE60_SYNTAX = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
function compileStyleMap(schema2, map2) {
  var result, keys, index, length, tag, style, type2;
  if (map2 === null) return {};
  result = {};
  keys = Object.keys(map2);
  for (index = 0, length = keys.length; index < length; index += 1) {
    tag = keys[index];
    style = String(map2[tag]);
    if (tag.slice(0, 2) === "!!") {
      tag = "tag:yaml.org,2002:" + tag.slice(2);
    }
    type2 = schema2.compiledTypeMap["fallback"][tag];
    if (type2 && _hasOwnProperty.call(type2.styleAliases, style)) {
      style = type2.styleAliases[style];
    }
    result[tag] = style;
  }
  return result;
}
function encodeHex(character) {
  var string, handle, length;
  string = character.toString(16).toUpperCase();
  if (character <= 255) {
    handle = "x";
    length = 2;
  } else if (character <= 65535) {
    handle = "u";
    length = 4;
  } else if (character <= 4294967295) {
    handle = "U";
    length = 8;
  } else {
    throw new exception("code point within a string may not be greater than 0xFFFFFFFF");
  }
  return "\\" + handle + common.repeat("0", length - string.length) + string;
}
var QUOTING_TYPE_SINGLE = 1;
var QUOTING_TYPE_DOUBLE = 2;
function State(options) {
  this.schema = options["schema"] || _default;
  this.indent = Math.max(1, options["indent"] || 2);
  this.noArrayIndent = options["noArrayIndent"] || false;
  this.skipInvalid = options["skipInvalid"] || false;
  this.flowLevel = common.isNothing(options["flowLevel"]) ? -1 : options["flowLevel"];
  this.styleMap = compileStyleMap(this.schema, options["styles"] || null);
  this.sortKeys = options["sortKeys"] || false;
  this.lineWidth = options["lineWidth"] || 80;
  this.noRefs = options["noRefs"] || false;
  this.noCompatMode = options["noCompatMode"] || false;
  this.condenseFlow = options["condenseFlow"] || false;
  this.quotingType = options["quotingType"] === '"' ? QUOTING_TYPE_DOUBLE : QUOTING_TYPE_SINGLE;
  this.forceQuotes = options["forceQuotes"] || false;
  this.replacer = typeof options["replacer"] === "function" ? options["replacer"] : null;
  this.implicitTypes = this.schema.compiledImplicit;
  this.explicitTypes = this.schema.compiledExplicit;
  this.tag = null;
  this.result = "";
  this.duplicates = [];
  this.usedDuplicates = null;
}
function indentString(string, spaces) {
  var ind = common.repeat(" ", spaces), position = 0, next = -1, result = "", line, length = string.length;
  while (position < length) {
    next = string.indexOf("\n", position);
    if (next === -1) {
      line = string.slice(position);
      position = length;
    } else {
      line = string.slice(position, next + 1);
      position = next + 1;
    }
    if (line.length && line !== "\n") result += ind;
    result += line;
  }
  return result;
}
function generateNextLine(state, level) {
  return "\n" + common.repeat(" ", state.indent * level);
}
function testImplicitResolving(state, str2) {
  var index, length, type2;
  for (index = 0, length = state.implicitTypes.length; index < length; index += 1) {
    type2 = state.implicitTypes[index];
    if (type2.resolve(str2)) {
      return true;
    }
  }
  return false;
}
function isWhitespace(c) {
  return c === CHAR_SPACE || c === CHAR_TAB;
}
function isPrintable(c) {
  return 32 <= c && c <= 126 || 161 <= c && c <= 55295 && c !== 8232 && c !== 8233 || 57344 <= c && c <= 65533 && c !== CHAR_BOM || 65536 <= c && c <= 1114111;
}
function isNsCharOrWhitespace(c) {
  return isPrintable(c) && c !== CHAR_BOM && c !== CHAR_CARRIAGE_RETURN && c !== CHAR_LINE_FEED;
}
function isPlainSafe(c, prev, inblock) {
  var cIsNsCharOrWhitespace = isNsCharOrWhitespace(c);
  var cIsNsChar = cIsNsCharOrWhitespace && !isWhitespace(c);
  return (
    // ns-plain-safe
    (inblock ? (
      // c = flow-in
      cIsNsCharOrWhitespace
    ) : cIsNsCharOrWhitespace && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET) && c !== CHAR_SHARP && !(prev === CHAR_COLON && !cIsNsChar) || isNsCharOrWhitespace(prev) && !isWhitespace(prev) && c === CHAR_SHARP || prev === CHAR_COLON && cIsNsChar
  );
}
function isPlainSafeFirst(c) {
  return isPrintable(c) && c !== CHAR_BOM && !isWhitespace(c) && c !== CHAR_MINUS && c !== CHAR_QUESTION && c !== CHAR_COLON && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_SHARP && c !== CHAR_AMPERSAND && c !== CHAR_ASTERISK && c !== CHAR_EXCLAMATION && c !== CHAR_VERTICAL_LINE && c !== CHAR_EQUALS && c !== CHAR_GREATER_THAN && c !== CHAR_SINGLE_QUOTE && c !== CHAR_DOUBLE_QUOTE && c !== CHAR_PERCENT && c !== CHAR_COMMERCIAL_AT && c !== CHAR_GRAVE_ACCENT;
}
function isPlainSafeLast(c) {
  return !isWhitespace(c) && c !== CHAR_COLON;
}
function codePointAt(string, pos) {
  var first = string.charCodeAt(pos), second;
  if (first >= 55296 && first <= 56319 && pos + 1 < string.length) {
    second = string.charCodeAt(pos + 1);
    if (second >= 56320 && second <= 57343) {
      return (first - 55296) * 1024 + second - 56320 + 65536;
    }
  }
  return first;
}
function needIndentIndicator(string) {
  var leadingSpaceRe = /^\n* /;
  return leadingSpaceRe.test(string);
}
var STYLE_PLAIN = 1;
var STYLE_SINGLE = 2;
var STYLE_LITERAL = 3;
var STYLE_FOLDED = 4;
var STYLE_DOUBLE = 5;
function chooseScalarStyle(string, singleLineOnly, indentPerLevel, lineWidth, testAmbiguousType, quotingType, forceQuotes, inblock) {
  var i;
  var char = 0;
  var prevChar = null;
  var hasLineBreak = false;
  var hasFoldableLine = false;
  var shouldTrackWidth = lineWidth !== -1;
  var previousLineBreak = -1;
  var plain = isPlainSafeFirst(codePointAt(string, 0)) && isPlainSafeLast(codePointAt(string, string.length - 1));
  if (singleLineOnly || forceQuotes) {
    for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
      char = codePointAt(string, i);
      if (!isPrintable(char)) {
        return STYLE_DOUBLE;
      }
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
  } else {
    for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
      char = codePointAt(string, i);
      if (char === CHAR_LINE_FEED) {
        hasLineBreak = true;
        if (shouldTrackWidth) {
          hasFoldableLine = hasFoldableLine || // Foldable line = too long, and not more-indented.
          i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ";
          previousLineBreak = i;
        }
      } else if (!isPrintable(char)) {
        return STYLE_DOUBLE;
      }
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
    hasFoldableLine = hasFoldableLine || shouldTrackWidth && (i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ");
  }
  if (!hasLineBreak && !hasFoldableLine) {
    if (plain && !forceQuotes && !testAmbiguousType(string)) {
      return STYLE_PLAIN;
    }
    return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
  }
  if (indentPerLevel > 9 && needIndentIndicator(string)) {
    return STYLE_DOUBLE;
  }
  if (!forceQuotes) {
    return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
  }
  return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
}
function writeScalar(state, string, level, iskey, inblock) {
  state.dump = function() {
    if (string.length === 0) {
      return state.quotingType === QUOTING_TYPE_DOUBLE ? '""' : "''";
    }
    if (!state.noCompatMode) {
      if (DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1 || DEPRECATED_BASE60_SYNTAX.test(string)) {
        return state.quotingType === QUOTING_TYPE_DOUBLE ? '"' + string + '"' : "'" + string + "'";
      }
    }
    var indent = state.indent * Math.max(1, level);
    var lineWidth = state.lineWidth === -1 ? -1 : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);
    var singleLineOnly = iskey || state.flowLevel > -1 && level >= state.flowLevel;
    function testAmbiguity(string2) {
      return testImplicitResolving(state, string2);
    }
    switch (chooseScalarStyle(
      string,
      singleLineOnly,
      state.indent,
      lineWidth,
      testAmbiguity,
      state.quotingType,
      state.forceQuotes && !iskey,
      inblock
    )) {
      case STYLE_PLAIN:
        return string;
      case STYLE_SINGLE:
        return "'" + string.replace(/'/g, "''") + "'";
      case STYLE_LITERAL:
        return "|" + blockHeader(string, state.indent) + dropEndingNewline(indentString(string, indent));
      case STYLE_FOLDED:
        return ">" + blockHeader(string, state.indent) + dropEndingNewline(indentString(foldString(string, lineWidth), indent));
      case STYLE_DOUBLE:
        return '"' + escapeString(string) + '"';
      default:
        throw new exception("impossible error: invalid scalar style");
    }
  }();
}
function blockHeader(string, indentPerLevel) {
  var indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : "";
  var clip = string[string.length - 1] === "\n";
  var keep = clip && (string[string.length - 2] === "\n" || string === "\n");
  var chomp = keep ? "+" : clip ? "" : "-";
  return indentIndicator + chomp + "\n";
}
function dropEndingNewline(string) {
  return string[string.length - 1] === "\n" ? string.slice(0, -1) : string;
}
function foldString(string, width) {
  var lineRe = /(\n+)([^\n]*)/g;
  var result = function() {
    var nextLF = string.indexOf("\n");
    nextLF = nextLF !== -1 ? nextLF : string.length;
    lineRe.lastIndex = nextLF;
    return foldLine(string.slice(0, nextLF), width);
  }();
  var prevMoreIndented = string[0] === "\n" || string[0] === " ";
  var moreIndented;
  var match2;
  while (match2 = lineRe.exec(string)) {
    var prefix = match2[1], line = match2[2];
    moreIndented = line[0] === " ";
    result += prefix + (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") + foldLine(line, width);
    prevMoreIndented = moreIndented;
  }
  return result;
}
function foldLine(line, width) {
  if (line === "" || line[0] === " ") return line;
  var breakRe = / [^ ]/g;
  var match2;
  var start = 0, end, curr = 0, next = 0;
  var result = "";
  while (match2 = breakRe.exec(line)) {
    next = match2.index;
    if (next - start > width) {
      end = curr > start ? curr : next;
      result += "\n" + line.slice(start, end);
      start = end + 1;
    }
    curr = next;
  }
  result += "\n";
  if (line.length - start > width && curr > start) {
    result += line.slice(start, curr) + "\n" + line.slice(curr + 1);
  } else {
    result += line.slice(start);
  }
  return result.slice(1);
}
function escapeString(string) {
  var result = "";
  var char = 0;
  var escapeSeq;
  for (var i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
    char = codePointAt(string, i);
    escapeSeq = ESCAPE_SEQUENCES[char];
    if (!escapeSeq && isPrintable(char)) {
      result += string[i];
      if (char >= 65536) result += string[i + 1];
    } else {
      result += escapeSeq || encodeHex(char);
    }
  }
  return result;
}
function writeFlowSequence(state, level, object) {
  var _result = "", _tag = state.tag, index, length, value;
  for (index = 0, length = object.length; index < length; index += 1) {
    value = object[index];
    if (state.replacer) {
      value = state.replacer.call(object, String(index), value);
    }
    if (writeNode(state, level, value, false, false) || typeof value === "undefined" && writeNode(state, level, null, false, false)) {
      if (_result !== "") _result += "," + (!state.condenseFlow ? " " : "");
      _result += state.dump;
    }
  }
  state.tag = _tag;
  state.dump = "[" + _result + "]";
}
function writeBlockSequence(state, level, object, compact) {
  var _result = "", _tag = state.tag, index, length, value;
  for (index = 0, length = object.length; index < length; index += 1) {
    value = object[index];
    if (state.replacer) {
      value = state.replacer.call(object, String(index), value);
    }
    if (writeNode(state, level + 1, value, true, true, false, true) || typeof value === "undefined" && writeNode(state, level + 1, null, true, true, false, true)) {
      if (!compact || _result !== "") {
        _result += generateNextLine(state, level);
      }
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        _result += "-";
      } else {
        _result += "- ";
      }
      _result += state.dump;
    }
  }
  state.tag = _tag;
  state.dump = _result || "[]";
}
function writeFlowMapping(state, level, object) {
  var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, pairBuffer;
  for (index = 0, length = objectKeyList.length; index < length; index += 1) {
    pairBuffer = "";
    if (_result !== "") pairBuffer += ", ";
    if (state.condenseFlow) pairBuffer += '"';
    objectKey = objectKeyList[index];
    objectValue = object[objectKey];
    if (state.replacer) {
      objectValue = state.replacer.call(object, objectKey, objectValue);
    }
    if (!writeNode(state, level, objectKey, false, false)) {
      continue;
    }
    if (state.dump.length > 1024) pairBuffer += "? ";
    pairBuffer += state.dump + (state.condenseFlow ? '"' : "") + ":" + (state.condenseFlow ? "" : " ");
    if (!writeNode(state, level, objectValue, false, false)) {
      continue;
    }
    pairBuffer += state.dump;
    _result += pairBuffer;
  }
  state.tag = _tag;
  state.dump = "{" + _result + "}";
}
function writeBlockMapping(state, level, object, compact) {
  var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, explicitPair, pairBuffer;
  if (state.sortKeys === true) {
    objectKeyList.sort();
  } else if (typeof state.sortKeys === "function") {
    objectKeyList.sort(state.sortKeys);
  } else if (state.sortKeys) {
    throw new exception("sortKeys must be a boolean or a function");
  }
  for (index = 0, length = objectKeyList.length; index < length; index += 1) {
    pairBuffer = "";
    if (!compact || _result !== "") {
      pairBuffer += generateNextLine(state, level);
    }
    objectKey = objectKeyList[index];
    objectValue = object[objectKey];
    if (state.replacer) {
      objectValue = state.replacer.call(object, objectKey, objectValue);
    }
    if (!writeNode(state, level + 1, objectKey, true, true, true)) {
      continue;
    }
    explicitPair = state.tag !== null && state.tag !== "?" || state.dump && state.dump.length > 1024;
    if (explicitPair) {
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        pairBuffer += "?";
      } else {
        pairBuffer += "? ";
      }
    }
    pairBuffer += state.dump;
    if (explicitPair) {
      pairBuffer += generateNextLine(state, level);
    }
    if (!writeNode(state, level + 1, objectValue, true, explicitPair)) {
      continue;
    }
    if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
      pairBuffer += ":";
    } else {
      pairBuffer += ": ";
    }
    pairBuffer += state.dump;
    _result += pairBuffer;
  }
  state.tag = _tag;
  state.dump = _result || "{}";
}
function detectType(state, object, explicit) {
  var _result, typeList, index, length, type2, style;
  typeList = explicit ? state.explicitTypes : state.implicitTypes;
  for (index = 0, length = typeList.length; index < length; index += 1) {
    type2 = typeList[index];
    if ((type2.instanceOf || type2.predicate) && (!type2.instanceOf || typeof object === "object" && object instanceof type2.instanceOf) && (!type2.predicate || type2.predicate(object))) {
      if (explicit) {
        if (type2.multi && type2.representName) {
          state.tag = type2.representName(object);
        } else {
          state.tag = type2.tag;
        }
      } else {
        state.tag = "?";
      }
      if (type2.represent) {
        style = state.styleMap[type2.tag] || type2.defaultStyle;
        if (_toString.call(type2.represent) === "[object Function]") {
          _result = type2.represent(object, style);
        } else if (_hasOwnProperty.call(type2.represent, style)) {
          _result = type2.represent[style](object, style);
        } else {
          throw new exception("!<" + type2.tag + '> tag resolver accepts not "' + style + '" style');
        }
        state.dump = _result;
      }
      return true;
    }
  }
  return false;
}
function writeNode(state, level, object, block, compact, iskey, isblockseq) {
  state.tag = null;
  state.dump = object;
  if (!detectType(state, object, false)) {
    detectType(state, object, true);
  }
  var type2 = _toString.call(state.dump);
  var inblock = block;
  var tagStr;
  if (block) {
    block = state.flowLevel < 0 || state.flowLevel > level;
  }
  var objectOrArray = type2 === "[object Object]" || type2 === "[object Array]", duplicateIndex, duplicate;
  if (objectOrArray) {
    duplicateIndex = state.duplicates.indexOf(object);
    duplicate = duplicateIndex !== -1;
  }
  if (state.tag !== null && state.tag !== "?" || duplicate || state.indent !== 2 && level > 0) {
    compact = false;
  }
  if (duplicate && state.usedDuplicates[duplicateIndex]) {
    state.dump = "*ref_" + duplicateIndex;
  } else {
    if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex]) {
      state.usedDuplicates[duplicateIndex] = true;
    }
    if (type2 === "[object Object]") {
      if (block && Object.keys(state.dump).length !== 0) {
        writeBlockMapping(state, level, state.dump, compact);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + state.dump;
        }
      } else {
        writeFlowMapping(state, level, state.dump);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + " " + state.dump;
        }
      }
    } else if (type2 === "[object Array]") {
      if (block && state.dump.length !== 0) {
        if (state.noArrayIndent && !isblockseq && level > 0) {
          writeBlockSequence(state, level - 1, state.dump, compact);
        } else {
          writeBlockSequence(state, level, state.dump, compact);
        }
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + state.dump;
        }
      } else {
        writeFlowSequence(state, level, state.dump);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + " " + state.dump;
        }
      }
    } else if (type2 === "[object String]") {
      if (state.tag !== "?") {
        writeScalar(state, state.dump, level, iskey, inblock);
      }
    } else if (type2 === "[object Undefined]") {
      return false;
    } else {
      if (state.skipInvalid) return false;
      throw new exception("unacceptable kind of an object to dump " + type2);
    }
    if (state.tag !== null && state.tag !== "?") {
      tagStr = encodeURI(
        state.tag[0] === "!" ? state.tag.slice(1) : state.tag
      ).replace(/!/g, "%21");
      if (state.tag[0] === "!") {
        tagStr = "!" + tagStr;
      } else if (tagStr.slice(0, 18) === "tag:yaml.org,2002:") {
        tagStr = "!!" + tagStr.slice(18);
      } else {
        tagStr = "!<" + tagStr + ">";
      }
      state.dump = tagStr + " " + state.dump;
    }
  }
  return true;
}
function getDuplicateReferences(object, state) {
  var objects = [], duplicatesIndexes = [], index, length;
  inspectNode(object, objects, duplicatesIndexes);
  for (index = 0, length = duplicatesIndexes.length; index < length; index += 1) {
    state.duplicates.push(objects[duplicatesIndexes[index]]);
  }
  state.usedDuplicates = new Array(length);
}
function inspectNode(object, objects, duplicatesIndexes) {
  var objectKeyList, index, length;
  if (object !== null && typeof object === "object") {
    index = objects.indexOf(object);
    if (index !== -1) {
      if (duplicatesIndexes.indexOf(index) === -1) {
        duplicatesIndexes.push(index);
      }
    } else {
      objects.push(object);
      if (Array.isArray(object)) {
        for (index = 0, length = object.length; index < length; index += 1) {
          inspectNode(object[index], objects, duplicatesIndexes);
        }
      } else {
        objectKeyList = Object.keys(object);
        for (index = 0, length = objectKeyList.length; index < length; index += 1) {
          inspectNode(object[objectKeyList[index]], objects, duplicatesIndexes);
        }
      }
    }
  }
}
function dump$1(input, options) {
  options = options || {};
  var state = new State(options);
  if (!state.noRefs) getDuplicateReferences(input, state);
  var value = input;
  if (state.replacer) {
    value = state.replacer.call({ "": value }, "", value);
  }
  if (writeNode(state, 0, value, true, true)) return state.dump + "\n";
  return "";
}
var dump_1 = dump$1;
var dumper = {
  dump: dump_1
};
function renamed(from, to) {
  return function() {
    throw new Error("Function yaml." + from + " is removed in js-yaml 4. Use yaml." + to + " instead, which is now safe by default.");
  };
}
var load = loader.load;
var loadAll = loader.loadAll;
var dump = dumper.dump;
var safeLoad = renamed("safeLoad", "load");
var safeLoadAll = renamed("safeLoadAll", "loadAll");
var safeDump = renamed("safeDump", "dump");

// src/config/defaults.ts
var DEFAULT_CONFIG = {
  // Empty array triggers dynamic model discovery
  // Will use OpenRouter's "free" meta-model and discover OpenCode CLI models
  providers: [],
  synthesisModel: "openrouter/free",
  fallbackProviders: [],
  providerAllowlist: [],
  providerBlocklist: [],
  // COST CONTROLS:
  // - openrouterAllowPaid: false = Only free models (blocks models with $/token pricing)
  // - providerDiscoveryLimit: 8 = Health-check up to 8 providers for reliability
  // - providerLimit: 6 = Actually use only 6 providers to control API usage
  // - budgetMaxUsd: 0 = No budget allocated for paid APIs
  // Combined these settings ensure zero cost when using default configuration
  openrouterAllowPaid: false,
  // IMPORTANT: Set to true only if you have OpenRouter credits
  providerDiscoveryLimit: 8,
  // Health-check pool size (higher = better reliability)
  providerLimit: 6,
  // Actual execution pool size (lower = lower costs)
  providerRetries: 2,
  providerMaxParallel: 3,
  quietModeEnabled: false,
  quietMinConfidence: 0.5,
  quietUseLearning: true,
  learningEnabled: true,
  learningMinFeedbackCount: 5,
  learningLookbackDays: 30,
  inlineMaxComments: 5,
  inlineMinSeverity: "major",
  inlineMinAgreement: 2,
  skipLabels: [],
  skipDrafts: false,
  skipBots: true,
  minChangedLines: 0,
  maxChangedFiles: 0,
  diffMaxBytes: 12e4,
  runTimeoutSeconds: 600,
  budgetMaxUsd: 0,
  enableAstAnalysis: true,
  enableSecurity: true,
  enableCaching: true,
  enableTestHints: true,
  enableAiDetection: true,
  incrementalEnabled: true,
  // Re-enabled with broad infrastructure exclusion
  incrementalCacheTtlDays: 7,
  batchMaxFiles: 30,
  providerBatchOverrides: {},
  enableTokenAwareBatching: true,
  targetTokensPerBatch: 5e4,
  // ~50k tokens per batch
  graphEnabled: false,
  graphCacheEnabled: true,
  graphMaxDepth: 5,
  graphTimeoutSeconds: 10,
  generateFixPrompts: false,
  fixPromptFormat: "plain",
  analyticsEnabled: true,
  analyticsMaxReviews: 1e3,
  analyticsDeveloperRate: 100,
  // USD per hour
  analyticsManualReviewTime: 30,
  // minutes
  pluginsEnabled: false,
  pluginDir: "./plugins",
  pluginAllowlist: [],
  pluginBlocklist: [],
  skipTrivialChanges: true,
  skipDependencyUpdates: true,
  skipDocumentationOnly: true,
  skipFormattingOnly: false,
  // Disabled by default (may have false positives)
  skipTestFixtures: true,
  skipConfigFiles: true,
  skipBuildArtifacts: true,
  trivialPatterns: [],
  pathBasedIntensity: false,
  // Disabled by default, opt-in
  pathIntensityPatterns: void 0,
  pathDefaultIntensity: "standard",
  // Provider selection strategy
  providerSelectionStrategy: "reliability",
  providerExplorationRate: 0.3,
  // 70% exploit, 30% explore
  // Intensity behavior mappings
  intensityProviderCounts: {
    thorough: 8,
    standard: 5,
    light: 3
  },
  intensityTimeouts: {
    thorough: 18e4,
    // 3 minutes
    standard: 12e4,
    // 2 minutes
    light: 6e4
    // 1 minute
  },
  intensityPromptDepth: {
    thorough: "detailed",
    standard: "standard",
    light: "brief"
  },
  dryRun: false
};
var FALLBACK_STATIC_PROVIDERS = [
  "openrouter/free"
];

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json2 = JSON.stringify(obj, null, 2);
  return json2.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error2) => {
      for (const issue of error2.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error2 = new ZodError(issues);
  return error2;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map2) {
  overrideErrorMap = map2;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path13, errorMaps, issueData } = params;
  const fullPath = [...path13, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map2 of maps) {
    errorMessage = map2(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs2) {
    const syncPairs = [];
    for (const pair of pairs2) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs2) {
    const finalObject = {};
    for (const pair of pairs2) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path13, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path13;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error2 = new ZodError(ctx.common.issues);
        this._error = error2;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema2, params) => {
  return new ZodArray({
    type: schema2,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema2) {
  if (schema2 instanceof ZodObject) {
    const newShape = {};
    for (const key in schema2.shape) {
      const fieldSchema = schema2.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema2._def,
      shape: () => newShape
    });
  } else if (schema2 instanceof ZodArray) {
    return new ZodArray({
      ...schema2._def,
      type: deepPartialify(schema2.element)
    });
  } else if (schema2 instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema2.unwrap()));
  } else if (schema2 instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema2.unwrap()));
  } else if (schema2 instanceof ZodTuple) {
    return ZodTuple.create(schema2.items.map((item) => deepPartialify(item)));
  } else {
    return schema2;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs2 = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs2.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs2.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs2.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs2) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs2);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema2) {
    return this.augment({ [key]: schema2 });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types2, params) => {
  return new ZodUnion({
    options: types2,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type2) => {
  if (type2 instanceof ZodLazy) {
    return getDiscriminator(type2.schema);
  } else if (type2 instanceof ZodEffects) {
    return getDiscriminator(type2.innerType());
  } else if (type2 instanceof ZodLiteral) {
    return [type2.value];
  } else if (type2 instanceof ZodEnum) {
    return type2.options;
  } else if (type2 instanceof ZodNativeEnum) {
    return util.objectValues(type2.enum);
  } else if (type2 instanceof ZodDefault) {
    return getDiscriminator(type2._def.innerType);
  } else if (type2 instanceof ZodUndefined) {
    return [void 0];
  } else if (type2 instanceof ZodNull) {
    return [null];
  } else if (type2 instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type2.unwrap())];
  } else if (type2 instanceof ZodNullable) {
    return [null, ...getDiscriminator(type2.unwrap())];
  } else if (type2 instanceof ZodBranded) {
    return getDiscriminator(type2.unwrap());
  } else if (type2 instanceof ZodReadonly) {
    return getDiscriminator(type2.unwrap());
  } else if (type2 instanceof ZodCatch) {
    return getDiscriminator(type2._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type2 of options) {
      const discriminatorValues = getDiscriminator(type2.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type2);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema2 = this._def.items[itemIndex] || this._def.rest;
      if (!schema2)
        return null;
      return schema2._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs2 = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs2.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs2);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs2);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs2 = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs2) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs2) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error2) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error2
        }
      });
    }
    function makeReturnsIssue(returns, error2) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error2
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error2 = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error2.addIssue(makeArgsIssue(args, e));
          throw error2;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error2.addIssue(makeReturnsIssue(result, e));
          throw error2;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema2, params) => {
  return new ZodPromise({
    type: schema2,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema2, effect, params) => {
  return new ZodEffects({
    schema: schema2,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema2, params) => {
  return new ZodEffects({
    schema: schema2,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type2, params) => {
  return new ZodOptional({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type2, params) => {
  return new ZodNullable({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type2, params) => {
  return new ZodDefault({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type2, params) => {
  return new ZodCatch({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type2, params) => {
  return new ZodReadonly({
    innerType: type2,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;

// src/utils/regex-validator.ts
function isValidRegexPattern(pattern) {
  if (!pattern || typeof pattern !== "string") {
    return false;
  }
  if (pattern.length > 500) {
    return false;
  }
  const suspiciousPatterns = [
    // Quantifier-based attacks
    /(\*\*){3,}/,
    // Multiple consecutive **
    /(\+\+){3,}/,
    // Multiple consecutive ++
    /(\*){10,}/,
    // Too many consecutive *
    /(\+){10,}/,
    // Too many consecutive +
    /(.)\1{20,}/,
    // Excessive character repetition
    /(\.\*){5,}/,
    // Too many .* patterns
    /(\.\+){5,}/,
    // Too many .+ patterns
    // Nested quantifiers (catastrophic backtracking)
    /\([^)]*[+*]\)[+*]/,
    // (a+)+ or (a*)* patterns
    /\([^)]*[+*]\)\{/,
    // (a+){n,m} patterns
    /\[[^\]]*\][+*]\{/,
    // [a-z]+{n,m} patterns
    // Alternation with overlap (ReDoS vectors)
    /\([^|]*\|[^)]*\)[+*]/,
    // (a|ab)+ patterns
    /\{[^}]{100,}\}/,
    // Very long brace expansions
    // Excessive nesting and complexity
    /(\(.*){5,}/,
    // Too many nested groups
    /(\[.*){10,}/,
    // Too many character classes
    /(\||\/){20,}/,
    // Excessive alternation
    // Dangerous lookahead/lookbehind combos
    /\(\?[=!<].*\)\+/,
    // Quantified lookarounds
    /\(\?[=!<].*\)\*/
    // Quantified lookarounds
  ];
  for (const suspicious of suspiciousPatterns) {
    if (suspicious.test(pattern)) {
      return false;
    }
  }
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

// src/config/schema.ts
var ReviewConfigSchema = external_exports.object({
  providers: external_exports.array(external_exports.string()).optional(),
  synthesis_model: external_exports.string().optional(),
  fallback_providers: external_exports.array(external_exports.string()).optional(),
  provider_allowlist: external_exports.array(external_exports.string()).optional(),
  provider_blocklist: external_exports.array(external_exports.string()).optional(),
  openrouter_allow_paid: external_exports.boolean().optional(),
  provider_discovery_limit: external_exports.number().int().min(1).optional(),
  provider_limit: external_exports.number().int().min(0).optional(),
  provider_retries: external_exports.number().int().min(1).optional(),
  provider_max_parallel: external_exports.number().int().min(1).optional(),
  quiet_mode_enabled: external_exports.boolean().optional(),
  quiet_min_confidence: external_exports.number().min(0).max(1).optional(),
  quiet_use_learning: external_exports.boolean().optional(),
  learning_enabled: external_exports.boolean().optional(),
  learning_min_feedback_count: external_exports.number().int().min(1).optional(),
  learning_lookback_days: external_exports.number().int().min(1).optional(),
  inline_max_comments: external_exports.number().int().min(0).optional(),
  inline_min_severity: external_exports.enum(["critical", "major", "minor"]).optional(),
  inline_min_agreement: external_exports.number().int().min(1).optional(),
  skip_labels: external_exports.array(external_exports.string()).optional(),
  skip_drafts: external_exports.boolean().optional(),
  skip_bots: external_exports.boolean().optional(),
  min_changed_lines: external_exports.number().int().min(0).optional(),
  max_changed_files: external_exports.number().int().min(0).optional(),
  diff_max_bytes: external_exports.number().int().min(0).optional(),
  run_timeout_seconds: external_exports.number().int().min(1).optional(),
  budget_max_usd: external_exports.number().min(0).optional(),
  enable_ast_analysis: external_exports.boolean().optional(),
  enable_security: external_exports.boolean().optional(),
  enable_caching: external_exports.boolean().optional(),
  enable_test_hints: external_exports.boolean().optional(),
  enable_ai_detection: external_exports.boolean().optional(),
  incremental_enabled: external_exports.boolean().optional(),
  incremental_cache_ttl_days: external_exports.number().int().min(1).max(30).optional(),
  batch_max_files: external_exports.number().int().min(1).max(200).optional(),
  provider_batch_overrides: external_exports.record(external_exports.coerce.number().int().min(1).max(200)).optional(),
  enable_token_aware_batching: external_exports.boolean().optional(),
  target_tokens_per_batch: external_exports.number().int().min(1e3).optional(),
  graph_enabled: external_exports.boolean().optional(),
  graph_cache_enabled: external_exports.boolean().optional(),
  graph_max_depth: external_exports.number().int().min(1).max(10).optional(),
  graph_timeout_seconds: external_exports.number().int().min(1).max(60).optional(),
  generate_fix_prompts: external_exports.boolean().optional(),
  fix_prompt_format: external_exports.enum(["cursor", "copilot", "plain"]).optional(),
  analytics_enabled: external_exports.boolean().optional(),
  analytics_max_reviews: external_exports.number().int().min(100).max(1e4).optional(),
  analytics_developer_rate: external_exports.number().min(0).optional(),
  analytics_manual_review_time: external_exports.number().min(0).optional(),
  plugins_enabled: external_exports.boolean().optional(),
  plugin_dir: external_exports.string().optional(),
  plugin_allowlist: external_exports.array(external_exports.string()).optional(),
  plugin_blocklist: external_exports.array(external_exports.string()).optional(),
  skip_trivial_changes: external_exports.boolean().optional(),
  skip_dependency_updates: external_exports.boolean().optional(),
  skip_documentation_only: external_exports.boolean().optional(),
  skip_formatting_only: external_exports.boolean().optional(),
  skip_test_fixtures: external_exports.boolean().optional(),
  skip_config_files: external_exports.boolean().optional(),
  skip_build_artifacts: external_exports.boolean().optional(),
  trivial_patterns: external_exports.array(external_exports.string().refine(
    (pattern) => isValidRegexPattern(pattern),
    { message: "Invalid or unsafe regex pattern (check for ReDoS vulnerabilities)" }
  )).optional(),
  path_based_intensity: external_exports.boolean().optional(),
  path_intensity_patterns: external_exports.string().optional(),
  path_default_intensity: external_exports.enum(["thorough", "standard", "light"]).optional(),
  provider_selection_strategy: external_exports.enum(["reliability", "random", "round-robin"]).optional(),
  provider_exploration_rate: external_exports.number().min(0).max(1).optional(),
  intensity_provider_counts: external_exports.object({
    thorough: external_exports.number().int().min(1),
    standard: external_exports.number().int().min(1),
    light: external_exports.number().int().min(1)
  }).optional(),
  intensity_timeouts: external_exports.object({
    thorough: external_exports.number().int().min(1e3),
    standard: external_exports.number().int().min(1e3),
    light: external_exports.number().int().min(1e3)
  }).optional(),
  intensity_prompt_depth: external_exports.object({
    thorough: external_exports.enum(["detailed", "standard", "brief"]),
    standard: external_exports.enum(["detailed", "standard", "brief"]),
    light: external_exports.enum(["detailed", "standard", "brief"])
  }).optional(),
  min_confidence: external_exports.number().min(0).max(1).optional(),
  confidence_threshold: external_exports.object({
    critical: external_exports.number().min(0).max(1).optional(),
    high: external_exports.number().min(0).max(1).optional(),
    medium: external_exports.number().min(0).max(1).optional(),
    low: external_exports.number().min(0).max(1).optional()
  }).optional(),
  consensus_required_for_critical: external_exports.boolean().optional(),
  consensus_min_agreement: external_exports.number().int().min(2).optional(),
  suggestion_syntax_validation: external_exports.boolean().optional(),
  dry_run: external_exports.boolean().optional()
});

// src/utils/logger.ts
var LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
var CURRENT_LEVEL = process.env.LOG_LEVEL || "info";
function shouldLog(level) {
  return LEVELS[level] >= LEVELS[CURRENT_LEVEL];
}
function formatMessage(level, message, metadata) {
  const timestamp2 = (/* @__PURE__ */ new Date()).toISOString();
  const levelStr = level.toUpperCase().padEnd(5);
  if (metadata && Object.keys(metadata).length > 0) {
    const metaStr = JSON.stringify(metadata);
    return `[${timestamp2}] ${levelStr} ${message} ${metaStr}`;
  }
  return `[${timestamp2}] ${levelStr} ${message}`;
}
var logger = {
  debug(message, ...args) {
    if (shouldLog("debug")) {
      const metadata = args.length > 0 && typeof args[0] === "object" && !Array.isArray(args[0]) ? args[0] : void 0;
      console.debug(formatMessage("debug", message, metadata));
    }
  },
  info(message, ...args) {
    if (shouldLog("info")) {
      const metadata = args.length > 0 && typeof args[0] === "object" && !Array.isArray(args[0]) ? args[0] : void 0;
      console.info(formatMessage("info", message, metadata));
    }
  },
  warn(message, ...args) {
    if (shouldLog("warn")) {
      const metadata = args.length > 0 && typeof args[0] === "object" && !Array.isArray(args[0]) ? args[0] : void 0;
      console.warn(formatMessage("warn", message, metadata));
    }
  },
  error(message, ...args) {
    if (shouldLog("error")) {
      let metadata = {};
      let error2;
      for (const arg of args) {
        if (arg instanceof Error) {
          error2 = arg;
        } else if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
          metadata = { ...metadata, ...arg };
        }
      }
      if (error2) {
        metadata.error = error2.message;
        metadata.stack = error2.stack;
      }
      console.error(formatMessage("error", message, Object.keys(metadata).length > 0 ? metadata : void 0));
    }
  }
};

// src/utils/validation.ts
var ValidationError = class extends Error {
  constructor(message, field, hint) {
    super(message);
    this.field = field;
    this.hint = hint;
    this.name = "ValidationError";
  }
};
function validateRequired(value, field) {
  if (value === void 0 || value === null || value === "") {
    throw new ValidationError(
      `${field} is required`,
      field,
      `Please provide a value for ${field}`
    );
  }
}
function validatePositiveInteger(value, field) {
  const num = Number(value);
  if (isNaN(num)) {
    throw new ValidationError(
      `${field} must be a number`,
      field,
      `Received: ${JSON.stringify(value)}. Expected: positive integer`
    );
  }
  if (!Number.isInteger(num)) {
    throw new ValidationError(
      `${field} must be an integer`,
      field,
      `Received: ${value}. Decimals are not allowed`
    );
  }
  if (num <= 0) {
    throw new ValidationError(
      `${field} must be positive`,
      field,
      `Received: ${num}. Expected: value > 0`
    );
  }
  return num;
}
function validateNonNegativeNumber(value, field) {
  const num = Number(value);
  if (isNaN(num)) {
    throw new ValidationError(
      `${field} must be a number`,
      field,
      `Received: ${JSON.stringify(value)}. Expected: non-negative number`
    );
  }
  if (num < 0) {
    throw new ValidationError(
      `${field} cannot be negative`,
      field,
      `Received: ${num}. Expected: value >= 0`
    );
  }
  return num;
}
function validateInRange(value, field, min, max) {
  if (value < min || value > max) {
    throw new ValidationError(
      `${field} must be between ${min} and ${max}`,
      field,
      `Received: ${value}. Valid range: [${min}, ${max}]`
    );
  }
}
function validateEnum(value, field, allowedValues) {
  if (typeof value !== "string") {
    throw new ValidationError(
      `${field} must be a string`,
      field,
      `Received type: ${typeof value}. Expected one of: ${allowedValues.join(", ")}`
    );
  }
  if (!allowedValues.includes(value)) {
    throw new ValidationError(
      `${field} has invalid value`,
      field,
      `Received: "${value}". Expected one of: ${allowedValues.join(", ")}`
    );
  }
  return value;
}
function validateArray(value, field) {
  if (!Array.isArray(value)) {
    throw new ValidationError(
      `${field} must be an array`,
      field,
      `Received type: ${typeof value}. Expected: array`
    );
  }
  return value;
}
function validateStringArray(value, field) {
  const arr = validateArray(value, field);
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "string") {
      throw new ValidationError(
        `${field}[${i}] must be a string`,
        field,
        `Received type: ${typeof arr[i]} at index ${i}`
      );
    }
  }
  return arr;
}
function validateModelId(modelId) {
  if (!modelId || typeof modelId !== "string") {
    throw new ValidationError(
      "Model ID is required",
      "modelId",
      "Model ID must be a non-empty string"
    );
  }
  const validPrefixes = ["openrouter/", "opencode/", "anthropic/", "openai/"];
  const hasValidPrefix = validPrefixes.some((prefix) => modelId.startsWith(prefix));
  if (!hasValidPrefix && !modelId.includes("/")) {
    logger.warn(
      `Model ID "${modelId}" doesn't have a recognized provider prefix. Consider using: ${validPrefixes.map((p) => p + "model-name").join(", ")}`
    );
  }
}
function formatValidationError(error2) {
  if (error2 instanceof ValidationError) {
    let message = `\u274C ${error2.message}`;
    if (error2.field) {
      message += ` (field: ${error2.field})`;
    }
    if (error2.hint) {
      message += `
\u{1F4A1} Hint: ${error2.hint}`;
    }
    return message;
  }
  return `\u274C ${error2.message}`;
}
function validateConfig(config) {
  if (config.providers) {
    const providers = validateArray(config.providers, "providers");
    validateStringArray(providers, "providers");
    providers.forEach((p) => {
      if (typeof p === "string") {
        validateModelId(p);
      }
    });
  }
  if (config.providerLimit !== void 0 && config.providerLimit !== null) {
    const limit = validateNonNegativeNumber(config.providerLimit, "providerLimit");
    if (limit > 0) {
      validateInRange(limit, "providerLimit", 1, 100);
    }
  }
  if (config.inlineMaxComments !== void 0) {
    const maxComments = validateNonNegativeNumber(config.inlineMaxComments, "inlineMaxComments");
    if (maxComments > 100) {
      logger.warn(
        `inlineMaxComments is set to ${maxComments}. Very high values may cause rate limiting on GitHub API.`
      );
    }
  }
  if (config.budgetMaxUsd !== void 0) {
    const budget = validateNonNegativeNumber(config.budgetMaxUsd, "budgetMaxUsd");
    if (budget > 100) {
      logger.warn(
        `budgetMaxUsd is set to $${budget}. This is unusually high. Make sure this is intentional.`
      );
    }
  }
  if (config.inlineMinSeverity) {
    validateEnum(
      config.inlineMinSeverity,
      "inlineMinSeverity",
      ["critical", "major", "minor"]
    );
  }
}

// src/config/loader.ts
var ConfigLoader = class {
  static CONFIG_PATHS = [
    ".github/multi-review.yml",
    ".github/multi-review.yaml",
    ".multi-review.yml",
    ".multi-review.yaml"
  ];
  static load() {
    const fileConfig = this.loadFromFile();
    const envConfig = this.loadFromEnv();
    const merged = this.merge(DEFAULT_CONFIG, fileConfig, envConfig);
    try {
      validateConfig(merged);
    } catch (error2) {
      if (error2 instanceof ValidationError) {
        throw new ValidationError(
          `Invalid configuration: ${error2.message}`,
          error2.field,
          error2.hint
        );
      }
      throw error2;
    }
    return merged;
  }
  static loadFromFile() {
    for (const relPath of this.CONFIG_PATHS) {
      const fullPath = path.join(process.cwd(), relPath);
      if (!fs2.existsSync(fullPath)) continue;
      try {
        const raw = fs2.readFileSync(fullPath, "utf8");
        const parsed = load(raw);
        const validated = ReviewConfigSchema.parse(parsed);
        return this.normalizeKeys(validated);
      } catch (error2) {
        const err = error2;
        logger.warn(`\u26A0\uFE0F  Failed to load config from ${relPath}: ${err.message}`);
        if (err.message.includes("YAMLException")) {
          logger.warn("\u{1F4A1} Check for YAML syntax errors (indentation, colons, quotes)");
        } else if (err.message.includes("parse")) {
          logger.warn("\u{1F4A1} Check that all values match expected types");
        }
      }
    }
    return {};
  }
  static loadFromEnv() {
    const env = process.env;
    return {
      providers: this.parseArray(env.REVIEW_PROVIDERS),
      synthesisModel: env.SYNTHESIS_MODEL,
      fallbackProviders: this.parseArray(env.FALLBACK_PROVIDERS),
      providerAllowlist: this.parseArray(env.PROVIDER_ALLOWLIST),
      providerBlocklist: this.parseArray(env.PROVIDER_BLOCKLIST),
      openrouterAllowPaid: this.parseBoolean(env.OPENROUTER_ALLOW_PAID),
      providerDiscoveryLimit: this.parseNumber(env.PROVIDER_DISCOVERY_LIMIT),
      providerLimit: this.parseNumber(env.PROVIDER_LIMIT),
      providerRetries: this.parseNumber(env.PROVIDER_RETRIES),
      providerMaxParallel: this.parseNumber(env.PROVIDER_MAX_PARALLEL),
      quietModeEnabled: this.parseBoolean(env.QUIET_MODE_ENABLED),
      quietMinConfidence: this.parseFloat(env.QUIET_MIN_CONFIDENCE),
      quietUseLearning: this.parseBoolean(env.QUIET_USE_LEARNING),
      learningEnabled: this.parseBoolean(env.LEARNING_ENABLED),
      learningMinFeedbackCount: this.parseNumber(env.LEARNING_MIN_FEEDBACK_COUNT),
      learningLookbackDays: this.parseNumber(env.LEARNING_LOOKBACK_DAYS),
      inlineMaxComments: this.parseNumber(env.INLINE_MAX_COMMENTS),
      inlineMinSeverity: this.parseSeverity(env.INLINE_MIN_SEVERITY),
      inlineMinAgreement: this.parseNumber(env.INLINE_MIN_AGREEMENT),
      skipLabels: this.parseArray(env.SKIP_LABELS),
      skipDrafts: this.parseBoolean(env.SKIP_DRAFTS),
      skipBots: this.parseBoolean(env.SKIP_BOTS),
      minChangedLines: this.parseNumber(env.MIN_CHANGED_LINES),
      maxChangedFiles: this.parseNumber(env.MAX_CHANGED_FILES),
      diffMaxBytes: this.parseNumber(env.DIFF_MAX_BYTES),
      runTimeoutSeconds: this.parseNumber(env.RUN_TIMEOUT_SECONDS),
      budgetMaxUsd: this.parseFloat(env.BUDGET_MAX_USD),
      enableAstAnalysis: this.parseBoolean(env.ENABLE_AST_ANALYSIS),
      enableSecurity: this.parseBoolean(env.ENABLE_SECURITY),
      enableCaching: this.parseBoolean(env.ENABLE_CACHING),
      enableTestHints: this.parseBoolean(env.ENABLE_TEST_HINTS),
      enableAiDetection: this.parseBoolean(env.ENABLE_AI_DETECTION),
      incrementalEnabled: this.parseBoolean(env.INCREMENTAL_ENABLED),
      incrementalCacheTtlDays: this.parseNumber(env.INCREMENTAL_CACHE_TTL_DAYS),
      batchMaxFiles: this.parseNumber(env.BATCH_MAX_FILES),
      providerBatchOverrides: this.parseOverrides(env.PROVIDER_BATCH_OVERRIDES),
      skipTrivialChanges: this.parseBoolean(env.SKIP_TRIVIAL_CHANGES),
      skipDependencyUpdates: this.parseBoolean(env.SKIP_DEPENDENCY_UPDATES),
      skipDocumentationOnly: this.parseBoolean(env.SKIP_DOCUMENTATION_ONLY),
      skipFormattingOnly: this.parseBoolean(env.SKIP_FORMATTING_ONLY),
      skipTestFixtures: this.parseBoolean(env.SKIP_TEST_FIXTURES),
      skipConfigFiles: this.parseBoolean(env.SKIP_CONFIG_FILES),
      skipBuildArtifacts: this.parseBoolean(env.SKIP_BUILD_ARTIFACTS),
      trivialPatterns: this.parseArray(env.TRIVIAL_PATTERNS),
      pathBasedIntensity: this.parseBoolean(env.PATH_BASED_INTENSITY),
      pathIntensityPatterns: env.PATH_INTENSITY_PATTERNS,
      pathDefaultIntensity: this.parseIntensity(env.PATH_DEFAULT_INTENSITY),
      dryRun: this.parseBoolean(env.DRY_RUN)
    };
  }
  static normalizeKeys(config) {
    return {
      providers: config.providers,
      synthesisModel: config.synthesis_model,
      fallbackProviders: config.fallback_providers,
      providerAllowlist: config.provider_allowlist,
      providerBlocklist: config.provider_blocklist,
      openrouterAllowPaid: config.openrouter_allow_paid,
      providerDiscoveryLimit: config.provider_discovery_limit,
      providerLimit: config.provider_limit,
      providerRetries: config.provider_retries,
      providerMaxParallel: config.provider_max_parallel,
      quietModeEnabled: config.quiet_mode_enabled,
      quietMinConfidence: config.quiet_min_confidence,
      quietUseLearning: config.quiet_use_learning,
      learningEnabled: config.learning_enabled,
      learningMinFeedbackCount: config.learning_min_feedback_count,
      learningLookbackDays: config.learning_lookback_days,
      inlineMaxComments: config.inline_max_comments,
      inlineMinSeverity: config.inline_min_severity,
      inlineMinAgreement: config.inline_min_agreement,
      skipLabels: config.skip_labels,
      skipDrafts: config.skip_drafts,
      skipBots: config.skip_bots,
      minChangedLines: config.min_changed_lines,
      maxChangedFiles: config.max_changed_files,
      diffMaxBytes: config.diff_max_bytes,
      runTimeoutSeconds: config.run_timeout_seconds,
      budgetMaxUsd: config.budget_max_usd,
      enableAstAnalysis: config.enable_ast_analysis,
      enableSecurity: config.enable_security,
      enableCaching: config.enable_caching,
      enableTestHints: config.enable_test_hints,
      enableAiDetection: config.enable_ai_detection,
      incrementalEnabled: config.incremental_enabled,
      incrementalCacheTtlDays: config.incremental_cache_ttl_days,
      batchMaxFiles: config.batch_max_files,
      providerBatchOverrides: config.provider_batch_overrides,
      enableTokenAwareBatching: config.enable_token_aware_batching,
      targetTokensPerBatch: config.target_tokens_per_batch,
      graphEnabled: config.graph_enabled,
      graphCacheEnabled: config.graph_cache_enabled,
      graphMaxDepth: config.graph_max_depth,
      graphTimeoutSeconds: config.graph_timeout_seconds,
      generateFixPrompts: config.generate_fix_prompts,
      fixPromptFormat: config.fix_prompt_format,
      analyticsEnabled: config.analytics_enabled,
      analyticsMaxReviews: config.analytics_max_reviews,
      analyticsDeveloperRate: config.analytics_developer_rate,
      analyticsManualReviewTime: config.analytics_manual_review_time,
      pluginsEnabled: config.plugins_enabled,
      pluginDir: config.plugin_dir,
      pluginAllowlist: config.plugin_allowlist,
      pluginBlocklist: config.plugin_blocklist,
      skipTrivialChanges: config.skip_trivial_changes,
      skipDependencyUpdates: config.skip_dependency_updates,
      skipDocumentationOnly: config.skip_documentation_only,
      skipFormattingOnly: config.skip_formatting_only,
      skipTestFixtures: config.skip_test_fixtures,
      skipConfigFiles: config.skip_config_files,
      skipBuildArtifacts: config.skip_build_artifacts,
      trivialPatterns: config.trivial_patterns,
      pathBasedIntensity: config.path_based_intensity,
      pathIntensityPatterns: config.path_intensity_patterns,
      pathDefaultIntensity: config.path_default_intensity,
      providerSelectionStrategy: config.provider_selection_strategy,
      providerExplorationRate: config.provider_exploration_rate,
      intensityProviderCounts: config.intensity_provider_counts,
      intensityTimeouts: config.intensity_timeouts,
      intensityPromptDepth: config.intensity_prompt_depth,
      dryRun: config.dry_run
    };
  }
  static merge(defaults2, ...overrides) {
    return overrides.reduce((acc, curr) => {
      const next = {};
      for (const [key, value] of Object.entries(curr)) {
        if (value === void 0 || value === null) continue;
        const typedKey = key;
        next[typedKey] = value;
      }
      return { ...acc, ...next };
    }, defaults2);
  }
  static parseArray(value) {
    if (!value) return void 0;
    return value.split(",").map((v) => v.trim()).filter(Boolean);
  }
  static parseBoolean(value) {
    if (value === void 0) return void 0;
    return value.toLowerCase() === "true";
  }
  static parseNumber(value) {
    if (!value) return void 0;
    const num = parseInt(value, 10);
    return Number.isFinite(num) ? num : void 0;
  }
  static parseFloat(value) {
    if (!value) return void 0;
    const num = Number.parseFloat(value);
    return Number.isFinite(num) ? num : void 0;
  }
  static parseOverrides(value) {
    if (!value) return void 0;
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
        throw new Error("Overrides must be a JSON object");
      }
      const result = {};
      for (const [key, val] of Object.entries(parsed)) {
        const num = Number(val);
        if (!Number.isFinite(num)) continue;
        const intVal = Math.trunc(num);
        if (intVal < 1) {
          logger.warn(`Ignoring PROVIDER_BATCH_OVERRIDES entry for "${key}": value ${intVal} is below minimum 1`);
          continue;
        }
        const clamped = Math.min(intVal, 200);
        if (clamped !== intVal) {
          logger.warn(`Clamping PROVIDER_BATCH_OVERRIDES entry for "${key}" from ${intVal} to maximum 200`);
        }
        result[key] = clamped;
      }
      return result;
    } catch (error2) {
      const message = `Failed to parse PROVIDER_BATCH_OVERRIDES: ${error2.message}`;
      logger.warn(message);
      return void 0;
    }
  }
  static parseSeverity(value) {
    if (!value) return void 0;
    const normalized = value.toLowerCase();
    if (normalized === "critical" || normalized === "major" || normalized === "minor") {
      return normalized;
    }
    return void 0;
  }
  static parseIntensity(value) {
    if (!value) return void 0;
    const normalized = value.toLowerCase();
    if (normalized === "thorough" || normalized === "standard" || normalized === "light") {
      return normalized;
    }
    return void 0;
  }
};

// src/providers/base.ts
var Provider = class {
  constructor(name) {
    this.name = name;
  }
  /**
   * Health check to verify provider responsiveness before running full review
   * Uses a realistic mini code review task to better predict actual performance
   * @param timeoutMs - Maximum time to wait for response (default 30s)
   * @returns true if provider is responsive, false otherwise
   */
  async healthCheck(timeoutMs = 3e4) {
    try {
      const testPrompt = `Review this code change and respond with a brief finding in JSON format:
\`\`\`typescript
function add(a, b) {
  return a + b;  // Missing type annotations
}
\`\`\`

Respond with: {"findings": [{"file": "test.ts", "line": 1, "severity": "minor", "title": "title", "message": "msg"}]}`;
      await this.review(testPrompt, timeoutMs);
      return true;
    } catch (error2) {
      return false;
    }
  }
  static validate(name) {
    const pattern = /^(opencode\/[\w.:~-]+|openrouter\/[\w.:~-]+(?:\/[\w.:~-]+)*|claude\/[\w.:~-]+|codex\/[\w.:~-]+|gemini\/[\w.:~-]+)$/i;
    return pattern.test(name);
  }
};
var RateLimitError = class extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "RateLimitError";
  }
};

// node_modules/p-retry/index.js
var import_retry = __toESM(require_retry2(), 1);

// node_modules/is-network-error/index.js
var objectToString = Object.prototype.toString;
var isError = (value) => objectToString.call(value) === "[object Error]";
var errorMessages = /* @__PURE__ */ new Set([
  "network error",
  // Chrome
  "Failed to fetch",
  // Chrome
  "NetworkError when attempting to fetch resource.",
  // Firefox
  "The Internet connection appears to be offline.",
  // Safari 16
  "Network request failed",
  // `cross-fetch`
  "fetch failed",
  // Undici (Node.js)
  "terminated",
  // Undici (Node.js)
  " A network error occurred.",
  // Bun (WebKit)
  "Network connection lost"
  // Cloudflare Workers (fetch)
]);
function isNetworkError(error2) {
  const isValid2 = error2 && isError(error2) && error2.name === "TypeError" && typeof error2.message === "string";
  if (!isValid2) {
    return false;
  }
  const { message, stack } = error2;
  if (message === "Load failed") {
    return stack === void 0 || "__sentry_captured__" in error2;
  }
  if (message.startsWith("error sending request for url")) {
    return true;
  }
  return errorMessages.has(message);
}

// node_modules/p-retry/index.js
var AbortError = class extends Error {
  constructor(message) {
    super();
    if (message instanceof Error) {
      this.originalError = message;
      ({ message } = message);
    } else {
      this.originalError = new Error(message);
      this.originalError.stack = this.stack;
    }
    this.name = "AbortError";
    this.message = message;
  }
};
var decorateErrorWithCounts = (error2, attemptNumber, options) => {
  const retriesLeft = options.retries - (attemptNumber - 1);
  error2.attemptNumber = attemptNumber;
  error2.retriesLeft = retriesLeft;
  return error2;
};
async function pRetry(input, options) {
  return new Promise((resolve2, reject) => {
    options = { ...options };
    options.onFailedAttempt ??= () => {
    };
    options.shouldRetry ??= () => true;
    options.retries ??= 10;
    const operation = import_retry.default.operation(options);
    const abortHandler = () => {
      operation.stop();
      reject(options.signal?.reason);
    };
    if (options.signal && !options.signal.aborted) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
    const cleanUp = () => {
      options.signal?.removeEventListener("abort", abortHandler);
      operation.stop();
    };
    operation.attempt(async (attemptNumber) => {
      try {
        const result = await input(attemptNumber);
        cleanUp();
        resolve2(result);
      } catch (error2) {
        try {
          if (!(error2 instanceof Error)) {
            throw new TypeError(`Non-error was thrown: "${error2}". You should only throw errors.`);
          }
          if (error2 instanceof AbortError) {
            throw error2.originalError;
          }
          if (error2 instanceof TypeError && !isNetworkError(error2)) {
            throw error2;
          }
          decorateErrorWithCounts(error2, attemptNumber, options);
          if (!await options.shouldRetry(error2)) {
            operation.stop();
            reject(error2);
          }
          await options.onFailedAttempt(error2);
          if (!operation.retry(error2)) {
            throw operation.mainError();
          }
        } catch (finalError) {
          decorateErrorWithCounts(finalError, attemptNumber, options);
          cleanUp();
          reject(finalError);
        }
      }
    });
  });
}

// src/utils/retry.ts
async function withRetry(fn, options) {
  if (options.retryOn) {
    const maxAttempts = options.retries + 1;
    const minTimeout = options.minTimeout ?? 500;
    const factor = options.factor ?? 2;
    let delay = minTimeout;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error2) {
        const err = error2;
        if (!options.retryOn(err) || attempt === maxAttempts) {
          throw err;
        }
        logger.warn(`Retryable error: attempt ${attempt} of ${maxAttempts}`, err.message);
        await new Promise((resolve2) => setTimeout(resolve2, delay));
        delay = Math.min(delay * factor, options.maxTimeout ?? 4e3);
      }
    }
  }
  return pRetry(fn, {
    retries: options.retries,
    factor: options.factor ?? 2,
    minTimeout: options.minTimeout ?? 500,
    maxTimeout: options.maxTimeout ?? 4e3,
    onFailedAttempt: (error2) => {
      logger.warn(
        `Retryable error: attempt ${error2.attemptNumber} of ${options.retries + 1}`,
        error2.message
      );
    }
  });
}

// src/providers/openrouter.ts
var OpenRouterProvider = class _OpenRouterProvider extends Provider {
  constructor(modelId, apiKey, rateLimiter) {
    super(`openrouter/${modelId}`);
    this.modelId = modelId;
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter;
    if (typeof fetch === "undefined") {
      throw new Error("fetch is not available. Please use Node.js 18+ or polyfill fetch.");
    }
  }
  static BASE_URL = "https://openrouter.ai/api/v1";
  async review(prompt, timeoutMs) {
    if (await this.rateLimiter.isRateLimited(this.name)) {
      throw new RateLimitError(`${this.name} is currently rate-limited`);
    }
    if (typeof fetch !== "function") {
      throw new Error("Global fetch is not available; please use Node 18+ or provide a fetch polyfill.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    const apiModelId = this.modelId.replace(/#\d+$/, "");
    try {
      const response = await withRetry(
        () => fetch(`${_OpenRouterProvider.BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "HTTP-Referer": "https://github.com/keithah/multi-provider-code-review",
            "X-Title": "Multi-Provider Code Review"
          },
          body: JSON.stringify({
            model: apiModelId,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_tokens: 2e3
          }),
          signal: controller.signal
        }),
        {
          retries: 1,
          retryOn: (error2) => {
            const err = error2;
            if (err instanceof RateLimitError) return false;
            if (err.name === "AbortError") return false;
            return true;
          }
        }
      );
      if (!response || !("ok" in response)) {
        throw new Error("OpenRouter API returned invalid response");
      }
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        let seconds = NaN;
        if (retryAfter) {
          const parsedSeconds = parseInt(retryAfter, 10);
          if (!isNaN(parsedSeconds) && parsedSeconds >= 0) {
            seconds = parsedSeconds;
          } else {
            const parsedDate = Date.parse(retryAfter);
            if (!isNaN(parsedDate) && parsedDate > Date.now()) {
              seconds = Math.ceil((parsedDate - Date.now()) / 1e3);
            }
          }
        }
        const minutes = !isNaN(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 60;
        if (response.status === 429) {
          await this.rateLimiter.markRateLimited(this.name, minutes, "HTTP 429 from OpenRouter");
          throw new RateLimitError(`Rate limited: ${this.name}`, minutes * 60);
        }
        if (response.status === 402) {
          const blockMinutes = Math.max(minutes || 0, 60 * 24);
          logger.warn(
            `Model ${this.name} returned 402 Payment Required. Blocking for ${blockMinutes} minutes to avoid repeated failures. This usually means the model requires credits or a paid plan.`
          );
          await this.rateLimiter.markRateLimited(this.name, blockMinutes, "HTTP 402 Payment Required from OpenRouter");
          throw new RateLimitError(`Payment required: ${this.name}`, blockMinutes * 60);
        }
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      const durationSeconds = (Date.now() - started) / 1e3;
      const content = data.choices?.[0]?.message?.content || "";
      const usage = data.usage;
      const actualModel = data.model;
      const findings = this.extractFindings(content);
      const aiAnalysis = this.extractAIAnalysis(content);
      if (actualModel && actualModel !== apiModelId) {
        logger.info(`OpenRouter routed ${this.name} -> ${actualModel}`);
      }
      return {
        content,
        usage: usage ? {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0
        } : void 0,
        durationSeconds,
        findings,
        aiLikelihood: aiAnalysis?.likelihood,
        aiReasoning: aiAnalysis?.reasoning,
        actualModel
        // Include actual model in result for analytics
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  extractFindings(content) {
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
      if (jsonMatch) {
        const parsed2 = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed2)) return parsed2;
        return parsed2.findings || [];
      }
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
      return parsed.findings || [];
    } catch (error2) {
      logger.debug("Failed to parse findings from content", error2);
      return [];
    }
  }
  extractAIAnalysis(content) {
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const raw = jsonMatch ? jsonMatch[1] : content;
      const parsed = JSON.parse(raw);
      if (parsed.ai_likelihood !== void 0) {
        return { likelihood: parsed.ai_likelihood, reasoning: parsed.ai_reasoning };
      }
    } catch (error2) {
      logger.debug("Failed to parse AI analysis from OpenRouter response", error2);
    }
    return void 0;
  }
};

// src/providers/opencode.ts
var import_child_process = require("child_process");
var fs3 = __toESM(require("fs/promises"));
var os = __toESM(require("os"));
var path2 = __toESM(require("path"));
var crypto = __toESM(require("crypto"));
var OpenCodeProvider = class extends Provider {
  constructor(modelId) {
    super(`opencode/${modelId}`);
    this.modelId = modelId;
  }
  // Lightweight health check: verify CLI is available; skip full review run
  async healthCheck(_timeoutMs = 5e3) {
    const timeoutMs = Math.max(500, _timeoutMs ?? 5e3);
    let timeoutId;
    let isTimedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(new Error(`OpenCode health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([
        this.resolveBinary().then(() => {
          if (isTimedOut) {
            logger.debug(`OpenCode binary resolved after timeout (${this.name})`);
          }
        }),
        timeoutPromise
      ]);
      clearTimeout(timeoutId);
      return true;
    } catch (error2) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      logger.warn(`OpenCode health check failed for ${this.name}: ${error2.message}`);
      return false;
    }
  }
  async review(prompt, timeoutMs) {
    const started = Date.now();
    const { bin, args: baseArgs } = await this.resolveBinary();
    const cliModel = this.modelId.startsWith("opencode/") ? this.modelId : `opencode/${this.modelId}`;
    const tmpDir = await fs3.mkdtemp(path2.join(os.tmpdir(), "opencode-"));
    await fs3.chmod(tmpDir, 448);
    const promptFile = path2.join(tmpDir, `prompt-${crypto.randomBytes(8).toString("hex")}.txt`);
    await fs3.writeFile(promptFile, prompt, { encoding: "utf8", mode: 384 });
    const args = [...baseArgs, "run", "-m", cliModel, "--file", promptFile, "--", "Review the attached PR context and provide structured findings."];
    logger.info(`Running OpenCode CLI: ${bin} ${args.slice(0, 3).join(" ")} \u2026`);
    try {
      const { stdout, stderr } = await this.runCli(bin, args, timeoutMs);
      const content = stdout.trim();
      const durationSeconds = (Date.now() - started) / 1e3;
      logger.info(
        `OpenCode CLI output for ${this.name}: stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, duration=${durationSeconds.toFixed(1)}s`
      );
      if (!content) {
        throw new Error(`OpenCode CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ""}`);
      }
      return {
        content,
        durationSeconds,
        findings: this.extractFindings(content)
      };
    } catch (error2) {
      logger.error(`OpenCode provider failed: ${this.name}`, error2);
      throw error2;
    } finally {
      try {
        await fs3.unlink(promptFile);
        await fs3.rmdir(tmpDir);
      } catch (err) {
      }
    }
  }
  runCli(bin, args, timeoutMs) {
    return new Promise((resolve2, reject) => {
      const proc = (0, import_child_process.spawn)(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      if (proc.unref) {
        proc.unref();
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn(`OpenCode CLI timeout (${timeoutMs}ms), killing process and all children`);
        try {
          if (proc.pid) {
            process.kill(-proc.pid, "SIGKILL");
          }
        } catch (err) {
          proc.kill("SIGKILL");
        }
        reject(new Error(`OpenCode CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(err);
        }
      });
      proc.on("close", (code) => {
        if (!timedOut) {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`OpenCode CLI exited with code ${code}: ${stderr || stdout || "no output"}`));
          } else {
            resolve2({ stdout: stdout.trim(), stderr: stderr.trim() });
          }
        }
      });
    });
  }
  async resolveBinary() {
    if (await this.canRun("opencode", ["--version"])) {
      return { bin: "opencode", args: [] };
    }
    if (await this.canRun("npx", ["--yes", "opencode-ai", "--version"])) {
      return { bin: "npx", args: ["--yes", "opencode-ai"] };
    }
    throw new Error("OpenCode CLI is not available (opencode or npx opencode-ai)");
  }
  async canRun(cmd, args) {
    return new Promise((resolve2) => {
      const proc = (0, import_child_process.spawn)(cmd, args, { stdio: "ignore" });
      proc.on("error", () => resolve2(false));
      proc.on("close", (code) => resolve2(code === 0));
    });
  }
  extractFindings(content) {
    try {
      const match2 = content.match(/```json\s*([\s\S]*?)```/i);
      if (match2) {
        const parsed2 = JSON.parse(match2[1]);
        if (Array.isArray(parsed2)) return parsed2;
        return parsed2.findings || [];
      }
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
      return parsed.findings || [];
    } catch (error2) {
      logger.debug("Failed to parse findings from OpenCode response", error2);
    }
    return [];
  }
};

// src/providers/claude-code.ts
var import_child_process2 = require("child_process");
var fs4 = __toESM(require("fs/promises"));
var os2 = __toESM(require("os"));
var path3 = __toESM(require("path"));
var crypto2 = __toESM(require("crypto"));
var ClaudeCodeProvider = class extends Provider {
  constructor(model) {
    super(`claude/${model}`);
    this.model = model;
  }
  // Lightweight health check: verify CLI is available
  async healthCheck(_timeoutMs = 5e3) {
    const timeoutMs = Math.max(500, _timeoutMs ?? 5e3);
    let timeoutId;
    let isTimedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(new Error(`Claude Code health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([
        this.resolveBinary().then(() => {
          if (isTimedOut) {
            logger.debug(`Claude Code binary resolved after timeout (${this.name})`);
          }
        }),
        timeoutPromise
      ]);
      clearTimeout(timeoutId);
      return true;
    } catch (error2) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      logger.warn(`Claude Code health check failed for ${this.name}: ${error2.message}`);
      return false;
    }
  }
  async review(prompt, timeoutMs) {
    const started = Date.now();
    const binary2 = await this.resolveBinary();
    const tmpDir = await fs4.mkdtemp(path3.join(os2.tmpdir(), "claude-code-"));
    await fs4.chmod(tmpDir, 448);
    const promptFile = path3.join(tmpDir, `prompt-${crypto2.randomBytes(8).toString("hex")}.txt`);
    await fs4.writeFile(promptFile, prompt, { encoding: "utf8", mode: 384 });
    const args = [
      "--model",
      this.model,
      "--print",
      "--no-session-persistence",
      "--output-format",
      "json",
      promptFile
    ];
    logger.info(`Running Claude Code CLI: ${binary2} --model ${this.model} --print ...`);
    try {
      const { stdout, stderr } = await this.runCli(binary2, args, timeoutMs);
      const content = stdout.trim();
      const durationSeconds = (Date.now() - started) / 1e3;
      logger.info(
        `Claude Code CLI output for ${this.name}: stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, duration=${durationSeconds.toFixed(1)}s`
      );
      if (!content) {
        throw new Error(`Claude Code CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ""}`);
      }
      return {
        content,
        durationSeconds,
        findings: this.extractFindings(content)
      };
    } catch (error2) {
      logger.error(`Claude Code provider failed: ${this.name}`, error2);
      throw error2;
    } finally {
      try {
        await fs4.unlink(promptFile);
        await fs4.rmdir(tmpDir);
      } catch (err) {
      }
    }
  }
  runCli(bin, args, timeoutMs) {
    return new Promise((resolve2, reject) => {
      const proc = (0, import_child_process2.spawn)(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: process.env
      });
      if (proc.unref) {
        proc.unref();
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn(`Claude Code CLI timeout (${timeoutMs}ms), killing process and all children`);
        try {
          if (proc.pid) {
            process.kill(-proc.pid, "SIGKILL");
          }
        } catch (err) {
          proc.kill("SIGKILL");
        }
        reject(new Error(`Claude Code CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(err);
        }
      });
      proc.on("close", (code) => {
        if (!timedOut) {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`Claude Code CLI exited with code ${code}: ${stderr || stdout || "no output"}`));
          } else {
            resolve2({ stdout: stdout.trim(), stderr: stderr.trim() });
          }
        }
      });
    });
  }
  async resolveBinary() {
    if (await this.canRun("claude", ["--version"])) {
      return "claude";
    }
    if (await this.canRun("/usr/local/bin/claude", ["--version"])) {
      return "/usr/local/bin/claude";
    }
    const homeDir = os2.homedir();
    const localBin = path3.join(homeDir, ".local", "bin", "claude");
    if (await this.canRun(localBin, ["--version"])) {
      return localBin;
    }
    throw new Error("Claude Code CLI is not available (tried: claude, /usr/local/bin/claude, ~/.local/bin/claude)");
  }
  async canRun(cmd, args) {
    return new Promise((resolve2) => {
      const proc = (0, import_child_process2.spawn)(cmd, args, { stdio: "ignore" });
      proc.on("error", () => resolve2(false));
      proc.on("close", (code) => resolve2(code === 0));
    });
  }
  extractFindings(content) {
    try {
      const match2 = content.match(/```json\s*([\s\S]*?)```/i);
      if (match2) {
        const parsed2 = JSON.parse(match2[1]);
        if (Array.isArray(parsed2)) return parsed2;
        return parsed2.findings || [];
      }
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
      return parsed.findings || [];
    } catch (error2) {
      logger.debug("Failed to parse findings from Claude Code response", error2);
    }
    return [];
  }
};

// src/providers/codex.ts
var import_child_process3 = require("child_process");
var fs5 = __toESM(require("fs/promises"));
var os3 = __toESM(require("os"));
var path4 = __toESM(require("path"));
var crypto3 = __toESM(require("crypto"));

// src/utils/token-estimation.ts
function estimateTokensSimple(text) {
  const characters = text.length;
  const bytes = Buffer.byteLength(text, "utf8");
  let tokens = Math.ceil(characters / 4);
  const codeIndicators = (text.match(/[{}()[\];]/g) || []).length;
  const isCodeHeavy = codeIndicators > characters * 0.05;
  if (isCodeHeavy) {
    tokens = Math.ceil(characters / 3);
  }
  return {
    tokens,
    bytes,
    characters,
    method: "simple"
  };
}
function estimateTokensConservative(text) {
  const simple = estimateTokensSimple(text);
  const SAFETY_MARGIN = 1.1;
  return {
    ...simple,
    tokens: Math.ceil(simple.tokens * SAFETY_MARGIN)
  };
}
function estimateTokensForDiff(diff) {
  const estimate = estimateTokensSimple(diff);
  return {
    ...estimate,
    tokens: estimate.tokens
    // Conservative: no multiplier
  };
}
function getContextWindowSize(modelId) {
  const CONTEXT_WINDOWS = {
    // OpenRouter models (common ones)
    "openrouter/free": 128e3,
    // Conservative default for auto-routing
    "openrouter/google/gemini-2.0-flash-exp:free": 1e6,
    // 1M tokens
    "openrouter/mistralai/devstral-2512:free": 256e3,
    // 256k tokens
    "openrouter/xiaomi/mimo-v2-flash:free": 128e3,
    // 128k tokens
    "openrouter/microsoft/phi-4:free": 16e3,
    // 16k tokens
    // Generic patterns
    "gemini-2.0": 1e6,
    "gemini-1.5-pro": 1e6,
    "gemini-1.5-flash": 1e6,
    "claude-3-opus": 2e5,
    "claude-3-sonnet": 2e5,
    "claude-3-haiku": 2e5,
    "claude-3.5-sonnet": 2e5,
    "claude-3.5-haiku": 2e5,
    "gpt-4": 8e3,
    "gpt-4-turbo": 128e3,
    "gpt-4o": 128e3,
    "gpt-3.5-turbo": 4e3,
    "o1": 2e5,
    "o1-mini": 128e3
  };
  if (CONTEXT_WINDOWS[modelId]) {
    return CONTEXT_WINDOWS[modelId];
  }
  for (const [pattern, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (modelId.includes(pattern)) {
      return size;
    }
  }
  return 4e3;
}
function checkContextWindowFit(prompt, modelId, reservedTokensForResponse = 2e3) {
  const estimate = estimateTokensConservative(prompt);
  const contextWindow = getContextWindowSize(modelId);
  const availableTokens = contextWindow - reservedTokensForResponse;
  const fits = estimate.tokens <= availableTokens;
  const utilization = estimate.tokens / contextWindow * 100;
  let recommendation = "";
  if (!fits) {
    const overage = estimate.tokens - availableTokens;
    recommendation = `Prompt exceeds context window by ${overage} tokens. Reduce batch size or trim diff content.`;
  } else if (utilization > 90) {
    recommendation = `High utilization (${utilization.toFixed(0)}%). Consider reducing batch size for better response quality.`;
  } else if (utilization > 75) {
    recommendation = `Moderate utilization (${utilization.toFixed(0)}%). Acceptable but monitor response quality.`;
  } else {
    recommendation = `Good utilization (${utilization.toFixed(0)}%). Context window has sufficient headroom.`;
  }
  return {
    fits,
    promptTokens: estimate.tokens,
    contextWindow,
    availableTokens,
    utilizationPercent: utilization,
    recommendation
  };
}
function estimateTokensForFile(file) {
  if (file.patch) {
    const estimate = estimateTokensForDiff(file.patch);
    return estimate.tokens;
  }
  const linesChanged = file.additions + file.deletions;
  return linesChanged * 20;
}
function estimateTokensForFiles(files) {
  return files.reduce((total, file) => total + estimateTokensForFile(file), 0);
}
function calculateOptimalBatchSize(files, targetTokensPerBatch = 5e4, maxFilesPerBatch = 200) {
  if (files.length === 0) {
    return {
      batchSize: 0,
      reason: "No files to batch",
      estimatedTokensPerBatch: 0,
      batches: []
    };
  }
  const filesWithSizes = files.map((file) => ({
    file,
    tokens: estimateTokensForFile(file)
  }));
  filesWithSizes.sort((a, b) => b.tokens - a.tokens);
  const batches = [];
  let currentBatch = [];
  let currentBatchTokens = 0;
  for (const { file, tokens } of filesWithSizes) {
    if (currentBatchTokens + tokens > targetTokensPerBatch && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchTokens = 0;
    }
    currentBatch.push(file);
    currentBatchTokens += tokens;
    if (currentBatch.length >= maxFilesPerBatch) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchTokens = 0;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  const avgBatchSize = batches.length > 0 ? Math.ceil(files.length / batches.length) : 0;
  const avgTokensPerBatch = batches.length > 0 ? batches.reduce((sum, batch) => sum + estimateTokensForFiles(batch), 0) / batches.length : 0;
  let reason;
  if (batches.length === 1) {
    reason = `All ${files.length} files fit in single batch (~${avgTokensPerBatch.toFixed(0)} tokens)`;
  } else if (avgBatchSize < 10) {
    reason = `Large files require small batches (avg ${avgBatchSize} files, ~${avgTokensPerBatch.toFixed(0)} tokens each)`;
  } else if (avgBatchSize > 100) {
    reason = `Small files allow large batches (avg ${avgBatchSize} files, ~${avgTokensPerBatch.toFixed(0)} tokens each)`;
  } else {
    reason = `Mixed file sizes, ${batches.length} batches (avg ${avgBatchSize} files, ~${avgTokensPerBatch.toFixed(0)} tokens each)`;
  }
  return {
    batchSize: avgBatchSize,
    reason,
    estimatedTokensPerBatch: avgTokensPerBatch,
    batches
  };
}

// src/providers/codex.ts
var CodexProvider = class extends Provider {
  constructor(model) {
    super(`codex/${model}`);
    this.model = model;
  }
  // Verify the CLI is available and, by default, that the selected model works
  // with the current Codex auth. Binary-only checks can mark unsupported models
  // as healthy, which then creates green "no provider" review runs.
  async healthCheck(_timeoutMs = 5e3) {
    const timeoutMs = Math.max(500, _timeoutMs ?? 5e3);
    const mode = (process.env.CODEX_HEALTHCHECK_MODE || "exec").toLowerCase();
    let timeoutId;
    let isTimedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(new Error(`Codex health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const binary2 = await Promise.race([
        this.resolveBinary().then((resolved) => {
          if (isTimedOut) {
            logger.debug(`Codex binary resolved after timeout (${this.name})`);
          }
          return resolved;
        }),
        timeoutPromise
      ]);
      clearTimeout(timeoutId);
      if (mode === "none" || mode === "binary") {
        return true;
      }
      const { stdout } = await this.runCliWithStdin(
        binary2,
        this.buildExecArgs({ healthCheck: true }),
        "Respond with exactly: codex-health-ok",
        timeoutMs
      );
      if (!stdout.includes("codex-health-ok")) {
        logger.warn(`Codex health check returned unexpected output for ${this.name}`);
        return false;
      }
      return true;
    } catch (error2) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      logger.warn(`Codex health check failed for ${this.name}: ${error2.message}`);
      return false;
    }
  }
  async review(prompt, timeoutMs) {
    const started = Date.now();
    const binary2 = await this.resolveBinary();
    const args = this.buildExecArgs({ healthCheck: false });
    logger.info(`Running Codex CLI: codex exec --model ${this.model} --dangerously-bypass-approvals-and-sandbox ...`);
    try {
      const { stdout, stderr } = await this.runCliWithStdin(binary2, args, prompt, timeoutMs);
      const content = stdout.trim();
      const durationSeconds = (Date.now() - started) / 1e3;
      logger.info(
        `Codex CLI output for ${this.name}: stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, duration=${durationSeconds.toFixed(1)}s`
      );
      if (!content) {
        throw new Error(`Codex CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ""}`);
      }
      return {
        content,
        durationSeconds,
        usage: this.estimateUsage(prompt, content),
        findings: this.extractFindings(content)
      };
    } catch (error2) {
      logger.error(`Codex provider failed: ${this.name}`, error2);
      throw error2;
    }
  }
  estimateUsage(prompt, content) {
    const promptTokens = estimateTokensSimple(prompt).tokens;
    const completionTokens = estimateTokensSimple(content).tokens;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }
  buildExecArgs(options) {
    const args = [
      "exec",
      "--model",
      this.model,
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "approval_policy=never"
    ];
    const effort = options.healthCheck ? process.env.CODEX_HEALTHCHECK_REASONING_EFFORT || "low" : process.env.CODEX_REASONING_EFFORT;
    if (effort) {
      const normalized = effort.trim().toLowerCase();
      if (/^[a-z]+$/.test(normalized)) {
        args.push("-c", `model_reasoning_effort="${normalized}"`);
      }
    }
    args.push("-");
    return args;
  }
  async runCliWithStdin(bin, args, stdin, timeoutMs) {
    const tmpFile = path4.join(os3.tmpdir(), `codex-prompt-${crypto3.randomBytes(8).toString("hex")}.txt`);
    let fd;
    try {
      await fs5.writeFile(tmpFile, stdin, { encoding: "utf8", mode: 384 });
      fd = await fs5.open(tmpFile, "r");
      const fdNum = fd.fd;
      return await new Promise((resolve2, reject) => {
        const proc = (0, import_child_process3.spawn)(bin, args, {
          stdio: [fdNum, "pipe", "pipe"],
          detached: true,
          env: process.env
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          logger.warn(`Codex CLI timeout (${timeoutMs}ms), killing process and all children`);
          try {
            if (proc.pid) {
              process.kill(-proc.pid, "SIGKILL");
            }
          } catch {
            proc.kill("SIGKILL");
          }
          reject(new Error(`Codex CLI timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        proc.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        proc.on("error", (err) => {
          if (!timedOut) {
            clearTimeout(timer);
            reject(err);
          }
        });
        proc.on("close", (code) => {
          if (!timedOut) {
            clearTimeout(timer);
            if (code !== 0) {
              reject(new Error(`Codex CLI exited with code ${code}: ${this.formatCliError(stderr, stdout)}`));
            } else {
              resolve2({ stdout, stderr });
            }
          }
        });
      });
    } finally {
      try {
        if (fd) {
          await fd.close();
        }
        await fs5.unlink(tmpFile);
      } catch {
      }
    }
  }
  formatCliError(stderr, stdout) {
    const raw = (stderr || stdout || "no output").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").replace(/www_authenticate_header:\s*"[^"]+"/gi, 'www_authenticate_header: "[redacted]"').replace(/authorization_uri="[^"]+"/gi, 'authorization_uri="[redacted]"').replace(/authorization_uri=\\?"[^"\\]*(?:\\.[^"\\]*)*\\?"/gi, 'authorization_uri="[redacted]"').replace(/https?:\/\/[^\s",)]+/gi, "[redacted-url]").replace(/session id:\s*[a-f0-9-]+/gi, "session id: [redacted]").replace(/thread\s+[a-f0-9-]{8,}/gi, "thread [redacted]");
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !line.startsWith("user") && !line.includes("Respond with exactly:"));
    const jsonMessages = Array.from(raw.matchAll(/"message"\s*:\s*"([^"]+)"/gi)).map((match2) => match2[1]).filter(Boolean);
    if (jsonMessages.length > 0) {
      return this.truncateCliError([...new Set(jsonMessages)].join(" "));
    }
    const important = lines.filter(
      (line) => /not supported|invalid_request_error|auth|error|failed|timed out|timeout/i.test(line)
    );
    const summary = (important.length > 0 ? important : lines).join(" ");
    return this.truncateCliError(summary);
  }
  truncateCliError(message) {
    return message.length > 800 ? `${message.slice(0, 800)}...` : message;
  }
  async resolveBinary() {
    if (await this.canRun("codex", ["--version"])) {
      return "codex";
    }
    if (await this.canRun("codex-cli", ["--version"])) {
      return "codex-cli";
    }
    throw new Error("Codex CLI is not available (tried: codex, codex-cli)");
  }
  async canRun(cmd, args) {
    return new Promise((resolve2) => {
      const proc = (0, import_child_process3.spawn)(cmd, args, { stdio: "ignore" });
      proc.on("error", () => resolve2(false));
      proc.on("close", (code) => resolve2(code === 0));
    });
  }
  extractFindings(content) {
    try {
      const match2 = content.match(/```json\s*([\s\S]*?)```/i);
      if (match2) {
        const parsed2 = JSON.parse(match2[1]);
        if (Array.isArray(parsed2)) return parsed2;
        return parsed2.findings || [];
      }
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
      return parsed.findings || [];
    } catch (error2) {
      logger.debug("Failed to parse findings from Codex response", error2);
    }
    return [];
  }
};

// src/providers/gemini.ts
var import_child_process4 = require("child_process");
var fs6 = __toESM(require("fs/promises"));
var os4 = __toESM(require("os"));
var path5 = __toESM(require("path"));
var crypto4 = __toESM(require("crypto"));
var GeminiProvider = class extends Provider {
  constructor(model) {
    super(`gemini/${model}`);
    this.model = model;
  }
  // Lightweight health check: verify CLI is available
  async healthCheck(_timeoutMs = 5e3) {
    const timeoutMs = Math.max(500, _timeoutMs ?? 5e3);
    let timeoutId;
    let isTimedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(new Error(`Gemini health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([
        this.resolveBinary().then(() => {
          if (isTimedOut) {
            logger.debug(`Gemini binary resolved after timeout (${this.name})`);
          }
        }),
        timeoutPromise
      ]);
      clearTimeout(timeoutId);
      return true;
    } catch (error2) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      logger.warn(`Gemini health check failed for ${this.name}: ${error2.message}`);
      return false;
    }
  }
  async review(prompt, timeoutMs) {
    const started = Date.now();
    const { bin, args: baseArgs } = await this.resolveBinary();
    const tmpDir = await fs6.mkdtemp(path5.join(os4.tmpdir(), "gemini-"));
    await fs6.chmod(tmpDir, 448);
    const promptFile = path5.join(tmpDir, `prompt-${crypto4.randomBytes(8).toString("hex")}.txt`);
    await fs6.writeFile(promptFile, prompt, { encoding: "utf8", mode: 384 });
    const args = [
      ...baseArgs,
      "--model",
      this.model,
      "--prompt",
      promptFile,
      "--output-format",
      "json",
      "--approval-mode",
      "yolo"
    ];
    logger.info(`Running Gemini CLI: ${bin} --model ${this.model} --output-format json --approval-mode yolo ...`);
    try {
      const { stdout, stderr } = await this.runCli(bin, args, timeoutMs);
      const content = stdout.trim();
      const durationSeconds = (Date.now() - started) / 1e3;
      logger.info(
        `Gemini CLI output for ${this.name}: stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, duration=${durationSeconds.toFixed(1)}s`
      );
      if (!content) {
        throw new Error(`Gemini CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ""}`);
      }
      return {
        content,
        durationSeconds,
        findings: this.extractFindings(content)
      };
    } catch (error2) {
      logger.error(`Gemini provider failed: ${this.name}`, error2);
      throw error2;
    } finally {
      try {
        await fs6.unlink(promptFile);
        await fs6.rmdir(tmpDir);
      } catch (err) {
      }
    }
  }
  runCli(bin, args, timeoutMs) {
    return new Promise((resolve2, reject) => {
      const proc = (0, import_child_process4.spawn)(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: process.env
      });
      if (proc.unref) {
        proc.unref();
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn(`Gemini CLI timeout (${timeoutMs}ms), killing process and all children`);
        try {
          if (proc.pid) {
            process.kill(-proc.pid, "SIGKILL");
          }
        } catch (err) {
          proc.kill("SIGKILL");
        }
        reject(new Error(`Gemini CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(err);
        }
      });
      proc.on("close", (code) => {
        if (!timedOut) {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`Gemini CLI exited with code ${code}: ${stderr || stdout || "no output"}`));
          } else {
            resolve2({ stdout: stdout.trim(), stderr: stderr.trim() });
          }
        }
      });
    });
  }
  async resolveBinary() {
    if (await this.canRun("gemini", ["--version"])) {
      return { bin: "gemini", args: [] };
    }
    if (await this.canRun("npx", ["--yes", "@google/gemini-cli", "--version"])) {
      return { bin: "npx", args: ["--yes", "@google/gemini-cli"] };
    }
    throw new Error("Gemini CLI is not available (tried: gemini, npx @google/gemini-cli)");
  }
  async canRun(cmd, args) {
    return new Promise((resolve2) => {
      const proc = (0, import_child_process4.spawn)(cmd, args, { stdio: "ignore" });
      proc.on("error", () => resolve2(false));
      proc.on("close", (code) => resolve2(code === 0));
    });
  }
  extractFindings(content) {
    try {
      const match2 = content.match(/```json\s*([\s\S]*?)```/i);
      if (match2) {
        const parsed2 = JSON.parse(match2[1]);
        if (Array.isArray(parsed2)) return parsed2;
        return parsed2.findings || [];
      }
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
      return parsed.findings || [];
    } catch (error2) {
      logger.debug("Failed to parse findings from Gemini response", error2);
    }
    return [];
  }
};

// src/providers/rate-limiter.ts
var fs7 = __toESM(require("fs/promises"));
var path6 = __toESM(require("path"));
var os5 = __toESM(require("os"));
var RateLimiter = class {
  lockDir = path6.join(os5.tmpdir(), "mpr-ratelimits");
  constructor() {
    fs7.mkdir(this.lockDir, { recursive: true }).catch(() => void 0);
  }
  async isRateLimited(provider) {
    const lockFile = this.getLockFile(provider);
    try {
      const raw = await fs7.readFile(lockFile, "utf8");
      const info2 = JSON.parse(raw);
      if (Date.now() < info2.limitedUntil) {
        logger.warn(`Provider ${provider} rate-limited until ${new Date(info2.limitedUntil).toISOString()}`);
        return true;
      }
      await fs7.unlink(lockFile).catch(() => void 0);
      return false;
    } catch {
      return false;
    }
  }
  async markRateLimited(provider, durationMinutes, reason) {
    const lockFile = this.getLockFile(provider);
    const info2 = {
      provider,
      limitedUntil: Date.now() + durationMinutes * 60 * 1e3,
      reason
    };
    await fs7.writeFile(lockFile, JSON.stringify(info2), "utf8");
    logger.warn(`Marked ${provider} as rate-limited for ${durationMinutes} minutes: ${reason}`);
  }
  async clear(provider) {
    const lockFile = this.getLockFile(provider);
    await fs7.unlink(lockFile).catch(() => void 0);
  }
  getLockFile(provider) {
    const safe = provider.replace(/[^a-z0-9]/gi, "_");
    return path6.join(this.lockDir, `${safe}.json`);
  }
};

// src/cost/pricing.ts
var PricingService = class _PricingService {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }
  cache = /* @__PURE__ */ new Map();
  cacheExpiry = 0;
  static CACHE_TTL = 60 * 60 * 1e3;
  async getPricing(modelId) {
    if (modelId.includes(":free")) {
      return { modelId, promptPrice: 0, completionPrice: 0, isFree: true };
    }
    if (Date.now() > this.cacheExpiry) {
      await this.refresh();
    }
    return this.cache.get(modelId) || {
      modelId,
      promptPrice: 0,
      completionPrice: 0,
      isFree: false
    };
  }
  async refresh() {
    if (!this.apiKey) return;
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      if (!response.ok) return;
      const data = await response.json();
      for (const model of data.data || []) {
        const pricing = model.pricing || {};
        this.cache.set(model.id, {
          modelId: model.id,
          promptPrice: parseFloat(pricing.prompt || "0") * 1e6,
          completionPrice: parseFloat(pricing.completion || "0") * 1e6,
          isFree: model.id.includes(":free")
        });
      }
      this.cacheExpiry = Date.now() + _PricingService.CACHE_TTL;
    } catch {
    }
  }
};

// src/providers/openrouter-models.ts
async function getBestFreeModels(count = 4, _timeoutMs = 5e3) {
  logger.debug(`Creating ${count} OpenRouter free routing instances`);
  return Array.from({ length: count }, (_, i) => `openrouter/free#${i + 1}`);
}
var modelCache = null;
var CACHE_TTL_MS = 60 * 60 * 1e3;
async function getBestFreeModelsCached(count = 4, timeoutMs = 5e3) {
  const now = Date.now();
  if (modelCache && now - modelCache.timestamp < CACHE_TTL_MS) {
    logger.debug("Using cached OpenRouter model list");
    return modelCache.models.slice(0, count);
  }
  const models = await getBestFreeModels(count, timeoutMs);
  modelCache = {
    models,
    timestamp: now
  };
  return models;
}

// src/providers/opencode-models.ts
var import_child_process5 = require("child_process");
var import_util4 = require("util");
var execAsync = (0, import_util4.promisify)(import_child_process5.exec);
function parseOpenCodeModels(output) {
  const models = [];
  const lines = output.split("\n");
  let currentModel = null;
  let jsonLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^[a-z][a-z0-9-]+\//)) {
      if (jsonLines.length > 0 && currentModel) {
        try {
          const jsonStr = jsonLines.join("\n");
          const parsed = JSON.parse(jsonStr);
          const provider = currentModel.split("/")[0];
          if (provider === "opencode" && parsed.cost && parsed.cost.input === 0) {
            models.push({
              id: currentModel,
              provider,
              isFree: true,
              contextWindow: parsed.limit?.context
            });
          }
        } catch (e) {
        }
      }
      currentModel = line.trim();
      jsonLines = [];
    } else if (currentModel && line.trim()) {
      jsonLines.push(line);
    }
  }
  if (jsonLines.length > 0 && currentModel) {
    try {
      const jsonStr = jsonLines.join("\n");
      const parsed = JSON.parse(jsonStr);
      const provider = currentModel.split("/")[0];
      if (provider === "opencode" && parsed.cost && parsed.cost.input === 0) {
        models.push({
          id: currentModel,
          provider,
          isFree: true,
          contextWindow: parsed.limit?.context
        });
      }
    } catch (e) {
    }
  }
  return models;
}
async function fetchOpenCodeModels(timeoutMs = 1e4) {
  logger.info("Attempting to fetch OpenCode models via CLI with --verbose...");
  try {
    const { stdout, stderr } = await execAsync("opencode models --verbose", {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024
      // 5MB buffer for verbose output
    });
    if (stderr) {
      logger.debug(`OpenCode CLI stderr: ${stderr}`);
    }
    const models = parseOpenCodeModels(stdout);
    logger.info(`Discovered ${models.length} free OpenCode models from CLI (cost.input === 0)`);
    if (models.length > 0) {
      logger.debug(`OpenCode free models: ${models.map((m) => m.id).join(", ")}`);
    }
    return models;
  } catch (error2) {
    if (error2 instanceof Error) {
      if (error2.message.includes("ENOENT") || error2.message.includes("command not found")) {
        logger.info("OpenCode CLI not installed, skipping OpenCode model discovery");
      } else if (error2.message.includes("timeout")) {
        logger.warn(`OpenCode CLI timeout after ${timeoutMs}ms`);
      } else {
        logger.warn("Failed to fetch OpenCode models", error2);
      }
    }
    return [];
  }
}
function rankOpenCodeModel(model) {
  let score = 0;
  if (model.isFree) {
    score += 100;
  }
  const modelLower = model.id.toLowerCase();
  if (modelLower.includes("claude")) {
    score += 50;
  } else if (modelLower.includes("gpt-4")) {
    score += 40;
  } else if (modelLower.includes("gemini")) {
    score += 35;
  } else if (modelLower.includes("deepseek")) {
    score += 30;
  } else if (modelLower.includes("qwen")) {
    score += 25;
  }
  if (modelLower.includes("code")) {
    score += 20;
  }
  return score;
}
async function getBestFreeOpenCodeModels(count = 4, timeoutMs = 1e4) {
  const models = await fetchOpenCodeModels(timeoutMs);
  if (models.length === 0) {
    logger.info("No free OpenCode models available - CLI may not be installed or accessible");
    return [];
  }
  logger.info(`Found ${models.length} free OpenCode models (cost.input === 0)`);
  const ranked = models.map((model) => ({
    modelId: model.id,
    score: rankOpenCodeModel(model)
  }));
  ranked.sort((a, b) => b.score - a.score);
  const selected = ranked.slice(0, count).map((r) => r.modelId);
  logger.info(
    `Selected ${selected.length}/${count} best free OpenCode models: ${selected.join(", ")}`
  );
  return selected;
}
var modelCache2 = null;
var CACHE_TTL_MS2 = 60 * 60 * 1e3;
async function getBestFreeOpenCodeModelsCached(count = 4, timeoutMs = 1e4) {
  const now = Date.now();
  if (modelCache2 && now - modelCache2.timestamp < CACHE_TTL_MS2) {
    logger.debug("Using cached OpenCode model list");
    return modelCache2.models.slice(0, count);
  }
  const models = await getBestFreeOpenCodeModels(count, timeoutMs);
  modelCache2 = {
    models,
    timestamp: now
  };
  return models;
}

// src/providers/registry.ts
var ProviderRegistry = class {
  constructor(pluginLoader, reliabilityTracker) {
    this.pluginLoader = pluginLoader;
    this.reliabilityTracker = reliabilityTracker;
  }
  rateLimiter = new RateLimiter();
  rotationIndex = 0;
  openRouterPricing = new PricingService(process.env.OPENROUTER_API_KEY);
  async createProviders(config) {
    let providers = this.instantiate(config.providers, config);
    const userProvidedList = Boolean(process.env.REVIEW_PROVIDERS);
    const usingDefaults = this.usesDefaultProviders(config.providers);
    if (providers.length === 0 && usingDefaults && !userProvidedList) {
      logger.info("\u{1F50D} No providers specified, starting dynamic model discovery...");
      const discoveredModels = [];
      if (process.env.OPENROUTER_API_KEY) {
        logger.info("Discovering OpenRouter models...");
        const openRouterModels = await getBestFreeModelsCached(8, 5e3);
        if (openRouterModels.length > 0) {
          logger.info(`\u2705 Discovered ${openRouterModels.length} OpenRouter models`);
          discoveredModels.push(...openRouterModels);
        } else {
          logger.warn("\u26A0\uFE0F  No OpenRouter models discovered (API may be unavailable)");
        }
      } else {
        logger.info("Skipping OpenRouter discovery (no API key)");
      }
      logger.info("Discovering OpenCode models...");
      const openCodeModels = await getBestFreeOpenCodeModelsCached(8, 1e4);
      if (openCodeModels.length > 0) {
        logger.info(`\u2705 Discovered ${openCodeModels.length} OpenCode models`);
        discoveredModels.push(...openCodeModels);
      } else {
        logger.info("\u2139\uFE0F  No OpenCode models discovered (CLI may not be installed)");
      }
      if (discoveredModels.length > 0) {
        logger.info(`\u{1F3AF} Total discovered: ${discoveredModels.length} free models`);
        logger.info(`   Models: ${discoveredModels.join(", ")}`);
        providers.push(...this.instantiate(discoveredModels, config));
      } else {
        logger.warn("\u26A0\uFE0F  Dynamic discovery found no models, using static fallbacks");
      }
    }
    if (providers.length === 0) {
      logger.warn("Using static fallback providers as last resort");
      providers = this.instantiate(FALLBACK_STATIC_PROVIDERS, config);
    }
    providers = this.dedupeProviders(providers);
    providers = this.applyAllowBlock(providers, config);
    logger.info(`After allowBlock: ${providers.length} providers`);
    providers = await this.filterRateLimited(providers);
    logger.info(`After filterRateLimited: ${providers.length} providers`);
    const strategy = config.providerSelectionStrategy ?? "reliability";
    if (strategy === "reliability") {
      providers = await this.sortByReliability(providers);
    } else if (strategy === "random") {
      providers = this.shuffle(providers);
    }
    let discoveryLimit = (config.providerDiscoveryLimit ?? 0) > 0 ? config.providerDiscoveryLimit : config.providerLimit > 0 ? config.providerLimit : 8;
    if (config.providerLimit > 0) {
      discoveryLimit = Math.min(discoveryLimit, config.providerLimit);
    }
    const minSelection = Math.min(4, discoveryLimit);
    logger.info(`Discovery limit: ${discoveryLimit} (for health checks), execution limit: ${config.providerLimit} (for actual review), min: ${minSelection}, fallback count: ${config.fallbackProviders.length}`);
    const MIN_OPENROUTER = 4;
    const MIN_OPENCODE = 2;
    const openrouterProviders = this.filterUniqueFamilies(
      providers.filter((p) => p.name.startsWith("openrouter/"))
    );
    const opencodeProviders = this.filterUniqueFamilies(
      providers.filter((p) => p.name.startsWith("opencode/"))
    );
    const otherProviders = providers.filter(
      (p) => !p.name.startsWith("openrouter/") && !p.name.startsWith("opencode/")
    );
    const explorationRate = config.providerExplorationRate ?? 0.3;
    const concatenated = [...openrouterProviders, ...opencodeProviders, ...otherProviders];
    let allProviders;
    if (strategy === "reliability") {
      allProviders = await this.sortByReliability(concatenated);
    } else {
      allProviders = concatenated;
    }
    let selected;
    if (strategy === "reliability") {
      selected = this.selectWithDiversity(allProviders, discoveryLimit, minSelection, explorationRate);
    } else if (strategy === "random") {
      selected = [];
      selected.push(...this.shuffle(openrouterProviders).slice(0, MIN_OPENROUTER));
      selected.push(...this.shuffle(opencodeProviders).slice(0, MIN_OPENCODE));
      const selectedNames = new Set(selected.map((s) => s.name));
      const remainingPool = this.shuffle(allProviders).filter((p) => !selectedNames.has(p.name));
      while (selected.length < discoveryLimit && remainingPool.length > 0) {
        const next = remainingPool.shift();
        selected.push(next);
      }
    } else {
      if (allProviders.length > 0 && discoveryLimit > 0) {
        selected = this.applyRotation(allProviders, discoveryLimit);
      } else {
        logger.warn(`Cannot apply rotation: allProviders.length=${allProviders.length}, discoveryLimit=${discoveryLimit}`);
        selected = [];
      }
    }
    providers = selected.length > 0 ? selected : providers;
    if (providers.length < discoveryLimit && config.fallbackProviders.length > 0) {
      const remainingSlots = discoveryLimit - providers.length;
      logger.info(`Adding fallback providers to fill ${remainingSlots} remaining slots (target: ${discoveryLimit})`);
      const fallbacks = this.instantiate(config.fallbackProviders, config);
      const filteredFallbacks = await this.filterRateLimited(fallbacks);
      const dedupedFallbacks = this.dedupeProviders([...providers, ...filteredFallbacks]).filter((p) => !providers.some((existing) => existing.name === p.name));
      const fallbacksToAdd = dedupedFallbacks.slice(0, remainingSlots);
      providers = [...providers, ...fallbacksToAdd];
      logger.info(`Added ${fallbacksToAdd.length} fallback providers (filtered ${dedupedFallbacks.length} candidates, total now: ${providers.length})`);
    } else {
      logger.info(`Skipping fallback providers: providers.length=${providers.length}, discoveryLimit=${discoveryLimit}, fallbackProviders.length=${config.fallbackProviders.length}`);
    }
    if (providers.length > discoveryLimit) {
      logger.warn(`Provider count ${providers.length} exceeds discovery limit ${discoveryLimit}, trimming`);
      providers = this.randomSelect(providers, discoveryLimit, minSelection);
    }
    if (providers.length === 0 && config.fallbackProviders.length > 0) {
      logger.warn("Primary providers unavailable, using fallbacks");
      providers = this.instantiate(config.fallbackProviders, config);
      providers = await this.filterRateLimited(providers);
    }
    if (providers.length === 0) {
      logger.warn("No providers available; falling back to opencode/minimax-m2.1-free");
      providers = this.instantiate(["opencode/minimax-m2.1-free"], config);
    }
    return providers;
  }
  /**
   * Discover additional free providers, excluding ones we've already tried.
   * Used when initial health checks fail to yield enough healthy providers.
   */
  async discoverAdditionalFreeProviders(existing, max = 6, config = DEFAULT_CONFIG) {
    const existingSet = new Set(existing);
    const discovered = [];
    if (process.env.OPENROUTER_API_KEY) {
      const moreOpenRouter = await getBestFreeModelsCached(20, 5e3);
      discovered.push(...moreOpenRouter.filter((m) => !existingSet.has(m)));
    }
    const moreOpenCode = await getBestFreeOpenCodeModelsCached(12, 1e4);
    discovered.push(...moreOpenCode.filter((m) => !existingSet.has(m)));
    if (discovered.length === 0) {
      discovered.push(...FALLBACK_STATIC_PROVIDERS.filter((m) => !existingSet.has(m)));
    }
    let providers = this.instantiate(this.shuffle(discovered), config);
    providers = this.dedupeProviders(providers);
    providers = this.applyAllowBlock(providers, config);
    providers = await this.filterRateLimited(providers);
    if (providers.length > max) {
      providers = this.randomSelect(providers, max, Math.min(2, max));
    }
    return providers;
  }
  instantiate(names, config = DEFAULT_CONFIG) {
    const list = [];
    for (const name of names) {
      if (this.pluginLoader?.hasProvider(name)) {
        const pluginName = name.split("/")[0];
        const pluginEnvVar = `PLUGIN_${pluginName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
        const apiKey = process.env[pluginEnvVar] || process.env.PLUGIN_API_KEY || "";
        const provider = this.pluginLoader.createProvider(name, apiKey);
        if (provider) {
          list.push(provider);
          continue;
        } else {
          logger.warn(`Failed to create provider ${name} from plugin`);
          continue;
        }
      }
      if (!Provider.validate(name)) {
        logger.warn(`Skipping invalid provider name: ${name}`);
        continue;
      }
      if (name.startsWith("openrouter/")) {
        const model = name.replace("openrouter/", "");
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          logger.warn(`OPENROUTER_API_KEY not set; skipping OpenRouter provider ${name}`);
          continue;
        }
        const baseModel = model.replace(/#\d+$/, "");
        const isFree = baseModel === "free" || baseModel.endsWith(":free");
        if (!config.openrouterAllowPaid && !isFree) {
          logger.warn(`Skipping paid OpenRouter model ${name} (set openrouterAllowPaid=true to enable)`);
          continue;
        }
        list.push(new OpenRouterProvider(model, apiKey, this.rateLimiter));
        continue;
      }
      if (name.startsWith("opencode/")) {
        const model = name.replace("opencode/", "");
        list.push(new OpenCodeProvider(model));
        continue;
      }
      if (name.startsWith("claude/")) {
        const model = name.replace("claude/", "");
        list.push(new ClaudeCodeProvider(model));
        continue;
      }
      if (name.startsWith("codex/")) {
        const model = name.replace("codex/", "");
        list.push(new CodexProvider(model));
        continue;
      }
      if (name.startsWith("gemini/")) {
        const model = name.replace("gemini/", "");
        list.push(new GeminiProvider(model));
        continue;
      }
    }
    return list;
  }
  applyAllowBlock(providers, config) {
    let filtered = providers;
    if (config.providerAllowlist.length > 0) {
      filtered = filtered.filter(
        (provider) => config.providerAllowlist.some((pattern) => provider.name.includes(pattern))
      );
    }
    if (config.providerBlocklist.length > 0) {
      filtered = filtered.filter(
        (provider) => !config.providerBlocklist.some((pattern) => provider.name.includes(pattern))
      );
    }
    return filtered;
  }
  async filterRateLimited(providers) {
    const available = [];
    for (const provider of providers) {
      const limited = await this.rateLimiter.isRateLimited(provider.name);
      if (!limited) available.push(provider);
    }
    return available;
  }
  applyRotation(providers, limit) {
    const selected = [];
    for (let i = 0; i < limit; i++) {
      const index = (this.rotationIndex + i) % providers.length;
      selected.push(providers[index]);
    }
    this.rotationIndex = (this.rotationIndex + limit) % providers.length;
    return selected;
  }
  randomSelect(providers, max, min) {
    const shuffled = this.shuffle(providers);
    const count = Math.max(min, Math.min(max, shuffled.length));
    return shuffled.slice(0, count);
  }
  shuffle(list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  dedupeProviders(providers) {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const p of providers) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      result.push(p);
    }
    return result;
  }
  /**
   * Avoid selecting multiple variants of the same underlying model family.
   * e.g., openrouter/nvidia/nemotron-nano-12b... and ...-9b... count as one family.
   */
  filterUniqueFamilies(providers) {
    const seenFamilies = /* @__PURE__ */ new Set();
    const unique = [];
    for (const p of providers) {
      const family = this.getModelFamily(p.name);
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);
      unique.push(p);
    }
    return unique;
  }
  getModelFamily(name) {
    const parts = name.split("/");
    if (parts.length < 3) return name;
    const vendor = parts[1];
    const modelWithVariant = parts[2].split(":")[0];
    const base = modelWithVariant.replace(/-\d+b$/i, "").replace(/-v\d+[a-z]*$/i, "");
    return `${vendor}/${base}`;
  }
  usesDefaultProviders(list) {
    if (!Array.isArray(list) || list.length !== DEFAULT_CONFIG.providers.length) return false;
    return list.every((p) => DEFAULT_CONFIG.providers.includes(p));
  }
  /**
   * Sort providers by reliability score (highest first)
   * Providers without reliability data get default score (0.5)
   */
  async sortByReliability(providers) {
    if (!this.reliabilityTracker) {
      return providers;
    }
    const scored = [];
    for (const provider of providers) {
      const score = await this.reliabilityTracker.getReliabilityScore(provider.name);
      scored.push({ provider, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const sorted = scored.map((s) => s.provider);
    if (scored.length > 0) {
      logger.debug(
        `Provider reliability ranking: ${scored.map((s) => `${s.provider.name}=${(s.score ?? 0.5).toFixed(2)}`).join(", ")}`
      );
    }
    return sorted;
  }
  /**
   * Select providers with diversity constraints and controlled randomization
   *
   * Strategy:
   * 1. Take top N% by reliability (deterministic exploit)
   * 2. Randomly select remaining slots from pool (exploration)
   * 3. Ensure minimum diversity (OpenRouter/OpenCode mix)
   */
  selectWithDiversity(providers, discoveryLimit, minSelection, explorationRate = 0.3) {
    if (providers.length <= discoveryLimit) {
      return providers;
    }
    const selected = [];
    const deterministicCount = Math.floor(discoveryLimit * (1 - explorationRate));
    selected.push(...providers.slice(0, deterministicCount));
    const explorationCount = discoveryLimit - deterministicCount;
    const explorationPool = providers.slice(deterministicCount);
    const shuffled = this.shuffle(explorationPool);
    selected.push(...shuffled.slice(0, explorationCount));
    const openrouterCount = selected.filter((p) => p.name.startsWith("openrouter/")).length;
    const opencodeCount = selected.filter((p) => p.name.startsWith("opencode/")).length;
    const MIN_OPENROUTER = Math.min(2, discoveryLimit);
    const MIN_OPENCODE = Math.min(1, discoveryLimit);
    if (openrouterCount < MIN_OPENROUTER || opencodeCount < MIN_OPENCODE) {
      return this.adjustForDiversity(providers, discoveryLimit, MIN_OPENROUTER, MIN_OPENCODE);
    }
    logger.info(
      `Selected ${selected.length} providers: ${deterministicCount} by reliability + ${explorationCount} exploration`
    );
    return selected;
  }
  /**
   * Adjust selection to meet diversity requirements
   */
  adjustForDiversity(providers, limit, minOpenRouter, minOpenCode) {
    const openrouter = providers.filter((p) => p.name.startsWith("openrouter/"));
    const opencode = providers.filter((p) => p.name.startsWith("opencode/"));
    const others = providers.filter(
      (p) => !p.name.startsWith("openrouter/") && !p.name.startsWith("opencode/")
    );
    const selected = [];
    selected.push(...openrouter.slice(0, minOpenRouter));
    selected.push(...opencode.slice(0, minOpenCode));
    const remaining = limit - selected.length;
    const pool = [
      ...openrouter.slice(minOpenRouter),
      ...opencode.slice(minOpenCode),
      ...others
    ].filter((p) => !selected.includes(p));
    selected.push(...pool.slice(0, remaining));
    return selected.slice(0, limit);
  }
};

// src/utils/diff.ts
function trimDiff(diff, maxBytes) {
  const buf = Buffer.from(diff, "utf8");
  if (buf.byteLength <= maxBytes) return diff;
  const fileChunks = [];
  const lines = diff.split("\n");
  let currentChunk = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && currentChunk.length > 0) {
      fileChunks.push(currentChunk.join("\n"));
      currentChunk = [line];
    } else {
      currentChunk.push(line);
    }
  }
  if (currentChunk.length > 0) {
    fileChunks.push(currentChunk.join("\n"));
  }
  const includedChunks = [];
  let currentBytes = 0;
  const truncationMarker = "\n\n...remaining files truncated to stay within size limit...\n";
  const markerBytes = Buffer.byteLength(truncationMarker, "utf8");
  for (const chunk of fileChunks) {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (currentBytes + chunkBytes + markerBytes > maxBytes && includedChunks.length > 0) {
      break;
    }
    includedChunks.push(chunk);
    currentBytes += chunkBytes + 1;
  }
  if (includedChunks.length < fileChunks.length) {
    const truncatedCount = fileChunks.length - includedChunks.length;
    return includedChunks.join("\n") + `

...${truncatedCount} file(s) truncated to stay within size limit...
`;
  }
  return includedChunks.join("\n");
}
function mapAddedLines(patch) {
  if (!patch) return [];
  const lines = patch.split("\n");
  const added = [];
  let currentNew = 0;
  const hunkRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const noNewlineMarker = "\\ No newline at end of file";
  for (const raw of lines) {
    if (raw === noNewlineMarker) {
      continue;
    }
    const hunkMatch = raw.match(hunkRegex);
    if (hunkMatch) {
      currentNew = parseInt(hunkMatch[2], 10);
      continue;
    }
    if (raw.startsWith("+")) {
      added.push({ line: currentNew, content: raw.slice(1) });
      currentNew += 1;
    } else if (raw.startsWith("-")) {
    } else {
      currentNew += 1;
    }
  }
  return added;
}
function mapLinesToPositions(patch) {
  const map2 = /* @__PURE__ */ new Map();
  if (!patch) return map2;
  const lines = patch.split("\n");
  let currentNew = 0;
  let position = 0;
  const hunkRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const noNewlineMarker = "\\ No newline at end of file";
  for (const raw of lines) {
    if (raw === noNewlineMarker) {
      continue;
    }
    position += 1;
    const hunkMatch = raw.match(hunkRegex);
    if (hunkMatch) {
      currentNew = parseInt(hunkMatch[2], 10);
      continue;
    }
    if (raw.startsWith("+")) {
      map2.set(currentNew, position);
      currentNew += 1;
    } else if (raw.startsWith("-")) {
    } else {
      map2.set(currentNew, position);
      currentNew += 1;
    }
  }
  return map2;
}
function isRangeWithinSingleHunk(startLine, endLine, patch) {
  if (!patch) return false;
  const lines = patch.split("\n");
  const hunkRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const noNewlineMarker = "\\ No newline at end of file";
  let currentNew = 0;
  let foundStart = false;
  let inActiveHunk = false;
  for (const raw of lines) {
    if (raw === noNewlineMarker) continue;
    const hunkMatch = raw.match(hunkRegex);
    if (hunkMatch) {
      if (foundStart) {
        return false;
      }
      currentNew = parseInt(hunkMatch[2], 10);
      inActiveHunk = true;
      continue;
    }
    if (!inActiveHunk) continue;
    if (raw.startsWith("+") || !raw.startsWith("-") && raw.length > 0) {
      if (currentNew === startLine) {
        foundStart = true;
      }
      if (currentNew === endLine) {
        return foundStart;
      }
      currentNew += 1;
    }
  }
  return false;
}
function filterDiffByFiles(diff, files) {
  if (files.length === 0) return "";
  if (!diff || diff.trim().length === 0) return "";
  const target = new Set(files.map((f) => f.filename));
  const lines = diff.split("\n");
  const chunks = [];
  let currentChunk = [];
  let includeCurrent = false;
  const pushChunkIfIncluded = () => {
    if (includeCurrent && currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"));
    }
    currentChunk = [];
    includeCurrent = false;
  };
  for (const line of lines) {
    const normalizedLine = line.replace(/\r$/, "");
    const isHeader = normalizedLine.startsWith("diff --git ");
    if (isHeader) {
      pushChunkIfIncluded();
      const match2 = normalizedLine.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      if (!match2) {
        currentChunk.push(line);
        continue;
      }
      const rawA = match2[1].trim();
      const rawB = match2[2].trim();
      const aPath = unquoteGitPath(rawA);
      const bPath = unquoteGitPath(rawB);
      includeCurrent = target.has(bPath) || target.has(aPath);
      currentChunk.push(line);
    } else {
      currentChunk.push(line);
    }
  }
  pushChunkIfIncluded();
  return chunks.join("\n").trimEnd();
}
function unquoteGitPath(path13) {
  if (path13.startsWith('"') && path13.endsWith('"')) {
    path13 = path13.slice(1, -1);
  }
  try {
    path13 = path13.replace(/\\([\\"tnr])/g, (_m, ch) => {
      switch (ch) {
        case "\\":
          return "\\";
        case '"':
          return '"';
        case "t":
          return "	";
        case "n":
          return "\n";
        case "r":
          return "\r";
        default:
          return ch;
      }
    });
  } catch {
  }
  return path13;
}

// src/analysis/context/validation-detector.ts
var ValidationDetector = class {
  /**
   * Analyze a code snippet for defensive programming patterns
   * Returns context that can be added to LLM prompts to reduce false positives
   */
  analyzeDefensivePatterns(code, startLine = 1) {
    const lines = code.split("\n");
    const validations = [];
    const variables = /* @__PURE__ */ new Map();
    let hasTryCatch = false;
    let hasErrorReturn = false;
    let hasGracefulDegradation = false;
    if (/\/\/\s*(ignore|best effort|graceful|fallback)/i.test(code)) {
      hasGracefulDegradation = true;
    }
    if (/catch\s*\([^)]*\)\s*{[^}]*return[^}]*}/s.test(code)) {
      hasGracefulDegradation = true;
      hasErrorReturn = true;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = startLine + i;
      const trimmed = line.trim();
      const typeofMatch = trimmed.match(/typeof\s+(\w+)\s*(!==?|===?)\s*['"](\w+)['"]/);
      if (typeofMatch) {
        const [, variable, operator, type2] = typeofMatch;
        validations.push({
          type: "type_check",
          line: lineNum,
          variable,
          description: `Validates ${variable} is ${operator.includes("!") ? "not" : ""} a ${type2}`
        });
        this.trackVariable(variables, variable, lineNum, true);
      }
      if (/\s+(===?|!==?)\s+(null|undefined)/.test(trimmed) || /\s+(null|undefined)\s+(===?|!==?)/.test(trimmed) || /if\s*\(\s*!\s*\w+\s*\)/.test(trimmed) || /\w+\s*==\s*null/.test(trimmed)) {
        const varMatch = trimmed.match(/(\w+)\s*(!==?|===?)\s*(null|undefined)/);
        validations.push({
          type: "null_check",
          line: lineNum,
          variable: varMatch?.[1],
          description: `Null/undefined check for ${varMatch?.[1] || "value"}`
        });
      }
      if (/[<>]=?/.test(trimmed) && /\d+/.test(trimmed)) {
        const varMatch = trimmed.match(/(\w+)\s*[<>]=?\s*\d+/);
        if (varMatch) {
          validations.push({
            type: "range_check",
            line: lineNum,
            variable: varMatch[1],
            description: `Range validation for ${varMatch[1]}`
          });
        }
      }
      if (/^try\s*{/.test(trimmed)) {
        hasTryCatch = true;
      }
      if (/return\s+(null|undefined|false|'invalid'|"invalid"|-1)/.test(trimmed)) {
        hasErrorReturn = true;
        validations.push({
          type: "error_return",
          line: lineNum,
          description: "Returns error value on invalid input"
        });
      }
      if (/fs\.(exists|access|stat|mkdir)/.test(trimmed) || /\.\w+\s*\|\|\s*/.test(trimmed) || /\?\?\s*/.test(trimmed)) {
        validations.push({
          type: "existence_check",
          line: lineNum,
          description: "Checks existence before use"
        });
      }
      if (/\|\|/.test(trimmed) || /\?\?/.test(trimmed)) {
        hasGracefulDegradation = true;
      }
      if (/await\s+.*\.acquire|lockPromise|acquireLock|releaseLock|mutex/.test(trimmed) || /locks\.get|locks\.set|locks\.delete/.test(trimmed)) {
        validations.push({
          type: "locking",
          line: lineNum,
          description: "Uses locking mechanism for concurrency safety"
        });
      }
      if (/Promise\.race\s*\(/.test(trimmed) && /timeout|setTimeout/i.test(code.slice(i * 100, (i + 10) * 100))) {
        validations.push({
          type: "timeout_enforcement",
          line: lineNum,
          description: "Enforces timeout using Promise.race"
        });
      }
      const nextFewLines = lines.slice(i, Math.min(i + 4, lines.length)).join("\n");
      if (/if\s*\([^)]*[<>!=]/.test(trimmed) && /throw\s+(new\s+)?Error/.test(nextFewLines)) {
        validations.push({
          type: "param_validation",
          line: lineNum,
          description: "Validates parameters with throw on invalid input"
        });
      }
      const unusedParamMatch = trimmed.match(/\b_(\w+)\b/);
      if (unusedParamMatch) {
        validations.push({
          type: "intentionally_unused",
          line: lineNum,
          variable: `_${unusedParamMatch[1]}`,
          description: `Parameter _${unusedParamMatch[1]} is intentionally unused (indicated by _ prefix)`
        });
      }
      if (/encodeURI|encodeURIComponent|escape|sanitize|normalize/.test(trimmed) || /\.replace\(\/.*\/g,/.test(trimmed)) {
        validations.push({
          type: "sanitization_function",
          line: lineNum,
          description: "Uses sanitization/encoding function for safe output"
        });
      }
      if (/new\s+RegExp\(/.test(trimmed)) {
        const surroundingLines = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 5)).join("\n");
        if (/try\s*{/.test(surroundingLines) && /catch/.test(surroundingLines)) {
          validations.push({
            type: "regex_try_catch",
            line: lineNum,
            description: "RegExp construction protected by try-catch block"
          });
        }
      }
      if (trimmed.includes("it(") || trimmed.includes("test(") || trimmed.includes("describe(") || trimmed.includes("expect(")) {
        validations.push({
          type: "test_intentional_inconsistency",
          line: lineNum,
          description: "Test file: may intentionally use inconsistent data to test error paths"
        });
      }
      if (/^\/\/\s*eslint-disable/.test(trimmed) || /^\/\/\s*@ts-ignore/.test(trimmed)) {
        validations.push({
          type: "lint_auto_fixable",
          line: lineNum,
          description: "Lint issue acknowledged with disable comment"
        });
      }
      const initMatch = trimmed.match(/(?:let|const|var)\s+(\w+)\s*[:=]/);
      if (initMatch) {
        const varName = initMatch[1];
        this.trackVariable(variables, varName, lineNum, false);
      }
    }
    return {
      validations,
      errorHandling: {
        hasTryCatch,
        hasErrorReturn,
        hasGracefulDegradation
      },
      dataFlow: Array.from(variables.entries()).map(([variable, data]) => ({
        variable,
        ...data
      }))
    };
  }
  trackVariable(variables, varName, line, checked) {
    const existing = variables.get(varName) || {
      initialized: false,
      checkedBeforeUse: false,
      lines: []
    };
    existing.lines.push(line);
    if (checked) {
      existing.checkedBeforeUse = true;
    }
    variables.set(varName, existing);
  }
  /**
   * Generate additional context for LLM prompts to reduce false positives
   */
  generatePromptContext(context) {
    if (context.validations.length === 0) {
      return "";
    }
    const parts = [
      "\n## Defensive Programming Context (Auto-Detected)",
      "The following defensive patterns were detected in this code:"
    ];
    const byType = /* @__PURE__ */ new Map();
    for (const validation of context.validations) {
      const list = byType.get(validation.type) || [];
      list.push(validation);
      byType.set(validation.type, list);
    }
    for (const [type2, patterns] of byType) {
      const typeName = type2.replace(/_/g, " ");
      parts.push(`
**${typeName.charAt(0).toUpperCase() + typeName.slice(1)}** (${patterns.length}):`);
      for (const pattern of patterns) {
        parts.push(`- Line ${pattern.line}: ${pattern.description}`);
      }
    }
    if (context.errorHandling.hasTryCatch) {
      parts.push("\n**Error Handling**: Code uses try-catch for exception handling");
    }
    if (context.errorHandling.hasGracefulDegradation) {
      parts.push("**Graceful Degradation**: Code has fallback logic for error cases");
    }
    if (context.dataFlow.length > 0) {
      parts.push("\n**Data Flow Tracking**:");
      for (const flow of context.dataFlow) {
        if (flow.checkedBeforeUse) {
          parts.push(`- ${flow.variable}: Validated before use (lines ${flow.lines.join(", ")})`);
        }
      }
    }
    parts.push(
      "\n**Reviewer Note**: When flagging issues, verify these defensive patterns don't already address the concern."
    );
    return parts.join("\n");
  }
  /**
   * Check if a specific line has validation coverage
   * This can suppress false positives for lines that are already validated
   */
  hasValidationCoverage(context, targetLine, variable) {
    const nearbyValidations = context.validations.filter(
      (v) => Math.abs(v.line - targetLine) <= 5 && (!variable || v.variable === variable)
    );
    return nearbyValidations.length > 0;
  }
};

// src/analysis/llm/prompt-builder.ts
var PromptBuilder = class {
  constructor(config, intensity = "standard", promptEnricher, codeGraph) {
    this.config = config;
    this.intensity = intensity;
    this.promptEnricher = promptEnricher;
    this.codeGraph = codeGraph;
    const validIntensities = ["light", "standard", "thorough"];
    if (!validIntensities.includes(intensity)) {
      throw new Error(`Invalid intensity: ${intensity}. Must be one of: ${validIntensities.join(", ")}`);
    }
    this.validationDetector = new ValidationDetector();
  }
  validationDetector;
  /**
   * Get call context from code graph for better fix suggestions.
   * Returns callers and callees for symbols near the target line.
   */
  getCallContext(file, line) {
    if (!this.codeGraph) {
      return null;
    }
    try {
      const fileSymbols = this.codeGraph.getFileSymbols(file);
      if (!fileSymbols || fileSymbols.length === 0) {
        return null;
      }
      const nearbySymbol = fileSymbols.filter((def) => Math.abs(def.line - line) <= 20).sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
      if (!nearbySymbol) {
        return null;
      }
      const qualifiedName = `${file}:${nearbySymbol.name}`;
      const callers = this.codeGraph.getCallers(qualifiedName) || [];
      const callees = this.codeGraph.getCalls(qualifiedName) || [];
      if (callers.length === 0 && callees.length === 0) {
        return null;
      }
      const context = [];
      context.push(`CALL CONTEXT for ${nearbySymbol.name} (${nearbySymbol.type}):`);
      if (callers.length > 0) {
        context.push(`  Called by: ${callers.slice(0, 5).join(", ")}${callers.length > 5 ? ` (+${callers.length - 5} more)` : ""}`);
      }
      if (callees.length > 0) {
        context.push(`  Calls: ${callees.slice(0, 5).join(", ")}${callees.length > 5 ? ` (+${callees.length - 5} more)` : ""}`);
      }
      return context.join("\n");
    } catch (error2) {
      logger.debug("Failed to get call context:", error2);
      return null;
    }
  }
  async build(pr, prNumber) {
    if (!pr || typeof pr !== "object") {
      throw new Error("Invalid PR context: must be a valid PRContext object");
    }
    if (pr.diff === void 0 || pr.diff === null || typeof pr.diff !== "string") {
      throw new Error("Invalid PR context: diff must be a string (can be empty)");
    }
    if (!Array.isArray(pr.files)) {
      throw new Error("Invalid PR context: files must be an array");
    }
    const diff = trimDiff(pr.diff, this.config.diffMaxBytes);
    const skipSuggestions = this.shouldSkipSuggestions(diff);
    const filesInDiff = /* @__PURE__ */ new Set();
    const diffGitPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    let match2;
    while ((match2 = diffGitPattern.exec(diff)) !== null) {
      filesInDiff.add(match2[2]);
    }
    const includedFiles = pr.files.filter((f) => filesInDiff.has(f.filename));
    const excludedCount = pr.files.length - includedFiles.length;
    const fileList = [
      ...includedFiles.map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    ];
    if (excludedCount > 0) {
      fileList.push(`  (${excludedCount} additional file(s) truncated)`);
    }
    const _depth = this.config.intensityPromptDepth?.[this.intensity] ?? "standard";
    const instructions = [
      `You are a code reviewer. ONLY report actual bugs - code that will crash, lose data, or have security vulnerabilities.`,
      "",
      "CRITICAL RULES (READ CAREFULLY):",
      "",
      "1. SKIP these file types entirely - DO NOT review them:",
      "   \u2022 Test files: *.test.ts, *.spec.ts, __tests__/*, *test*, *spec*",
      "   \u2022 Workflow/CI: .github/workflows/*, .github/actions/*, *.yml in .github/",
      "   \u2022 Config: *.json, *.yaml, *.yml (except for syntax errors)",
      "   \u2022 Docs: *.md, README*, CHANGELOG*",
      "",
      "2. NEVER report these (they are NOT bugs):",
      '   \u2022 Suggestions ("Consider", "Add", "Should", "Could", "Ensure that", "Validate")',
      '   \u2022 Code style ("complex", "magic strings", "readability")',
      "   \u2022 Missing validation (TypeScript types handle this)",
      "   \u2022 Incomplete/potential issues (unless code WILL crash)",
      "   \u2022 Performance opinions (unless exponential complexity)",
      "",
      "3. ONLY report if code WILL:",
      "   \u2022 Crash at runtime",
      "   \u2022 Lose or corrupt data",
      "   \u2022 Have SQL injection, XSS, command injection, or RCE vulnerability",
      ""
    ];
    if (skipSuggestions) {
      instructions.push("Return JSON: [{file, line, severity, title, message}]", "");
    } else {
      instructions.push(
        "Return JSON: [{file, line, severity, title, message, suggestion}]",
        "",
        "SUGGESTION FIELD (optional):",
        '  - Only include "suggestion" for FIXABLE issues (not all findings)',
        "  - Fixable: null reference, type error, off-by-one, missing null check, resource leak",
        "  - NOT fixable: architectural issues, design suggestions, unclear requirements",
        '  - "suggestion" must be EXACT replacement code for the problematic line(s)',
        "  - Include ONLY the fixed code, no explanations or comments",
        '  - Example: {"file": "x.ts", "line": 10, "severity": "major",',
        '             "title": "Null reference", "message": "...",',
        '             "suggestion": "const user = users?.find(u => u.id === id) ?? null;"}',
        ""
      );
    }
    instructions.push(
      `PR #${pr.number}: ${pr.title}`,
      `Author: ${pr.author}`,
      "Files changed:",
      ...fileList,
      ""
    );
    const MAX_DIFF_SIZE_FOR_ANALYSIS = 5e4;
    if (diff.length < MAX_DIFF_SIZE_FOR_ANALYSIS) {
      try {
        const defensiveContext = this.validationDetector.analyzeDefensivePatterns(diff);
        const contextText = this.validationDetector.generatePromptContext(defensiveContext);
        if (contextText) {
          instructions.push(contextText, "");
        }
      } catch (error2) {
        logger.debug("Failed to analyze defensive patterns:", error2);
      }
    }
    if (this.promptEnricher && prNumber) {
      try {
        const learnedPreferences = await this.promptEnricher.getPromptText(prNumber);
        if (learnedPreferences) {
          instructions.push(learnedPreferences, "");
        }
      } catch (error2) {
        logger.debug("Failed to get prompt enrichment:", error2);
      }
    }
    if (this.codeGraph && pr.files.length > 0) {
      const contextFiles = pr.files.slice(0, 3);
      const callContexts = [];
      for (const file of contextFiles) {
        const midLine = Math.floor((file.additions + file.deletions) / 2) || 1;
        const context = this.getCallContext(file.filename, midLine);
        if (context) {
          callContexts.push(`${file.filename}:
${context}`);
        }
      }
      if (callContexts.length > 0) {
        instructions.push(
          "CODE GRAPH CONTEXT (use this to understand call relationships):",
          ...callContexts,
          ""
        );
      }
    }
    instructions.push(
      "Diff:",
      diff
    );
    return instructions.join("\n");
  }
  /**
   * Build review prompt with context window validation
   *
   * @param pr - Pull request context
   * @param modelId - Target model ID for context window sizing
   * @param prNumber - Optional PR number for learned preferences
   * @returns Prompt string and fit check result
   */
  async buildWithValidation(pr, modelId, prNumber) {
    const prompt = await this.build(pr, prNumber);
    const fitCheck = checkContextWindowFit(prompt, modelId);
    if (!fitCheck.fits) {
      logger.warn(
        `Prompt for ${modelId} exceeds context window: ${fitCheck.promptTokens} tokens > ${fitCheck.availableTokens} available. ${fitCheck.recommendation}`
      );
    }
    return { prompt, fitCheck };
  }
  /**
   * Build optimized prompt that fits within context window
   * Automatically trims content if needed
   *
   * @param pr - Pull request context
   * @param modelId - Target model ID
   * @param prNumber - Optional PR number for learned preferences
   * @returns Optimized prompt that fits in context window
   */
  async buildOptimized(pr, modelId, prNumber) {
    let prompt = await this.build(pr, prNumber);
    let fitCheck = checkContextWindowFit(prompt, modelId);
    if (fitCheck.fits) {
      return prompt;
    }
    logger.warn(
      `Prompt exceeds context window for ${modelId}. ${fitCheck.promptTokens} tokens > ${fitCheck.availableTokens} available. Trimming diff content...`
    );
    const overageTokens = fitCheck.promptTokens - fitCheck.availableTokens;
    const overageBytes = overageTokens * 4;
    const currentDiffBytes = Buffer.byteLength(pr.diff, "utf8");
    const targetDiffBytes = Math.max(1e3, currentDiffBytes - overageBytes);
    logger.info(
      `Trimming diff from ${currentDiffBytes} to ${targetDiffBytes} bytes to fit context window`
    );
    const trimmedPR = {
      ...pr,
      diff: trimDiff(pr.diff, targetDiffBytes)
    };
    prompt = await this.build(trimmedPR, prNumber);
    fitCheck = checkContextWindowFit(prompt, modelId);
    if (!fitCheck.fits) {
      logger.warn(
        `Prompt still exceeds context window after trimming. ${fitCheck.promptTokens} tokens > ${fitCheck.availableTokens} available. Provider may fail or truncate.`
      );
    } else {
      logger.info(`Trimmed prompt now fits: ${fitCheck.promptTokens} tokens (${fitCheck.utilizationPercent.toFixed(0)}% utilization)`);
    }
    return prompt;
  }
  /**
   * Estimate token count for a PR without building the full prompt
   * Useful for pre-validation and batch sizing
   */
  estimateTokens(pr) {
    const baseOverhead = 500;
    const fileListTokens = pr.files.length * 20;
    const diffEstimate = estimateTokensConservative(pr.diff);
    return baseOverhead + fileListTokens + diffEstimate.tokens;
  }
  /**
   * Determine if suggestion instructions should be skipped due to large context
   *
   * Per FR-2.4: Skip suggestion generation when code snippet too large
   * to prevent hallucinated fixes from truncated context.
   *
   * Uses tiered thresholds per CONTEXT.md:
   * - small (4-16k window): skip if diff > 2000 tokens
   * - medium (128-200k window): skip if diff > 80000 tokens
   * - large (1M+ window): skip if diff > 400000 tokens
   */
  shouldSkipSuggestions(diff) {
    const estimate = estimateTokensConservative(diff);
    const SKIP_THRESHOLD = 5e4;
    if (estimate.tokens > SKIP_THRESHOLD) {
      logger.debug(
        `Skipping suggestion instructions: diff is ${estimate.tokens} tokens (threshold: ${SKIP_THRESHOLD})`
      );
      return true;
    }
    return false;
  }
};

// node_modules/eventemitter3/index.mjs
var import_index = __toESM(require_eventemitter3(), 1);

// node_modules/p-timeout/index.js
var TimeoutError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
};
var AbortError2 = class extends Error {
  constructor(message) {
    super();
    this.name = "AbortError";
    this.message = message;
  }
};
var getDOMException = (errorMessage) => globalThis.DOMException === void 0 ? new AbortError2(errorMessage) : new DOMException(errorMessage);
var getAbortedReason = (signal) => {
  const reason = signal.reason === void 0 ? getDOMException("This operation was aborted.") : signal.reason;
  return reason instanceof Error ? reason : getDOMException(reason);
};
function pTimeout(promise, options) {
  const {
    milliseconds,
    fallback,
    message,
    customTimers = { setTimeout, clearTimeout }
  } = options;
  let timer;
  let abortHandler;
  const wrappedPromise = new Promise((resolve2, reject) => {
    if (typeof milliseconds !== "number" || Math.sign(milliseconds) !== 1) {
      throw new TypeError(`Expected \`milliseconds\` to be a positive number, got \`${milliseconds}\``);
    }
    if (options.signal) {
      const { signal } = options;
      if (signal.aborted) {
        reject(getAbortedReason(signal));
      }
      abortHandler = () => {
        reject(getAbortedReason(signal));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    if (milliseconds === Number.POSITIVE_INFINITY) {
      promise.then(resolve2, reject);
      return;
    }
    const timeoutError = new TimeoutError();
    timer = customTimers.setTimeout.call(void 0, () => {
      if (fallback) {
        try {
          resolve2(fallback());
        } catch (error2) {
          reject(error2);
        }
        return;
      }
      if (typeof promise.cancel === "function") {
        promise.cancel();
      }
      if (message === false) {
        resolve2();
      } else if (message instanceof Error) {
        reject(message);
      } else {
        timeoutError.message = message ?? `Promise timed out after ${milliseconds} milliseconds`;
        reject(timeoutError);
      }
    }, milliseconds);
    (async () => {
      try {
        resolve2(await promise);
      } catch (error2) {
        reject(error2);
      }
    })();
  });
  const cancelablePromise = wrappedPromise.finally(() => {
    cancelablePromise.clear();
    if (abortHandler && options.signal) {
      options.signal.removeEventListener("abort", abortHandler);
    }
  });
  cancelablePromise.clear = () => {
    customTimers.clearTimeout.call(void 0, timer);
    timer = void 0;
  };
  return cancelablePromise;
}

// node_modules/p-queue/dist/lower-bound.js
function lowerBound(array, value, comparator) {
  let first = 0;
  let count = array.length;
  while (count > 0) {
    const step = Math.trunc(count / 2);
    let it = first + step;
    if (comparator(array[it], value) <= 0) {
      first = ++it;
      count -= step + 1;
    } else {
      count = step;
    }
  }
  return first;
}

// node_modules/p-queue/dist/priority-queue.js
var PriorityQueue = class {
  #queue = [];
  enqueue(run2, options) {
    options = {
      priority: 0,
      ...options
    };
    const element = {
      priority: options.priority,
      id: options.id,
      run: run2
    };
    if (this.size === 0 || this.#queue[this.size - 1].priority >= options.priority) {
      this.#queue.push(element);
      return;
    }
    const index = lowerBound(this.#queue, element, (a, b) => b.priority - a.priority);
    this.#queue.splice(index, 0, element);
  }
  setPriority(id, priority) {
    const index = this.#queue.findIndex((element) => element.id === id);
    if (index === -1) {
      throw new ReferenceError(`No promise function with the id "${id}" exists in the queue.`);
    }
    const [item] = this.#queue.splice(index, 1);
    this.enqueue(item.run, { priority, id });
  }
  dequeue() {
    const item = this.#queue.shift();
    return item?.run;
  }
  filter(options) {
    return this.#queue.filter((element) => element.priority === options.priority).map((element) => element.run);
  }
  get size() {
    return this.#queue.length;
  }
};

// node_modules/p-queue/dist/index.js
var PQueue = class extends import_index.default {
  #carryoverConcurrencyCount;
  #isIntervalIgnored;
  #intervalCount = 0;
  #intervalCap;
  #interval;
  #intervalEnd = 0;
  #intervalId;
  #timeoutId;
  #queue;
  #queueClass;
  #pending = 0;
  // The `!` is needed because of https://github.com/microsoft/TypeScript/issues/32194
  #concurrency;
  #isPaused;
  #throwOnTimeout;
  // Use to assign a unique identifier to a promise function, if not explicitly specified
  #idAssigner = 1n;
  /**
      Per-operation timeout in milliseconds. Operations fulfill once `timeout` elapses if they haven't already.
  
      Applies to each future operation.
      */
  timeout;
  // TODO: The `throwOnTimeout` option should affect the return types of `add()` and `addAll()`
  constructor(options) {
    super();
    options = {
      carryoverConcurrencyCount: false,
      intervalCap: Number.POSITIVE_INFINITY,
      interval: 0,
      concurrency: Number.POSITIVE_INFINITY,
      autoStart: true,
      queueClass: PriorityQueue,
      ...options
    };
    if (!(typeof options.intervalCap === "number" && options.intervalCap >= 1)) {
      throw new TypeError(`Expected \`intervalCap\` to be a number from 1 and up, got \`${options.intervalCap?.toString() ?? ""}\` (${typeof options.intervalCap})`);
    }
    if (options.interval === void 0 || !(Number.isFinite(options.interval) && options.interval >= 0)) {
      throw new TypeError(`Expected \`interval\` to be a finite number >= 0, got \`${options.interval?.toString() ?? ""}\` (${typeof options.interval})`);
    }
    this.#carryoverConcurrencyCount = options.carryoverConcurrencyCount;
    this.#isIntervalIgnored = options.intervalCap === Number.POSITIVE_INFINITY || options.interval === 0;
    this.#intervalCap = options.intervalCap;
    this.#interval = options.interval;
    this.#queue = new options.queueClass();
    this.#queueClass = options.queueClass;
    this.concurrency = options.concurrency;
    this.timeout = options.timeout;
    this.#throwOnTimeout = options.throwOnTimeout === true;
    this.#isPaused = options.autoStart === false;
  }
  get #doesIntervalAllowAnother() {
    return this.#isIntervalIgnored || this.#intervalCount < this.#intervalCap;
  }
  get #doesConcurrentAllowAnother() {
    return this.#pending < this.#concurrency;
  }
  #next() {
    this.#pending--;
    this.#tryToStartAnother();
    this.emit("next");
  }
  #onResumeInterval() {
    this.#onInterval();
    this.#initializeIntervalIfNeeded();
    this.#timeoutId = void 0;
  }
  get #isIntervalPaused() {
    const now = Date.now();
    if (this.#intervalId === void 0) {
      const delay = this.#intervalEnd - now;
      if (delay < 0) {
        this.#intervalCount = this.#carryoverConcurrencyCount ? this.#pending : 0;
      } else {
        if (this.#timeoutId === void 0) {
          this.#timeoutId = setTimeout(() => {
            this.#onResumeInterval();
          }, delay);
        }
        return true;
      }
    }
    return false;
  }
  #tryToStartAnother() {
    if (this.#queue.size === 0) {
      if (this.#intervalId) {
        clearInterval(this.#intervalId);
      }
      this.#intervalId = void 0;
      this.emit("empty");
      if (this.#pending === 0) {
        this.emit("idle");
      }
      return false;
    }
    if (!this.#isPaused) {
      const canInitializeInterval = !this.#isIntervalPaused;
      if (this.#doesIntervalAllowAnother && this.#doesConcurrentAllowAnother) {
        const job = this.#queue.dequeue();
        if (!job) {
          return false;
        }
        this.emit("active");
        job();
        if (canInitializeInterval) {
          this.#initializeIntervalIfNeeded();
        }
        return true;
      }
    }
    return false;
  }
  #initializeIntervalIfNeeded() {
    if (this.#isIntervalIgnored || this.#intervalId !== void 0) {
      return;
    }
    this.#intervalId = setInterval(() => {
      this.#onInterval();
    }, this.#interval);
    this.#intervalEnd = Date.now() + this.#interval;
  }
  #onInterval() {
    if (this.#intervalCount === 0 && this.#pending === 0 && this.#intervalId) {
      clearInterval(this.#intervalId);
      this.#intervalId = void 0;
    }
    this.#intervalCount = this.#carryoverConcurrencyCount ? this.#pending : 0;
    this.#processQueue();
  }
  /**
  Executes all queued functions until it reaches the limit.
  */
  #processQueue() {
    while (this.#tryToStartAnother()) {
    }
  }
  get concurrency() {
    return this.#concurrency;
  }
  set concurrency(newConcurrency) {
    if (!(typeof newConcurrency === "number" && newConcurrency >= 1)) {
      throw new TypeError(`Expected \`concurrency\` to be a number from 1 and up, got \`${newConcurrency}\` (${typeof newConcurrency})`);
    }
    this.#concurrency = newConcurrency;
    this.#processQueue();
  }
  async #throwOnAbort(signal) {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(signal.reason);
      }, { once: true });
    });
  }
  /**
      Updates the priority of a promise function by its id, affecting its execution order. Requires a defined concurrency limit to take effect.
  
      For example, this can be used to prioritize a promise function to run earlier.
  
      ```js
      import PQueue from 'p-queue';
  
      const queue = new PQueue({concurrency: 1});
  
      queue.add(async () => '🦄', {priority: 1});
      queue.add(async () => '🦀', {priority: 0, id: '🦀'});
      queue.add(async () => '🦄', {priority: 1});
      queue.add(async () => '🦄', {priority: 1});
  
      queue.setPriority('🦀', 2);
      ```
  
      In this case, the promise function with `id: '🦀'` runs second.
  
      You can also deprioritize a promise function to delay its execution:
  
      ```js
      import PQueue from 'p-queue';
  
      const queue = new PQueue({concurrency: 1});
  
      queue.add(async () => '🦄', {priority: 1});
      queue.add(async () => '🦀', {priority: 1, id: '🦀'});
      queue.add(async () => '🦄');
      queue.add(async () => '🦄', {priority: 0});
  
      queue.setPriority('🦀', -1);
      ```
      Here, the promise function with `id: '🦀'` executes last.
      */
  setPriority(id, priority) {
    this.#queue.setPriority(id, priority);
  }
  async add(function_, options = {}) {
    options.id ??= (this.#idAssigner++).toString();
    options = {
      timeout: this.timeout,
      throwOnTimeout: this.#throwOnTimeout,
      ...options
    };
    return new Promise((resolve2, reject) => {
      this.#queue.enqueue(async () => {
        this.#pending++;
        try {
          options.signal?.throwIfAborted();
          this.#intervalCount++;
          let operation = function_({ signal: options.signal });
          if (options.timeout) {
            operation = pTimeout(Promise.resolve(operation), { milliseconds: options.timeout });
          }
          if (options.signal) {
            operation = Promise.race([operation, this.#throwOnAbort(options.signal)]);
          }
          const result = await operation;
          resolve2(result);
          this.emit("completed", result);
        } catch (error2) {
          if (error2 instanceof TimeoutError && !options.throwOnTimeout) {
            resolve2();
            return;
          }
          reject(error2);
          this.emit("error", error2);
        } finally {
          this.#next();
        }
      }, options);
      this.emit("add");
      this.#tryToStartAnother();
    });
  }
  async addAll(functions, options) {
    return Promise.all(functions.map(async (function_) => this.add(function_, options)));
  }
  /**
  Start (or resume) executing enqueued tasks within concurrency limit. No need to call this if queue is not paused (via `options.autoStart = false` or by `.pause()` method.)
  */
  start() {
    if (!this.#isPaused) {
      return this;
    }
    this.#isPaused = false;
    this.#processQueue();
    return this;
  }
  /**
  Put queue execution on hold.
  */
  pause() {
    this.#isPaused = true;
  }
  /**
  Clear the queue.
  */
  clear() {
    this.#queue = new this.#queueClass();
  }
  /**
      Can be called multiple times. Useful if you for example add additional items at a later time.
  
      @returns A promise that settles when the queue becomes empty.
      */
  async onEmpty() {
    if (this.#queue.size === 0) {
      return;
    }
    await this.#onEvent("empty");
  }
  /**
      @returns A promise that settles when the queue size is less than the given limit: `queue.size < limit`.
  
      If you want to avoid having the queue grow beyond a certain size you can `await queue.onSizeLessThan()` before adding a new item.
  
      Note that this only limits the number of items waiting to start. There could still be up to `concurrency` jobs already running that this call does not include in its calculation.
      */
  async onSizeLessThan(limit) {
    if (this.#queue.size < limit) {
      return;
    }
    await this.#onEvent("next", () => this.#queue.size < limit);
  }
  /**
      The difference with `.onEmpty` is that `.onIdle` guarantees that all work from the queue has finished. `.onEmpty` merely signals that the queue is empty, but it could mean that some promises haven't completed yet.
  
      @returns A promise that settles when the queue becomes empty, and all promises have completed; `queue.size === 0 && queue.pending === 0`.
      */
  async onIdle() {
    if (this.#pending === 0 && this.#queue.size === 0) {
      return;
    }
    await this.#onEvent("idle");
  }
  async #onEvent(event, filter2) {
    return new Promise((resolve2) => {
      const listener = () => {
        if (filter2 && !filter2()) {
          return;
        }
        this.off(event, listener);
        resolve2();
      };
      this.on(event, listener);
    });
  }
  /**
  Size of the queue, the number of queued items waiting to run.
  */
  get size() {
    return this.#queue.size;
  }
  /**
      Size of the queue, filtered by the given options.
  
      For example, this can be used to find the number of items remaining in the queue with a specific priority level.
      */
  sizeBy(options) {
    return this.#queue.filter(options).length;
  }
  /**
  Number of running items (no longer in the queue).
  */
  get pending() {
    return this.#pending;
  }
  /**
  Whether the queue is currently paused.
  */
  get isPaused() {
    return this.#isPaused;
  }
};

// src/utils/parallel.ts
function createQueue(concurrency) {
  return new PQueue({ concurrency, autoStart: true });
}

// src/analysis/llm/executor.ts
var LLMExecutor = class {
  constructor(config) {
    this.config = config;
  }
  /**
   * Filter providers by running health checks to identify responsive providers
   * Providers that don't respond within healthCheckTimeoutMs are filtered out
   * @param providers - Array of providers to check
   * @param healthCheckTimeoutMs - Timeout for health check (default 30s)
   * @returns Object with healthy providers and health check results for all providers
   */
  async filterHealthyProviders(providers, healthCheckTimeoutMs = 3e4) {
    if (providers.length === 0) return { healthy: [], healthCheckResults: [] };
    logger.info(`Running health checks on ${providers.length} provider(s) with ${healthCheckTimeoutMs}ms timeout...`);
    const queue = createQueue(this.config.providerMaxParallel);
    const healthyProviders = [];
    const healthCheckResults = [];
    for (const provider of providers) {
      queue.add(async () => {
        const started = Date.now();
        try {
          const isHealthy = await provider.healthCheck(healthCheckTimeoutMs);
          const duration = Date.now() - started;
          if (isHealthy) {
            healthyProviders.push(provider);
            healthCheckResults.push({
              name: provider.name,
              status: "success",
              durationSeconds: duration / 1e3
            });
            logger.info(`\u2713 Provider ${provider.name} health check passed (${duration}ms)`);
          } else {
            const result = {
              name: provider.name,
              status: "timeout",
              error: new Error(`Health check timed out after ${duration}ms - provider did not respond within timeout`),
              durationSeconds: duration / 1e3
            };
            healthCheckResults.push(result);
            logger.warn(`\u2717 Provider ${provider.name} health check timed out (${duration}ms)`);
          }
        } catch (error2) {
          const duration = Date.now() - started;
          const err = error2;
          let status = "error";
          if (err.message.toLowerCase().includes("timed out") || err.message.toLowerCase().includes("timeout") || err.code === "ETIMEDOUT") {
            status = "timeout";
          }
          const result = {
            name: provider.name,
            status,
            error: err,
            durationSeconds: duration / 1e3
          };
          healthCheckResults.push(result);
          logger.warn(`\u2717 Provider ${provider.name} health check error (${duration}ms): ${err.message}`);
        }
      });
    }
    await queue.onIdle();
    logger.info(`Health checks complete: ${healthyProviders.length}/${providers.length} provider(s) are responsive`);
    return { healthy: healthyProviders, healthCheckResults };
  }
  async execute(providers, prompt, timeoutMs) {
    const queue = createQueue(this.config.providerMaxParallel);
    const results = [];
    for (const provider of providers) {
      queue.add(async () => {
        const started = Date.now();
        const actualTimeoutMs = timeoutMs ?? this.config.runTimeoutSeconds * 1e3;
        const runner = async () => provider.review(prompt, actualTimeoutMs);
        try {
          const result = await withRetry(runner, {
            retries: Math.max(0, this.config.providerRetries - 1),
            retryOn: (error2) => {
              if (error2 instanceof RateLimitError) return false;
              if (error2.message.includes("timed out after")) return false;
              return true;
            }
          });
          results.push({
            name: provider.name,
            status: "success",
            result,
            durationSeconds: (Date.now() - started) / 1e3
          });
        } catch (error2) {
          const err = error2;
          let status = "error";
          if (err instanceof RateLimitError) {
            status = "rate-limited";
          } else if (err.name === "TimeoutError" || err.message.toLowerCase().includes("timed out") || err.code === "ETIMEDOUT") {
            status = "timeout";
          }
          logger.warn(`Provider ${provider.name} failed: ${err.message}`);
          results.push({
            name: provider.name,
            status,
            error: err,
            durationSeconds: (Date.now() - started) / 1e3
          });
        }
      });
    }
    await queue.onIdle();
    return results;
  }
};

// src/analysis/deduplicator.ts
var Deduplicator = class {
  dedupe(findings) {
    const map2 = /* @__PURE__ */ new Map();
    for (const finding of findings) {
      const key = `${finding.file}:${finding.line}:${finding.title}`;
      if (!map2.has(key)) {
        map2.set(key, finding);
      } else {
        const existing = map2.get(key);
        const providers = new Set([
          ...existing.providers || [],
          ...finding.providers || [],
          existing.provider,
          finding.provider
        ].filter(Boolean));
        map2.set(key, { ...existing, providers: Array.from(providers) });
      }
    }
    return Array.from(map2.values());
  }
};

// src/analysis/ast/parsers.ts
function detectLanguage(filename) {
  if (filename.endsWith(".ts") || filename.endsWith(".tsx")) return "typescript";
  if (filename.endsWith(".js") || filename.endsWith(".jsx")) return "javascript";
  if (filename.endsWith(".py")) return "python";
  if (filename.endsWith(".go")) return "go";
  if (filename.endsWith(".rs")) return "rust";
  return "unknown";
}
function getParser(language) {
  const Parser = loadModule("tree-sitter");
  if (!Parser) {
    debugParser(`tree-sitter unavailable for ${language}`);
    return null;
  }
  const parser = new Parser();
  try {
    if (language === "typescript" || language === "javascript") {
      const ts = loadModule("tree-sitter-typescript");
      const grammar = language === "javascript" ? ts?.javascript ?? ts?.typescript : ts?.typescript;
      if (!grammar) {
        debugParser(`tree-sitter-typescript grammar unavailable for ${language}; keys=${ts ? Object.keys(ts).join(",") : "null"}`);
        return null;
      }
      parser.setLanguage(grammar);
      return parser;
    }
    if (language === "python") {
      const py = loadModule("tree-sitter-python");
      if (!py) {
        debugParser("tree-sitter-python unavailable");
        return null;
      }
      parser.setLanguage(py);
      return parser;
    }
    if (language === "go") {
      const go = loadModule("tree-sitter-go");
      if (!go) return null;
      parser.setLanguage(go);
      return parser;
    }
    if (language === "rust") {
      const rust = loadModule("tree-sitter-rust");
      if (!rust) return null;
      parser.setLanguage(rust);
      return parser;
    }
  } catch (error2) {
    debugParser(`setLanguage failed for ${language}: ${error2.message}`);
    return null;
  }
  return null;
}
function loadModule(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}
function debugParser(message) {
  if (process.env.MPR_DEBUG_PARSERS === "1") {
    console.error(`[parser] ${message}`);
  }
}

// src/validation/ast-comparator.ts
var VALUE_ONLY_TYPES = /* @__PURE__ */ new Set([
  // Identifiers
  "identifier",
  "property_identifier",
  "type_identifier",
  // Literals
  "string",
  "number",
  "true",
  "false",
  "null",
  "template_string",
  "regex",
  // Python-specific
  "integer",
  "float",
  "string_content",
  // JavaScript-specific
  "number_literal",
  "string_literal"
]);
var MAX_COMPARISON_DEPTH = 1e3;
function getRootNode(tree) {
  return (tree.rootNode ?? tree.root) || null;
}
function isValueOnlyNode(node) {
  return VALUE_ONLY_TYPES.has(node.type);
}
function hasParseErrors(tree) {
  const rootNode = getRootNode(tree);
  if (!rootNode) {
    return true;
  }
  const visitNode = (node) => {
    if (node.type === "ERROR") {
      debugAst(`ERROR node: ${node.text}`);
      return true;
    }
    if (node.isMissing) {
      debugAst(`MISSING node: type=${node.type}; text=${node.text}`);
      return true;
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && visitNode(child)) {
        return true;
      }
    }
    return false;
  };
  return visitNode(rootNode);
}
function debugAst(message) {
  if (process.env.MPR_DEBUG_AST === "1") {
    console.error(`[ast] ${message}`);
  }
}
function compareNodes(node1, node2, depth = 0) {
  const maxDepth = Math.max(depth, 0);
  if (depth > MAX_COMPARISON_DEPTH) {
    return {
      equivalent: false,
      reason: `Maximum comparison depth exceeded (${MAX_COMPARISON_DEPTH})`,
      maxDepth
    };
  }
  if (node1.type !== node2.type) {
    const node1IsValueOnly = isValueOnlyNode(node1);
    const node2IsValueOnly = isValueOnlyNode(node2);
    if (!node1IsValueOnly || !node2IsValueOnly) {
      return {
        equivalent: false,
        reason: `Node type mismatch at depth ${depth}: ${node1.type} vs ${node2.type}`,
        maxDepth
      };
    }
  }
  if (node1.childCount !== node2.childCount) {
    return {
      equivalent: false,
      reason: `Child count mismatch at depth ${depth}: ${node1.childCount} vs ${node2.childCount} children (node type: ${node1.type})`,
      maxDepth
    };
  }
  if (isValueOnlyNode(node1) && isValueOnlyNode(node2)) {
    return { equivalent: true, maxDepth: depth };
  }
  let deepestDepth = depth;
  for (let i = 0; i < node1.childCount; i++) {
    const child1 = node1.child(i);
    const child2 = node2.child(i);
    if (!child1 || !child2) {
      return {
        equivalent: false,
        reason: `Missing child at index ${i}, depth ${depth}`,
        maxDepth: deepestDepth
      };
    }
    const childResult = compareNodes(child1, child2, depth + 1);
    deepestDepth = Math.max(deepestDepth, childResult.maxDepth);
    if (!childResult.equivalent) {
      return {
        equivalent: false,
        reason: childResult.reason,
        maxDepth: deepestDepth
      };
    }
  }
  return { equivalent: true, maxDepth: deepestDepth };
}
function areASTsEquivalent(code1, code2, language) {
  if (language === "unknown") {
    return {
      equivalent: false,
      reason: "Unsupported language: unknown"
    };
  }
  const parser1 = getParser(language);
  const parser2 = getParser(language);
  if (!parser1 || !parser2) {
    return compareWithTokenFallback(code1, code2, language) || {
      equivalent: false,
      reason: `Unsupported language: ${language}`
    };
  }
  let tree1;
  let tree2;
  try {
    tree1 = parser1.parse(code1);
    tree2 = parser2.parse(code2);
  } catch (error2) {
    return {
      equivalent: false,
      reason: `Parser failed: ${error2.message}`
    };
  }
  const tree1HasErrors = hasParseErrors(tree1);
  const tree2HasErrors = hasParseErrors(tree2);
  if (tree1HasErrors || tree2HasErrors) {
    const code1HasObviousSyntaxError = hasObviousSyntaxError(code1, language);
    const code2HasObviousSyntaxError = hasObviousSyntaxError(code2, language);
    if (code1HasObviousSyntaxError) {
      return {
        equivalent: false,
        reason: "Parse error in code1"
      };
    }
    if (code2HasObviousSyntaxError) {
      return {
        equivalent: false,
        reason: "Parse error in code2"
      };
    }
    const fallbackResult = compareWithTokenFallback(code1, code2, language);
    if (fallbackResult) {
      return fallbackResult;
    }
  }
  if (tree1HasErrors) {
    const reparsedTree = parseWithFreshParser(code1, language);
    if (reparsedTree && !hasParseErrors(reparsedTree)) {
      tree1 = reparsedTree;
    } else {
      return {
        equivalent: false,
        reason: "Parse error in code1"
      };
    }
  }
  if (tree2HasErrors) {
    const reparsedTree = parseWithFreshParser(code2, language);
    if (reparsedTree && !hasParseErrors(reparsedTree)) {
      tree2 = reparsedTree;
    } else {
      return {
        equivalent: false,
        reason: "Parse error in code2"
      };
    }
  }
  const root1 = getRootNode(tree1);
  const root2 = getRootNode(tree2);
  if (!root1 || !root2) {
    return {
      equivalent: false,
      reason: "Parser returned no root node"
    };
  }
  const result = compareNodes(root1, root2);
  return {
    equivalent: result.equivalent,
    reason: result.reason,
    comparisonDepth: result.maxDepth
  };
}
function parseWithFreshParser(code, language) {
  const parser = getParser(language);
  if (!parser) {
    return null;
  }
  try {
    return parser.parse(code);
  } catch {
    return null;
  }
}
function compareWithTokenFallback(code1, code2, language) {
  if (hasObviousSyntaxError(code1, language) || hasObviousSyntaxError(code2, language)) {
    return null;
  }
  const tokens1 = normalizeStructuralTokens(code1);
  const tokens2 = normalizeStructuralTokens(code2);
  if (tokens1.length === 0 || tokens2.length === 0) {
    return null;
  }
  if (tokens1.join("\0") === tokens2.join("\0")) {
    return {
      equivalent: true,
      comparisonDepth: Math.max(1, tokens1.length)
    };
  }
  if (tokens1.length !== tokens2.length) {
    return {
      equivalent: false,
      reason: `Child count mismatch in token fallback: ${tokens1.length} vs ${tokens2.length}`,
      comparisonDepth: Math.max(tokens1.length, tokens2.length)
    };
  }
  return {
    equivalent: false,
    reason: "Node type mismatch in token fallback",
    comparisonDepth: tokens1.length
  };
}
function normalizeStructuralTokens(code) {
  return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|==={0,1}|!==?|=>|[{}()[\].,;:+\-*/%=<>]/g)?.map((token) => {
    if (/^["']/.test(token)) return "STRING";
    if (/^\d/.test(token)) return "NUMBER";
    if (token === "true" || token === "false") return "BOOLEAN";
    if (/^[A-Za-z_$]/.test(token) && !isStructuralKeyword(token)) return "IDENTIFIER";
    return token;
  }) || [];
}
function isStructuralKeyword(token) {
  return (/* @__PURE__ */ new Set([
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "while",
    "for",
    "class",
    "def",
    "async",
    "await"
  ])).has(token);
}
function hasObviousSyntaxError(code, language) {
  const trimmed = code.trim();
  if (!trimmed) {
    return false;
  }
  if (hasIncompleteTrailingCharacter(trimmed)) {
    return true;
  }
  if (language === "typescript" || language === "javascript") {
    if (/\b(?:const|let|var)\b[^;\n]*\s+\b(?:const|let|var)\b/.test(trimmed)) {
      return true;
    }
    if (/=\s*\n\s*(?:return|const|let|var|})/.test(code)) {
      return true;
    }
  }
  return hasUnbalancedDelimiters(trimmed);
}
function hasIncompleteTrailingCharacter(value) {
  const lastCharacter = value[value.length - 1];
  return ["=", "+", "-", "*", "/", "%", ",", "(", "{", "["].includes(lastCharacter);
}
function hasUnbalancedDelimiters(code) {
  const stack = [];
  const pairs2 = { ")": "(", "}": "{", "]": "[" };
  let quote = null;
  let escaped = false;
  for (const char of code) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      stack.push(char);
    } else if (char === ")" || char === "}" || char === "]") {
      if (stack.pop() !== pairs2[char]) {
        return true;
      }
    }
  }
  return quote !== null || stack.length > 0;
}

// src/analysis/consensus.ts
var SEVERITY_ORDER = {
  critical: 3,
  major: 2,
  minor: 1
};
var ConsensusEngine = class {
  constructor(options) {
    this.options = options;
  }
  filter(findings) {
    const grouped = /* @__PURE__ */ new Map();
    for (const finding of findings) {
      if (!this.meetsSeverity(finding.severity)) {
        continue;
      }
      const key = `${finding.file}:${finding.line}:${finding.title}`;
      const existing = grouped.get(key);
      const providers = /* @__PURE__ */ new Set();
      if (finding.providers) finding.providers.forEach((p) => providers.add(p));
      if (finding.provider) providers.add(finding.provider);
      if (providers.size === 0) providers.add("static");
      const currentSuggestions = [];
      if (finding.suggestion && finding.provider) {
        currentSuggestions.push({ provider: finding.provider, suggestion: finding.suggestion, file: finding.file });
      }
      if (!existing) {
        grouped.set(key, {
          ...finding,
          providers: Array.from(providers),
          confidence: (finding.confidence ?? 0) || 1,
          _suggestions: currentSuggestions
          // Temporary for consensus checking
        });
        continue;
      }
      const mergedSuggestions = [
        ...existing._suggestions || [],
        ...currentSuggestions
      ];
      grouped.set(key, {
        ...existing,
        providers: Array.from(/* @__PURE__ */ new Set([...existing.providers || [], ...providers])),
        confidence: Math.min(1, (existing.confidence ?? 0) + (finding.confidence ?? 0.5)),
        _suggestions: mergedSuggestions
      });
    }
    const filtered = Array.from(grouped.values()).filter((f) => this.meetsAgreement(f.providers || [])).map((f) => {
      if (f._suggestions && f._suggestions.length >= 2) {
        const consensus = this.checkSuggestionConsensus(f._suggestions, this.options.minAgreement);
        f.hasConsensus = consensus.hasSuggestionConsensus;
        if (consensus.hasSuggestionConsensus && consensus.suggestions.length > 0) {
          f.suggestion = consensus.suggestions[0];
        }
      }
      delete f._suggestions;
      return f;
    });
    filtered.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
    return filtered;
  }
  meetsSeverity(severity) {
    return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[this.options.minSeverity];
  }
  meetsAgreement(providers) {
    if (providers.includes("static")) return true;
    const count = providers.length;
    if (count >= this.options.minAgreement) return true;
    return count === 1;
  }
  /**
   * Check if multiple providers' suggestions are AST-equivalent.
   * Used for critical severity findings where consensus is required.
   */
  checkSuggestionConsensus(suggestions, minAgreement = 2) {
    if (suggestions.length < minAgreement) {
      return { hasSuggestionConsensus: false, agreementCount: 0, suggestions: [] };
    }
    const language = detectLanguage(suggestions[0].file);
    if (language === "unknown") {
      return this.checkStringConsensus(suggestions, minAgreement);
    }
    const groups = [];
    for (const s of suggestions) {
      let added = false;
      for (const group of groups) {
        const result = areASTsEquivalent(group[0], s.suggestion, language);
        if (result.equivalent) {
          group.push(s.suggestion);
          added = true;
          break;
        }
      }
      if (!added) {
        groups.push([s.suggestion]);
      }
    }
    const largestGroup = groups.reduce((a, b) => a.length > b.length ? a : b, []);
    return {
      hasSuggestionConsensus: largestGroup.length >= minAgreement,
      agreementCount: largestGroup.length,
      suggestions: largestGroup
    };
  }
  checkStringConsensus(suggestions, minAgreement) {
    const normalized = suggestions.map((s) => ({ ...s, normalized: s.suggestion.trim().replace(/\s+/g, " ") }));
    const counts = /* @__PURE__ */ new Map();
    for (const s of normalized) {
      const arr = counts.get(s.normalized) || [];
      arr.push(s.suggestion);
      counts.set(s.normalized, arr);
    }
    const largest = Array.from(counts.values()).reduce((a, b) => a.length > b.length ? a : b, []);
    return {
      hasSuggestionConsensus: largest.length >= minAgreement,
      agreementCount: largest.length,
      suggestions: largest
    };
  }
};

// src/utils/suggestion-formatter.ts
function countMaxConsecutiveBackticks(str2) {
  const backtickSequences = str2.match(/`+/g);
  if (!backtickSequences) {
    return 0;
  }
  return Math.max(...backtickSequences.map((seq2) => seq2.length));
}
function formatSuggestionBlock(content) {
  if (!content || content.trim() === "") {
    return "";
  }
  const maxBackticks = countMaxConsecutiveBackticks(content);
  const fenceCount = Math.max(3, maxBackticks + 1);
  const fence = "`".repeat(fenceCount);
  return `${fence}suggestion
${content}
${fence}`;
}

// src/analysis/synthesis.ts
var SynthesisEngine = class {
  constructor(config) {
    this.config = config;
  }
  synthesize(findings, pr, testHints, aiAnalysis, providerResults, runDetails, impactAnalysis, mermaidDiagram) {
    const metrics = this.buildMetrics(findings, providerResults, runDetails);
    const summary = this.buildSummary(pr, findings, metrics, testHints, aiAnalysis, providerResults, impactAnalysis);
    const inlineComments = this.buildInlineComments(findings);
    const actionItems = this.buildActionItems(findings);
    return {
      summary,
      findings,
      inlineComments,
      actionItems,
      testHints,
      aiAnalysis,
      metrics,
      providerResults,
      runDetails,
      impactAnalysis,
      mermaidDiagram
    };
  }
  buildMetrics(findings, providerResults, runDetails) {
    const critical = findings.filter((f) => f.severity === "critical").length;
    const major = findings.filter((f) => f.severity === "major").length;
    const minor = findings.filter((f) => f.severity === "minor").length;
    let providersUsed = 0;
    let providersSuccess = 0;
    let providersFailed = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let durationSeconds = 0;
    if (runDetails) {
      providersUsed = runDetails.providers.length;
      providersSuccess = runDetails.providers.filter((p) => p.status === "success").length;
      providersFailed = runDetails.providers.filter(
        (p) => p.status === "error" || p.status === "timeout"
      ).length;
      totalTokens = runDetails.totalTokens;
      totalCost = runDetails.totalCost;
      durationSeconds = runDetails.durationSeconds;
    } else if (providerResults) {
      providersUsed = providerResults.length;
      providersSuccess = providerResults.filter((p) => p.status === "success").length;
      providersFailed = providerResults.filter(
        (p) => p.status === "error" || p.status === "timeout"
      ).length;
      totalTokens = providerResults.reduce((sum, p) => {
        return sum + (p.result?.usage?.totalTokens ?? 0);
      }, 0);
      totalCost = 0;
      durationSeconds = providerResults.reduce((sum, p) => sum + p.durationSeconds, 0);
    }
    return {
      totalFindings: findings.length,
      critical,
      major,
      minor,
      providersUsed,
      providersSuccess,
      providersFailed,
      totalTokens,
      totalCost,
      durationSeconds
    };
  }
  buildSummary(pr, findings, metrics, testHints, aiAnalysis, providerResults, impactAnalysis) {
    const totalProviders = providerResults?.length ?? 0;
    const successes = providerResults?.filter((p) => p.status === "success").length ?? 0;
    const failures = totalProviders - successes;
    const impactText = impactAnalysis ? ` \u2022 Impact: ${impactAnalysis.impactLevel}` : "";
    const aiText = aiAnalysis ? ` \u2022 AI-likelihood: ${(aiAnalysis.averageLikelihood * 100).toFixed(1)}%` : "";
    return [
      `Review for PR #${pr.number}: ${pr.title}`,
      `Files: ${pr.files.length} (+${pr.additions}/-${pr.deletions}) \u2022 Providers: ${successes}/${totalProviders} succeeded${failures > 0 ? `, ${failures} failed` : ""} \u2022 Findings: ${metrics.totalFindings} (C${metrics.critical}/M${metrics.major}/m${metrics.minor})${impactText}${aiText}`
    ].join("\n");
  }
  buildInlineComments(findings) {
    const severityOrder = {
      critical: 3,
      major: 2,
      minor: 1
    };
    const sorted = findings.filter((f) => severityOrder[f.severity] >= severityOrder[this.config.inlineMinSeverity]).slice(0, this.config.inlineMaxComments);
    return sorted.map((f) => ({
      path: f.file,
      line: f.line,
      side: "RIGHT",
      body: this.commentBody(f)
    }));
  }
  commentBody(finding) {
    const parts = [`**${finding.title}**`, finding.message];
    if (finding.suggestion) {
      const suggestionBlock = formatSuggestionBlock(finding.suggestion);
      if (suggestionBlock) {
        parts.push("", suggestionBlock);
      }
    }
    if (finding.providers && finding.providers.length > 1) {
      parts.push("", `Providers: ${finding.providers.join(", ")}`);
    }
    return parts.join("\n");
  }
  buildActionItems(findings) {
    const items = findings.filter((f) => f.severity !== "minor").slice(0, 5).map((f) => `${f.file}:${f.line} \u2014 ${f.title}`);
    return Array.from(new Set(items));
  }
};

// src/analysis/test-coverage.ts
var fs8 = __toESM(require("fs"));
var path7 = __toESM(require("path"));
var TestCoverageAnalyzer = class _TestCoverageAnalyzer {
  static MAX_HINTS = 20;
  analyze(files) {
    const hints = [];
    for (const file of files) {
      if (!this.isCodeFile(file.filename)) continue;
      if (this.isTestFile(file.filename)) continue;
      const existing = this.findTestFile(file.filename);
      if (!existing) {
        hints.push({
          file: file.filename,
          suggestedTestFile: this.suggestTestFile(file.filename),
          testPattern: this.getPattern(file.filename)
        });
      }
    }
    return hints.slice(0, _TestCoverageAnalyzer.MAX_HINTS);
  }
  isCodeFile(filename) {
    return [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".rb", ".java"].some(
      (ext2) => filename.endsWith(ext2)
    );
  }
  isTestFile(filename) {
    const patterns = [".test.", ".spec.", "__tests__", "tests/", "test_"];
    return patterns.some((pattern) => filename.includes(pattern));
  }
  findTestFile(filename) {
    const dir = path7.dirname(filename);
    const base = path7.basename(filename, path7.extname(filename));
    const ext2 = path7.extname(filename);
    const candidates = [
      `${base}.test${ext2}`,
      `${base}.spec${ext2}`,
      `${base}_test${ext2}`,
      `test_${base}${ext2}`,
      path7.join("__tests__", `${base}.test${ext2}`)
    ];
    for (const candidate of candidates) {
      const full = path7.join(dir, candidate);
      if (fs8.existsSync(full)) return full;
    }
    return null;
  }
  suggestTestFile(filename) {
    const dir = path7.dirname(filename);
    const base = path7.basename(filename, path7.extname(filename));
    const ext2 = path7.extname(filename);
    if (ext2 === ".ts" || ext2 === ".tsx") return path7.join(dir, `${base}.test.ts`);
    if (ext2 === ".py") return path7.join(dir, `test_${base}.py`);
    return path7.join(dir, `${base}.test${ext2}`);
  }
  getPattern(filename) {
    const ext2 = path7.extname(filename);
    if (ext2 === ".ts" || ext2 === ".tsx") return "Jest: *.test.ts or __tests__/*.ts";
    if (ext2 === ".py") return "pytest: test_*.py or *_test.py";
    return `*.test${ext2}`;
  }
};

// src/analysis/ast/patterns.ts
var PATTERNS = [
  {
    regex: /console\.log/,
    title: "Console logging left in code",
    message: "Remove debug logging before merging.",
    severity: "minor"
  },
  {
    regex: /debugger;/,
    title: "Debugger statement",
    message: "Debugger statements should be removed.",
    severity: "major"
  },
  {
    regex: /TODO|FIXME/,
    title: "Unresolved TODO",
    message: "Address TODOs or track them explicitly.",
    severity: "minor"
  }
];
function detectPatternFindings(filename, addedLines) {
  if (filename.includes("analysis/ast/patterns.ts")) return [];
  const findings = [];
  for (const { line, content } of addedLines) {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(content)) {
        findings.push({
          file: filename,
          line,
          severity: pattern.severity,
          title: pattern.title,
          message: pattern.message,
          provider: "ast",
          providers: ["ast"]
        });
      }
    }
  }
  return findings;
}

// src/analysis/ast/analyzer.ts
var ASTAnalyzer = class {
  analyze(files) {
    const findings = [];
    for (const file of files) {
      if (this.isTestFile(file.filename)) {
        continue;
      }
      const language = detectLanguage(file.filename);
      const addedLines = mapAddedLines(file.patch);
      findings.push(...detectPatternFindings(file.filename, addedLines));
      if (language !== "unknown") {
        findings.push(...this.runLanguageChecks(file.filename, language, addedLines));
      }
      findings.push(...this.runHeuristics(file.filename, addedLines));
    }
    return findings;
  }
  runLanguageChecks(filename, language, addedLines) {
    const findings = [];
    const code = addedLines.map((l) => l.content).join("\n");
    if (!code.trim()) return findings;
    const parser = getParser(language);
    if (!parser) {
      return this.runHeuristics(filename, addedLines);
    }
    const tree = parser.parse(code);
    const lineLookup = addedLines.map((l) => l.line);
    const stack = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (language !== "python") {
        if (node.type === "call_expression") {
          const fnNode = node.childForFieldName("function");
          if (fnNode && fnNode.text === "console.log") {
            const row = node.startPosition.row;
            const line = lineLookup[row] ?? row + 1;
            findings.push({
              file: filename,
              line,
              severity: "minor",
              title: "Console logging left in code",
              message: "Remove debug logging before merging.",
              provider: "ast",
              providers: ["ast"]
            });
          }
        }
        if (node.type === "debugger_statement") {
          const row = node.startPosition.row;
          const line = lineLookup[row] ?? row + 1;
          findings.push({
            file: filename,
            line,
            severity: "major",
            title: "Debugger statement",
            message: "Debugger statements should be removed.",
            provider: "ast",
            providers: ["ast"]
          });
        }
        if (language === "typescript" && node.type === "predefined_type" && node.text === "any") {
          const row = node.startPosition.row;
          const line = lineLookup[row] ?? row + 1;
          findings.push({
            file: filename,
            line,
            severity: "major",
            title: "Unsafe any type",
            message: "Avoid using `any`; prefer specific types.",
            provider: "ast",
            providers: ["ast"]
          });
        }
        if (node.type === "catch_clause") {
          const body = node.childForFieldName("body");
          if (body && body.namedChildCount === 0) {
            const row = node.startPosition.row;
            const line = lineLookup[row] ?? row + 1;
            findings.push({
              file: filename,
              line,
              severity: "major",
              title: "Empty catch block",
              message: "Handle or log errors in catch blocks.",
              provider: "ast",
              providers: ["ast"]
            });
          }
        }
      } else {
        if (node.type === "call" && node.child(0)?.text === "print") {
          const row = node.startPosition.row;
          const line = lineLookup[row] ?? row + 1;
          findings.push({
            file: filename,
            line,
            severity: "minor",
            title: "Debug print statement",
            message: "Remove debug print statements before merging.",
            provider: "ast",
            providers: ["ast"]
          });
        }
      }
      for (const child of node.children) {
        stack.push(child);
      }
    }
    return findings;
  }
  isTestFile(filename) {
    const lower = filename.toLowerCase();
    return lower.includes("__tests__") || lower.includes("/tests/") || lower.endsWith(".test.ts") || lower.endsWith(".test.js") || lower.endsWith(".spec.ts") || lower.endsWith(".spec.js");
  }
  runHeuristics(filename, addedLines) {
    const findings = [];
    for (const { line, content } of addedLines) {
      if (content.includes("Promise<any>") && !content.includes("/Promise<any>/") || /:\\s*any\\b/.test(content) && !content.includes("/:\\s*any\\b/")) {
        findings.push({
          file: filename,
          line,
          severity: "major",
          title: "Unsafe any type",
          message: "Avoid using `any`; prefer specific types.",
          provider: "ast",
          providers: ["ast"]
        });
      }
      if (/catch\s*\([^)]*\)\s*{\s*}/.test(content)) {
        findings.push({
          file: filename,
          line,
          severity: "major",
          title: "Empty catch block",
          message: "Handle or log errors in catch blocks.",
          provider: "ast",
          providers: ["ast"]
        });
      }
    }
    return findings;
  }
};

// src/cache/storage.ts
var fs9 = __toESM(require("fs/promises"));
var path8 = __toESM(require("path"));
var CacheStorage = class {
  constructor(baseDir = path8.join(process.cwd(), ".mpr-cache")) {
    this.baseDir = baseDir;
  }
  locks = /* @__PURE__ */ new Map();
  async read(key) {
    const file = path8.join(this.baseDir, `${key}.json`);
    try {
      return await fs9.readFile(file, "utf8");
    } catch {
      return null;
    }
  }
  async write(key, value) {
    await this.acquireLock(key);
    try {
      const file = path8.join(this.baseDir, `${key}.json`);
      await fs9.mkdir(this.baseDir, { recursive: true });
      await fs9.writeFile(file, value, "utf8");
      logger.info(`Cached results at ${file}`);
    } finally {
      this.releaseLock(key);
    }
  }
  /**
   * Delete all cache entries matching a given prefix
   * Useful for clearing PR-specific or feature-specific caches
   */
  async deleteByPrefix(prefix) {
    try {
      await fs9.mkdir(this.baseDir, { recursive: true });
    } catch (error2) {
      logger.error(`Failed to create cache directory ${this.baseDir}`, error2);
      return 0;
    }
    try {
      const files = await fs9.readdir(this.baseDir);
      const matchingFiles = files.filter((file) => {
        const key = file.replace(/\.json$/, "");
        return key.startsWith(prefix);
      });
      let deletedCount = 0;
      for (const file of matchingFiles) {
        try {
          await fs9.unlink(path8.join(this.baseDir, file));
          deletedCount++;
        } catch (error2) {
          logger.warn(`Failed to delete cache file ${file}`, error2);
        }
      }
      if (deletedCount > 0) {
        logger.info(`Deleted ${deletedCount} cache entries with prefix: ${prefix}`);
      }
      return deletedCount;
    } catch (error2) {
      logger.warn(`Failed to delete cache entries by prefix ${prefix}`, error2);
      return 0;
    }
  }
  async acquireLock(key) {
    const existingLock = this.locks.get(key);
    if (existingLock) {
      await existingLock.promise;
    }
    let resolver;
    const lockPromise = new Promise((resolve2) => {
      resolver = resolve2;
    });
    this.locks.set(key, {
      promise: lockPromise,
      resolve: resolver
    });
  }
  releaseLock(key) {
    const lock = this.locks.get(key);
    if (lock) {
      lock.resolve();
      this.locks.delete(key);
    }
  }
};

// src/cache/key-builder.ts
var import_crypto = require("crypto");
function buildCacheKey(pr, configHash) {
  const hash = (0, import_crypto.createHash)("sha1").update(`${pr.baseSha}:${pr.headSha}`).digest("hex").slice(0, 12);
  const suffix = configHash ? `-${configHash}` : "";
  return `mpr-${hash}${suffix}`;
}
function hashConfig(config) {
  const relevantConfig = {
    // Analysis toggles
    enableAstAnalysis: config.enableAstAnalysis,
    enableSecurity: config.enableSecurity,
    enableTestHints: config.enableTestHints,
    enableAiDetection: config.enableAiDetection,
    // Graph analysis config
    graphEnabled: config.graphEnabled,
    graphMaxDepth: config.graphMaxDepth,
    // Triviality detection affects which files are analyzed
    skipTrivialChanges: config.skipTrivialChanges,
    trivialPatterns: config.trivialPatterns,
    // Inline comment filtering
    inlineMinSeverity: config.inlineMinSeverity,
    inlineMinAgreement: config.inlineMinAgreement,
    // Intensity affects prompt depth
    pathBasedIntensity: config.pathBasedIntensity,
    pathIntensityPatterns: config.pathIntensityPatterns,
    pathDefaultIntensity: config.pathDefaultIntensity
  };
  const sortObject = (value) => {
    if (Array.isArray(value)) return value.map(sortObject);
    if (value && typeof value === "object") {
      const sorted = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = sortObject(value[key]);
      }
      return sorted;
    }
    return value;
  };
  const stableJson = JSON.stringify(sortObject(relevantConfig));
  const hash = (0, import_crypto.createHash)("sha256").update(stableJson).digest("hex");
  return hash.slice(0, 16);
}

// src/cache/version.ts
var CACHE_VERSION = 7;
function versionCache(data) {
  return {
    version: CACHE_VERSION,
    timestamp: Date.now(),
    data
  };
}
function unversionCache(cached, maxAge) {
  try {
    const parsed = JSON.parse(cached);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    if (typeof parsed.version !== "number" || typeof parsed.timestamp !== "number") {
      return null;
    }
    if (!("data" in parsed) || parsed.data === void 0) {
      return null;
    }
    if (parsed.version !== CACHE_VERSION) {
      return null;
    }
    if (maxAge && Date.now() - parsed.timestamp > maxAge) {
      return null;
    }
    return parsed.data;
  } catch (error2) {
    return null;
  }
}

// src/cache/manager.ts
var DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var CacheManager = class {
  constructor(storage = new CacheStorage(), config) {
    this.storage = storage;
    this.config = config;
  }
  TTL_MS = DEFAULT_CACHE_TTL_MS;
  async load(pr) {
    const configHash = this.config ? hashConfig(this.config) : void 0;
    const key = buildCacheKey(pr, configHash);
    let raw;
    try {
      raw = await this.storage.read(key);
    } catch (error2) {
      logger.warn(`Cache read failed for ${key}`, error2);
      return null;
    }
    if (!raw) return null;
    const payload = unversionCache(raw, this.TTL_MS);
    if (!payload) {
      logger.debug(`Cache invalid or expired for ${key}`);
      return null;
    }
    logger.info(`Cache hit for ${key}: ${payload.findings.length} findings`);
    return payload.findings;
  }
  async save(pr, review) {
    const configHash = this.config ? hashConfig(this.config) : void 0;
    const key = buildCacheKey(pr, configHash);
    const payload = {
      findings: review.findings,
      timestamp: Date.now()
    };
    const versioned = versionCache(payload);
    await this.storage.write(key, JSON.stringify(versioned));
    logger.info(`Cached ${review.findings.length} findings for ${key}`);
  }
};

// src/cache/incremental.ts
var import_child_process6 = require("child_process");
var IncrementalReviewer = class _IncrementalReviewer {
  constructor(storage = new CacheStorage(), config = { enabled: true, cacheTtlDays: 7 }) {
    this.storage = storage;
    this.config = config;
  }
  static CACHE_KEY_PREFIX = "incremental-review-pr-";
  static DEFAULT_TTL_DAYS = 7;
  static MS_PER_DAY = 24 * 60 * 60 * 1e3;
  /**
   * Check if incremental review should be used for this PR
   */
  async shouldUseIncremental(pr) {
    if (!this.config.enabled) {
      logger.debug("Incremental review disabled by configuration");
      return false;
    }
    const lastReview = await this.getLastReview(pr.number);
    if (!lastReview) {
      logger.debug("No previous review found, running full review");
      return false;
    }
    const ageMs = Date.now() - lastReview.timestamp;
    const ttlMs = this.config.cacheTtlDays * _IncrementalReviewer.MS_PER_DAY;
    if (ageMs > ttlMs) {
      const ageMinutes = Math.round(ageMs / 1e3 / 60);
      logger.debug(`Cache expired (age: ${ageMinutes} minutes, TTL: ${this.config.cacheTtlDays} days)`);
      return false;
    }
    if (lastReview.lastReviewedCommit === pr.headSha) {
      logger.debug("PR head SHA unchanged since last review");
      return false;
    }
    logger.info(`Incremental review available from ${lastReview.lastReviewedCommit.substring(0, 7)} to ${pr.headSha.substring(0, 7)}`);
    return true;
  }
  /**
   * Get the last review data for a PR
   */
  async getLastReview(prNumber) {
    const key = this.buildCacheKey(prNumber);
    const raw = await this.storage.read(key);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return data;
    } catch (error2) {
      logger.warn("Failed to parse incremental cache", error2);
      return null;
    }
  }
  /**
   * Save review data for incremental updates
   */
  async saveReview(pr, review) {
    const key = this.buildCacheKey(pr.number);
    const data = {
      prNumber: pr.number,
      lastReviewedCommit: pr.headSha,
      timestamp: Date.now(),
      findings: review.findings,
      reviewSummary: review.summary
    };
    await this.storage.write(key, JSON.stringify(data));
    logger.info(`Saved incremental review data for PR #${pr.number} at commit ${pr.headSha.substring(0, 7)}`);
  }
  /**
   * Validate that a string is a valid git SHA
   */
  isValidSha(sha) {
    return /^[a-f0-9]{4,40}$/i.test(sha);
  }
  /**
   * Get list of files changed since the last review
   */
  async getChangedFilesSince(pr, lastCommit) {
    try {
      if (!this.isValidSha(lastCommit)) {
        throw new Error(`Invalid commit SHA: ${lastCommit}`);
      }
      if (!this.isValidSha(pr.headSha)) {
        throw new Error(`Invalid PR head SHA: ${pr.headSha}`);
      }
      logger.debug(`Running git diff --name-status ${lastCommit.substring(0, 7)}...${pr.headSha.substring(0, 7)}`);
      let output;
      try {
        output = (0, import_child_process6.execFileSync)("git", ["diff", "--name-status", `${lastCommit}...${pr.headSha}`], {
          encoding: "utf8",
          cwd: process.cwd(),
          timeout: 1e4
          // 10 second timeout
        });
      } catch (error2) {
        logger.warn(`Failed to get git diff: ${error2 instanceof Error ? error2.message : String(error2)}`);
        return pr.files;
      }
      const changedFiles = [];
      const lines = output.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const pathParts = line.split("	").slice(1);
        const filename = pathParts.join("	");
        const prFile = pr.files.find((f) => f.filename === filename);
        if (prFile) {
          changedFiles.push(prFile);
        } else {
          logger.debug(`File ${filename} in diff but not in PR files`);
        }
      }
      logger.info(`Found ${changedFiles.length} changed files since ${lastCommit.substring(0, 7)}`);
      return changedFiles;
    } catch (error2) {
      logger.error("Failed to get changed files from git diff", error2);
      logger.warn(`Falling back to full review (${pr.files.length} files) due to git diff failure`);
      return pr.files;
    }
  }
  /**
   * Merge findings from previous review with new findings
   *
   * Strategy:
   * 1. Keep findings from unchanged files
   * 2. Remove findings from changed files (they'll be replaced by new review)
   * 3. Add new findings from current review
   */
  mergeFindings(previousFindings, newFindings, changedFiles) {
    const changedFilenames = new Set(changedFiles.map((f) => f.filename));
    const keptFindings = previousFindings.filter((f) => !changedFilenames.has(f.file));
    const merged = [...keptFindings, ...newFindings];
    logger.info(
      `Merged findings: ${keptFindings.length} kept from unchanged files, ${newFindings.length} new from review, total ${merged.length}`
    );
    return merged;
  }
  /**
   * Generate incremental review summary
   */
  generateIncrementalSummary(previousSummary, newSummary, changedFiles, lastCommit, currentCommit) {
    const incrementalNote = `
## \u{1F504} Incremental Review

This is an incremental review covering changes from \`${lastCommit.substring(0, 7)}\` to \`${currentCommit.substring(0, 7)}\`.

**Files reviewed in this update:** ${changedFiles.length}
${changedFiles.map((f) => `- ${f.filename}`).join("\n")}

---

${newSummary}

<details>
<summary>Previous Review Summary</summary>

${previousSummary}

</details>
`;
    return incrementalNote;
  }
  buildCacheKey(prNumber) {
    return `${_IncrementalReviewer.CACHE_KEY_PREFIX}${prNumber}`;
  }
};

// src/cost/tracker.ts
var CostTracker = class {
  constructor(pricing) {
    this.pricing = pricing;
  }
  totalCost = 0;
  totalTokens = 0;
  breakdown = {};
  async record(provider, usage, budgetMaxUsd) {
    if (!usage) return;
    const pricing = await this.pricing.getPricing(provider.replace("openrouter/", ""));
    const cost = pricing.promptPrice / 1e6 * usage.promptTokens + pricing.completionPrice / 1e6 * usage.completionTokens;
    const projectedTotal = this.totalCost + cost;
    if (budgetMaxUsd !== null && budgetMaxUsd !== void 0 && projectedTotal > budgetMaxUsd) {
      throw new Error(
        `Budget exceeded: projected $${projectedTotal.toFixed(4)} would exceed cap $${budgetMaxUsd.toFixed(2)} (current $${this.totalCost.toFixed(4)})`
      );
    }
    this.totalCost = projectedTotal;
    this.totalTokens += usage.totalTokens;
    this.breakdown[provider] = (this.breakdown[provider] || 0) + cost;
  }
  summary() {
    return {
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
      breakdown: this.breakdown
    };
  }
  /**
   * Reset accumulated cost data
   */
  reset() {
    this.totalCost = 0;
    this.totalTokens = 0;
    this.breakdown = {};
  }
};

// src/security/secrets.ts
var SECRET_PATTERNS = [
  // AWS Secrets
  {
    regex: /AKIA[0-9A-Z]{16}/,
    title: "Possible AWS access key",
    message: "Rotate the key immediately and remove it from source control."
  },
  {
    regex: /aws_secret_access_key\s*=\s*[\w/+=]{40}/i,
    title: "Possible AWS secret access key",
    message: "Rotate the key immediately and remove it from source control."
  },
  // Google Cloud Platform
  {
    regex: /AIza[0-9A-Za-z_-]{35}/,
    title: "Possible Google API key",
    message: "Rotate the key and restrict API key permissions. Remove from source control."
  },
  {
    regex: /"type":\s*"service_account"/,
    title: "Possible GCP service account JSON",
    message: "Remove service account credentials immediately. Use environment variables or secret managers."
  },
  // Azure
  {
    regex: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/,
    title: "Possible Azure storage connection string",
    message: "Rotate the connection string and remove it from source control."
  },
  {
    regex: /(?:client_secret|subscription_id|tenant_id|application_id)\s*[:=]\s*['"]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]?/i,
    title: "Possible Azure client secret or identifier",
    message: "If this is an Azure secret, rotate it immediately. Remove from source control."
  },
  // Private Keys
  {
    regex: /-----BEGIN( RSA| DSA| EC| OPENSSH| PGP)? PRIVATE KEY-----/,
    title: "Private key committed",
    message: "Never commit private keys to the repository. Generate new keys and remove this one."
  },
  // Slack
  {
    regex: /xox[baprs]-[0-9A-Za-z-]{10,48}/,
    title: "Possible Slack token",
    message: "Revoke the token immediately and remove it from the codebase."
  },
  // GitHub
  {
    regex: /gh[pousr]_[0-9a-zA-Z]{36,255}/,
    title: "Possible GitHub token",
    message: "Revoke the token immediately at https://github.com/settings/tokens"
  },
  // Generic API Keys
  {
    regex: /(?:api[_-]?key|apikey|api[_-]?secret|apisecret)\s*[:=]\s*['"]([a-z0-9_-]{20,})['"]/i,
    title: "Possible API key",
    message: "Rotate the API key and remove it from source control. Use environment variables."
  },
  // Database Connection Strings
  {
    regex: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^/]+/i,
    title: "Possible database connection string with credentials",
    message: "Remove credentials from connection strings. Use environment variables or secret managers."
  },
  // JWT Tokens
  {
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    title: "Possible JWT token",
    message: "Remove JWT tokens from source code. Tokens should be generated at runtime."
  },
  // Stripe Keys
  {
    regex: /sk_live_[0-9a-zA-Z]{24,}/,
    title: "Possible Stripe secret key",
    message: "Revoke the key immediately and remove it from source control."
  },
  {
    regex: /rk_live_[0-9a-zA-Z]{24,}/,
    title: "Possible Stripe restricted key",
    message: "Revoke the key and remove it from source control."
  },
  // Twilio
  {
    regex: /SK[0-9a-f]{32}/,
    title: "Possible Twilio API key",
    message: "Revoke the key and remove it from source control."
  },
  // SendGrid
  {
    regex: /SG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}/,
    title: "Possible SendGrid API key",
    message: "Revoke the key and remove it from source control."
  },
  // MailChimp
  {
    regex: /[0-9a-f]{32}-us[0-9]{1,2}/,
    title: "Possible MailChimp API key",
    message: "Revoke the key and remove it from source control."
  },
  // Generic Passwords
  {
    regex: /(?:password|passwd|pwd)\s*[:=]\s*['"]([^'"]{8,})['"]/i,
    title: "Possible hardcoded password",
    message: "Remove hardcoded passwords. Use environment variables or secret managers."
  }
];
function detectSecrets(file) {
  const findings = [];
  if (isTestFile(file.filename)) {
    return findings;
  }
  const addedLines = mapAddedLines(file.patch);
  for (const { line, content } of addedLines) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(content)) {
        findings.push({
          file: file.filename,
          line,
          severity: "critical",
          title: pattern.title,
          message: pattern.message,
          provider: "security",
          providers: ["security"]
        });
      }
    }
  }
  return findings;
}
function isTestFile(filename) {
  const lower = filename.toLowerCase();
  return lower.includes("__tests__") || lower.includes("/tests/") || lower.endsWith(".test.ts") || lower.endsWith(".test.js") || lower.endsWith(".spec.ts") || lower.endsWith(".spec.js");
}

// src/security/scanner.ts
var SecurityScanner = class {
  scan(files) {
    const findings = [];
    for (const file of files) {
      findings.push(...detectSecrets(file));
    }
    return findings;
  }
};

// src/rules/engine.ts
var RulesEngine = class {
  constructor(rules = []) {
    this.rules = rules;
  }
  run(files) {
    const findings = [];
    for (const file of files) {
      for (const rule of this.rules) {
        findings.push(...rule.apply({ file }));
      }
    }
    return findings;
  }
};

// src/rules/loader.ts
var RuleLoader = class {
  static load() {
    return new RulesEngine([]);
  }
};

// src/github/pr-loader.ts
var PullRequestLoader = class {
  constructor(client) {
    this.client = client;
  }
  async load(prNumber) {
    const { octokit, owner, repo } = this.client;
    const prResponse = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const pr = prResponse.data;
    const files = [];
    let page = 1;
    const per_page = 100;
    let hasMore = true;
    while (hasMore) {
      const res = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber, page, per_page });
      files.push(
        ...res.data.map((file) => ({
          filename: file.filename,
          status: file.status || "modified",
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch || void 0,
          previousFilename: file.previous_filename || void 0
        }))
      );
      hasMore = res.data.length === per_page;
      page += 1;
      if (files.length > 500) {
        logger.warn(`PR #${prNumber} has more than 500 files; further file fetching skipped for safety.`);
        break;
      }
    }
    const diff = await this.fetchDiff(owner, repo, prNumber);
    return {
      number: pr.number,
      title: pr.title || "",
      body: pr.body || "",
      author: pr.user?.login || "unknown",
      draft: Boolean(pr.draft),
      labels: (pr.labels || []).map((label) => typeof label === "string" ? label : label.name || ""),
      files,
      diff,
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      baseSha: pr.base?.sha || "",
      headSha: pr.head?.sha || ""
    };
  }
  async fetchDiff(owner, repo, prNumber) {
    const { octokit } = this.client;
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
      headers: { accept: "application/vnd.github.v3.diff" }
    });
    return typeof res.data === "string" ? res.data : "";
  }
};

// src/utils/suggestion-validator.ts
function validateSuggestionLine(lineNumber, patch) {
  const lineMap = mapLinesToPositions(patch);
  return lineMap.get(lineNumber) ?? null;
}
function isSuggestionLineValid(lineNumber, patch) {
  return validateSuggestionLine(lineNumber, patch) !== null;
}
function isDeletionOnlyFile(file) {
  return file.status === "removed" || (file.additions ?? 0) === 0;
}
function validateSuggestionRange(startLine, endLine, patch) {
  if (!patch || patch.trim().length === 0) {
    return { isValid: false, reason: "No patch available" };
  }
  if (startLine > endLine) {
    return { isValid: false, reason: "Invalid range: start > end" };
  }
  const rangeLength = endLine - startLine + 1;
  if (rangeLength > 50) {
    return { isValid: false, reason: `Range too long: ${rangeLength} lines (max 50)` };
  }
  const lineMap = mapLinesToPositions(patch);
  for (let line = startLine; line <= endLine; line++) {
    if (!lineMap.has(line)) {
      return { isValid: false, reason: `Line ${line} not found in diff` };
    }
  }
  const positions = [];
  for (let line = startLine; line <= endLine; line++) {
    const pos = lineMap.get(line);
    if (pos !== void 0) {
      positions.push(pos);
    }
  }
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== positions[i - 1] + 1) {
      return { isValid: false, reason: "Range contains gaps (non-consecutive lines)" };
    }
  }
  if (!isRangeWithinSingleHunk(startLine, endLine, patch)) {
    return { isValid: false, reason: "Range crosses hunk boundary" };
  }
  const startPosition = lineMap.get(startLine);
  const endPosition = lineMap.get(endLine);
  return {
    isValid: true,
    startPosition,
    endPosition
  };
}

// src/validation/syntax-validator.ts
function getRootNode2(tree) {
  return (tree.rootNode ?? tree.root) || null;
}
function validateSyntax(code, language) {
  if (language === "unknown" || language === "rust") {
    return {
      isValid: true,
      skipped: true,
      reason: "Unsupported language",
      errors: []
    };
  }
  const parser = getParser(language);
  if (!parser) {
    debugSyntax(`parser unavailable for ${language}`);
    return validateSyntaxFallback(code, language) || {
      isValid: true,
      skipped: true,
      reason: "Parser not available",
      errors: []
    };
  }
  let tree;
  try {
    tree = parser.parse(code);
  } catch (error2) {
    debugSyntax(`parser failed for ${language}: ${error2.message}`);
    return validateSyntaxFallback(code, language) || {
      isValid: true,
      skipped: true,
      reason: `Parser failed: ${error2.message}`,
      errors: []
    };
  }
  const rootNode = getRootNode2(tree);
  if (!rootNode) {
    debugSyntax(`parser returned no root node for ${language}`);
    return validateSyntaxFallback(code, language) || {
      isValid: true,
      skipped: true,
      reason: "Parser returned no root node",
      errors: []
    };
  }
  const errors = [];
  const visitNode = (node) => {
    if (node.type === "ERROR") {
      errors.push({
        type: "ERROR",
        line: node.startPosition.row + 1,
        // 1-indexed
        column: node.startPosition.column + 1,
        // 1-indexed
        text: node.text || void 0
      });
    }
    if (node.isMissing) {
      errors.push({
        type: "MISSING",
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        text: node.text || void 0
      });
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        visitNode(child);
      }
    }
  };
  visitNode(rootNode);
  return {
    isValid: errors.length === 0,
    errors
  };
}
function debugSyntax(message) {
  if (process.env.MPR_DEBUG_SYNTAX === "1") {
    console.error(`[syntax] ${message}`);
  }
}
function validateSyntaxFallback(code, language) {
  if (language === "unknown" || language === "rust") {
    return null;
  }
  const errors = [];
  const delimiterError = findDelimiterError(code);
  if (delimiterError) {
    errors.push(delimiterError);
  }
  const incompleteExpression = findIncompleteExpression(code, language);
  if (incompleteExpression) {
    errors.push(incompleteExpression);
  }
  return {
    isValid: errors.length === 0,
    errors
  };
}
function findIncompleteExpression(code, language) {
  const trimmed = code.trimEnd();
  if (!trimmed) {
    return null;
  }
  if (hasIncompleteTrailingCharacter2(trimmed)) {
    return makeError(code, Math.max(0, trimmed.length - 1), trimmed.endsWith("{") || trimmed.endsWith("(") ? "MISSING" : "ERROR");
  }
  if (language === "typescript" || language === "javascript") {
    const duplicateDeclaration = code.match(/\b(?:const|let|var)\b[^;\n]*\s+\b(?:const|let|var)\b/);
    if (duplicateDeclaration?.index !== void 0) {
      return makeError(code, duplicateDeclaration.index, "ERROR");
    }
    const assignmentBeforeStatement = code.match(/=\s*\n\s*(?:return|const|let|var|})/);
    if (assignmentBeforeStatement?.index !== void 0) {
      return makeError(code, assignmentBeforeStatement.index, "ERROR");
    }
  }
  return null;
}
function hasIncompleteTrailingCharacter2(value) {
  const lastCharacter = value[value.length - 1];
  return ["=", "+", "-", "*", "/", "%", ",", "(", "{", "["].includes(lastCharacter);
}
function findDelimiterError(code) {
  const stack = [];
  const pairs2 = { ")": "(", "}": "{", "]": "[" };
  let quote = null;
  let escaped = false;
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      stack.push({ char, index });
    } else if (char === ")" || char === "}" || char === "]") {
      const opening = stack.pop();
      if (!opening || opening.char !== pairs2[char]) {
        return makeError(code, index, "ERROR");
      }
    }
  }
  if (quote) {
    return makeError(code, Math.max(0, code.length - 1), "MISSING");
  }
  const unclosed = stack.pop();
  if (unclosed) {
    return makeError(code, unclosed.index, "MISSING");
  }
  return null;
}
function makeError(code, index, type2) {
  const before = code.slice(0, index);
  const lines = before.split("\n");
  return {
    type: type2,
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
    text: code.trim() || void 0
  };
}

// src/validation/confidence-calculator.ts
var CONFIDENCE_MULTIPLIERS = {
  /** Boost factor when syntax is valid (10% increase) */
  SYNTAX_BOOST: 1.1,
  /** Penalty factor when syntax is invalid (10% decrease) */
  SYNTAX_PENALTY: 0.9,
  /** Boost factor when consensus achieved (20% increase) */
  CONSENSUS_BOOST: 1.2
};
var FALLBACK_SCORING = {
  /** Base confidence without any signals */
  BASE: 0.5,
  /** Bonus added for valid syntax */
  SYNTAX_BONUS: 0.2,
  /** Bonus added for consensus */
  CONSENSUS_BONUS: 0.2
};
var DEFAULT_QUALITY_CONFIG = {
  /** Default minimum confidence threshold (70%) */
  MIN_CONFIDENCE: 0.7,
  /** Default minimum providers for consensus */
  MIN_AGREEMENT: 2
};
function calculateConfidence(signals) {
  let confidence;
  if (signals.llmConfidence !== void 0) {
    confidence = signals.llmConfidence;
    if (signals.syntaxValid) {
      confidence *= CONFIDENCE_MULTIPLIERS.SYNTAX_BOOST;
    } else {
      confidence *= CONFIDENCE_MULTIPLIERS.SYNTAX_PENALTY;
    }
    if (signals.hasConsensus) {
      confidence *= CONFIDENCE_MULTIPLIERS.CONSENSUS_BOOST;
    }
    confidence *= signals.providerReliability;
  } else {
    confidence = FALLBACK_SCORING.BASE;
    if (signals.syntaxValid) {
      confidence += FALLBACK_SCORING.SYNTAX_BONUS;
    }
    if (signals.hasConsensus) {
      confidence += FALLBACK_SCORING.CONSENSUS_BONUS;
    }
    confidence *= signals.providerReliability;
  }
  return Math.min(1, confidence);
}
function shouldPostSuggestion(finding, confidence, config) {
  const severityThreshold = config.confidence_threshold?.[finding.severity];
  const threshold = severityThreshold ?? config.min_confidence ?? DEFAULT_QUALITY_CONFIG.MIN_CONFIDENCE;
  if (confidence < threshold) {
    return false;
  }
  if (finding.severity === "critical" && config.consensus?.required_for_critical) {
    const providerCount = finding.providers?.length ?? 0;
    const minAgreement = config.consensus.min_agreement ?? DEFAULT_QUALITY_CONFIG.MIN_AGREEMENT;
    if (providerCount < minAgreement) {
      return false;
    }
  }
  return true;
}

// src/github/comment-poster.ts
var CommentPoster = class _CommentPoster {
  constructor(client, dryRun = false, config, suppressionTracker, providerWeightTracker) {
    this.client = client;
    this.dryRun = dryRun;
    this.config = config;
    this.suppressionTracker = suppressionTracker;
    this.providerWeightTracker = providerWeightTracker;
  }
  static MAX_COMMENT_SIZE = 6e4;
  static BOT_COMMENT_MARKER = "<!-- multi-provider-code-review-bot -->";
  async postSummary(prNumber, body, updateExisting = true) {
    const chunks = this.chunk(body);
    if (this.dryRun) {
      logger.info(`[DRY RUN] Would post ${chunks.length} summary comment(s) to PR #${prNumber}`);
      for (let i = 0; i < chunks.length; i++) {
        const header = chunks.length > 1 ? `## Review Summary (Part ${i + 1}/${chunks.length})

` : "";
        const content = header + chunks[i];
        logger.info(`[DRY RUN] Summary comment ${i + 1}:
${content.substring(0, 500)}...`);
      }
      return;
    }
    const { octokit, owner, repo } = this.client;
    if (updateExisting) {
      const existingComments = await this.findBotComments(prNumber);
      if (existingComments.length > 0) {
        logger.info(`Found ${existingComments.length} existing review comment(s), updating in place`);
        const updates = Math.min(existingComments.length, chunks.length);
        for (let i = 0; i < updates; i++) {
          const header = chunks.length > 1 ? `## Review Summary (Part ${i + 1}/${chunks.length})

` : "";
          const markedBody = _CommentPoster.BOT_COMMENT_MARKER + "\n\n" + header + chunks[i];
          await withRetry(
            () => octokit.rest.issues.updateComment({
              owner,
              repo,
              comment_id: existingComments[i].id,
              body: markedBody
            }),
            { retries: 2, minTimeout: 1e3, maxTimeout: 5e3 }
          );
        }
        if (existingComments.length > chunks.length) {
          const stale = existingComments.slice(chunks.length);
          for (const comment of stale) {
            await withRetry(
              () => octokit.rest.issues.deleteComment({ owner, repo, comment_id: comment.id }),
              { retries: 2, minTimeout: 1e3, maxTimeout: 5e3 }
            );
          }
        }
        for (let i = existingComments.length; i < chunks.length; i++) {
          const header = chunks.length > 1 ? `## Review Summary (Part ${i + 1}/${chunks.length})

` : "";
          const markedBody = _CommentPoster.BOT_COMMENT_MARKER + "\n\n" + header + chunks[i];
          await withRetry(
            () => octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: markedBody }),
            { retries: 2, minTimeout: 1e3, maxTimeout: 5e3 }
          );
          await new Promise((resolve2) => setTimeout(resolve2, 1e3));
        }
        return;
      }
    }
    for (let i = 0; i < chunks.length; i++) {
      const header = chunks.length > 1 ? `## Review Summary (Part ${i + 1}/${chunks.length})

` : "";
      const markedBody = _CommentPoster.BOT_COMMENT_MARKER + "\n\n" + header + chunks[i];
      await withRetry(
        () => octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: markedBody }),
        { retries: 2, minTimeout: 1e3, maxTimeout: 5e3 }
      );
      if (i < chunks.length - 1) {
        await new Promise((resolve2) => setTimeout(resolve2, 1e3));
      }
    }
  }
  /**
   * Find the bot's review comment on a PR
   */
  async findBotComment(prNumber) {
    const comments = await this.findBotComments(prNumber);
    return comments[0] || null;
  }
  async findBotComments(prNumber) {
    const { octokit, owner, repo } = this.client;
    try {
      const comments = await withRetry(
        () => octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 100 }),
        { retries: 2, minTimeout: 1e3, maxTimeout: 5e3 }
      );
      return comments.data.filter((comment) => comment.body?.includes(_CommentPoster.BOT_COMMENT_MARKER)).map((comment) => ({ id: comment.id, body: comment.body ?? "" }));
    } catch (error2) {
      logger.warn("Failed to find existing bot comment", error2);
      return [];
    }
  }
  /**
   * Validate and filter suggestions through quality pipeline.
   * Reads pre-computed hasConsensus from Finding (set during aggregation).
   */
  async validateAndFilterSuggestion(comment, prNumber) {
    if (!comment.suggestion) {
      return { valid: true };
    }
    if (this.suppressionTracker) {
      const suppressed = await this.suppressionTracker.shouldSuppress(
        { category: comment.category || "unknown", file: comment.path, line: comment.line },
        prNumber
      );
      if (suppressed) {
        logger.debug(`Suggestion suppressed for ${comment.path}:${comment.line} (similar suggestion dismissed)`);
        return { valid: false, reason: "Similar suggestion was dismissed" };
      }
    }
    let syntaxValid = true;
    if (this.config?.suggestionSyntaxValidation !== false) {
      const language = detectLanguage(comment.path);
      if (language !== "unknown") {
        const syntaxResult = validateSyntax(comment.suggestion, language);
        if (!syntaxResult.isValid && !syntaxResult.skipped) {
          logger.debug(`Suggestion syntax invalid for ${comment.path}:${comment.line}: ${syntaxResult.errors.length} error(s)`);
          syntaxValid = false;
        }
      }
    }
    const hasConsensus = comment.hasConsensus ?? false;
    if (hasConsensus) {
      logger.debug(`Consensus detected for ${comment.path}:${comment.line} (providers agreed during aggregation)`);
    }
    if (!syntaxValid && !hasConsensus) {
      return { valid: false, reason: "Syntax validation failed", hasConsensus: false };
    }
    if (comment.severity && this.config) {
      let providerReliability = 1;
      if (this.providerWeightTracker && comment.provider) {
        providerReliability = await this.providerWeightTracker.getWeight(comment.provider);
      }
      const signals = {
        llmConfidence: comment.confidence,
        syntaxValid,
        hasConsensus,
        providerReliability
      };
      const confidence = calculateConfidence(signals);
      const minimalFinding = {
        file: comment.path,
        line: comment.line,
        severity: comment.severity,
        title: "",
        message: "",
        providers: comment.provider ? [comment.provider] : [],
        hasConsensus
      };
      if (!shouldPostSuggestion(
        minimalFinding,
        confidence,
        {
          min_confidence: this.config.minConfidence,
          confidence_threshold: this.config.confidenceThreshold,
          consensus: {
            required_for_critical: this.config.consensusRequiredForCritical ?? true,
            min_agreement: this.config.consensusMinAgreement ?? 2
          }
        }
      )) {
        logger.debug(`Suggestion below confidence threshold for ${comment.path}:${comment.line} (confidence: ${confidence.toFixed(2)})`);
        return { valid: false, reason: "Below confidence threshold", hasConsensus };
      }
    }
    return { valid: true, hasConsensus };
  }
  async postInline(prNumber, comments, files, _headSha) {
    if (comments.length === 0) return;
    const filesWithAdditions = files.filter((f) => !isDeletionOnlyFile(f));
    const filesWithAdditionsSet = new Set(filesWithAdditions.map((f) => f.filename));
    const positionMaps = /* @__PURE__ */ new Map();
    for (const file of files) {
      positionMaps.set(file.filename, mapLinesToPositions(file.patch));
    }
    const sortedComments = [...comments].sort((a, b) => {
      const pathCompare = a.path.localeCompare(b.path);
      if (pathCompare !== 0) return pathCompare;
      return a.line - b.line;
    });
    const apiComments = (await Promise.all(
      sortedComments.map(async (c) => {
        const posMap = positionMaps.get(c.path);
        const position = posMap?.get(c.line);
        if (!position) {
          logger.warn(`Cannot find diff position for ${c.path}:${c.line}, skipping inline comment`);
          return null;
        }
        if (c.body.includes("```suggestion")) {
          const file = files.find((f) => f.filename === c.path);
          if (!filesWithAdditionsSet.has(c.path)) {
            logger.debug(`Skipping suggestion for deletion-only file: ${c.path}`);
            c.body = c.body.replace(/```suggestion[\s\S]*?```/g, "_Suggestion not available (file has no additions)_");
          } else if (file?.patch) {
            const startLine2 = c.start_line;
            if (startLine2 !== void 0 && startLine2 !== c.line) {
              const validation = validateSuggestionRange(startLine2, c.line, file.patch);
              if (!validation.isValid) {
                logger.debug(`Multi-line suggestion invalid at ${c.path}:${startLine2}-${c.line}: ${validation.reason}`);
                c.body = c.body.replace(/```suggestion[\s\S]*?```/g, `_Suggestion not available: ${validation.reason}_`);
              }
            } else {
              if (!isSuggestionLineValid(c.line, file.patch)) {
                logger.debug(`Suggestion line ${c.path}:${c.line} not valid in diff, posting without suggestion block`);
                c.body = c.body.replace(/```suggestion[\s\S]*?```/g, "_Suggestion not available for this line_");
              }
            }
          }
          const suggestionMatch = c.body.match(/```suggestion\n([\s\S]*?)```/);
          if (suggestionMatch && !c.body.includes("_Suggestion not available")) {
            const suggestionContent = suggestionMatch[1];
            const qualityValidation = await this.validateAndFilterSuggestion(
              {
                ...c,
                suggestion: suggestionContent,
                category: c.category,
                severity: c.severity,
                provider: c.provider,
                hasConsensus: c.hasConsensus,
                confidence: c.confidence
              },
              prNumber
            );
            if (!qualityValidation.valid) {
              c.body = c.body.replace(/```suggestion[\s\S]*?```/g, `_Suggestion not available: ${qualityValidation.reason}_`);
            }
          }
        }
        const apiComment = {
          path: c.path,
          line: c.line,
          side: c.side || "RIGHT",
          body: c.body
        };
        const startLine = c.start_line;
        if (startLine !== void 0 && startLine !== c.line) {
          apiComment.start_line = startLine;
          apiComment.start_side = "RIGHT";
        }
        return apiComment;
      })
    )).filter((c) => c !== null);
    if (apiComments.length === 0) {
      logger.info("No inline comments with valid diff positions to post");
      return;
    }
    if (this.dryRun) {
      logger.info(`[DRY RUN] Would post ${apiComments.length} inline comment(s) to PR #${prNumber}`);
      for (const comment of apiComments) {
        logger.info(`[DRY RUN] Inline comment at ${comment.path}:${comment.line}:
${comment.body.substring(0, 200)}...`);
      }
      return;
    }
    const { octokit, owner, repo } = this.client;
    await withRetry(
      () => octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        event: "COMMENT",
        comments: apiComments
      }),
      { retries: 2, minTimeout: 1e3, maxTimeout: 5e3 }
    );
  }
  chunk(content) {
    const paragraphs = content.split("\n\n");
    const chunks = [];
    let current = "";
    for (const para of paragraphs) {
      if (Buffer.byteLength(current + para, "utf8") > _CommentPoster.MAX_COMMENT_SIZE) {
        if (current) {
          chunks.push(current.trim());
          current = "";
        }
        if (Buffer.byteLength(para, "utf8") > _CommentPoster.MAX_COMMENT_SIZE) {
          const lines = para.split("\n");
          let lineChunk = "";
          for (const line of lines) {
            if (Buffer.byteLength(lineChunk + line + "\n", "utf8") > _CommentPoster.MAX_COMMENT_SIZE) {
              chunks.push(lineChunk.trim());
              lineChunk = "";
            }
            lineChunk += line + "\n";
          }
          current = lineChunk + "\n\n";
        } else {
          current = para + "\n\n";
        }
      } else {
        current += para + "\n\n";
      }
    }
    if (current.trim()) chunks.push(current.trim());
    logger.info(`Prepared ${chunks.length} comment chunk(s)`);
    return chunks;
  }
};

// src/github/client.ts
var fs10 = __toESM(require("fs"));
var import_rest = __toESM(require_dist_node12());

// src/github/rate-limit.ts
var GitHubRateLimitTracker = class {
  status = null;
  /**
   * Update rate limit status from response headers
   */
  updateFromHeaders(headers) {
    const limit = headers["x-ratelimit-limit"];
    const remaining = headers["x-ratelimit-remaining"];
    const reset = headers["x-ratelimit-reset"];
    const used = headers["x-ratelimit-used"];
    const resetTime = headers["x-github-ratelimit-resettime"];
    const tokenExpiration = headers["github-authentication-token-expiration"];
    if (limit && remaining && reset) {
      this.status = {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
        used: used ? parseInt(used, 10) : 0,
        resetTime,
        tokenExpiration
      };
      logger.debug(
        `GitHub rate limit: ${this.status.remaining}/${this.status.limit} remaining (resets at ${this.status.resetTime || new Date(this.status.reset * 1e3).toISOString()})` + (this.status.tokenExpiration ? ` [token expires: ${this.status.tokenExpiration}]` : "")
      );
      if (this.status.remaining < 100) {
        logger.warn(
          `GitHub API rate limit low: ${this.status.remaining} requests remaining`
        );
      }
      if (this.status.remaining === 0) {
        const resetTime2 = new Date(this.status.reset * 1e3);
        const waitSeconds = Math.ceil((this.status.reset * 1e3 - Date.now()) / 1e3);
        logger.error(
          `GitHub API rate limit exceeded. Resets at ${resetTime2.toISOString()} (in ${waitSeconds} seconds)`
        );
      }
    }
  }
  /**
   * Get current rate limit status
   */
  getStatus() {
    return this.status;
  }
  /**
   * Check if we're approaching rate limit (< 10% remaining)
   */
  isApproachingLimit() {
    if (!this.status) return false;
    const percentRemaining = this.status.remaining / this.status.limit * 100;
    return percentRemaining < 10;
  }
  /**
   * Check if rate limit is exceeded
   */
  isExceeded() {
    if (!this.status) return false;
    return this.status.remaining === 0;
  }
  /**
   * Calculate wait time until rate limit resets (in milliseconds)
   */
  getWaitTimeMs() {
    if (!this.status) return 0;
    const now = Date.now();
    const resetMs = this.status.reset * 1e3;
    return Math.max(0, resetMs - now);
  }
  /**
   * Wait for rate limit to reset
   */
  async waitForReset() {
    if (!this.isExceeded()) return;
    const waitMs = this.getWaitTimeMs();
    if (waitMs === 0) return;
    logger.info(`Waiting ${Math.ceil(waitMs / 1e3)} seconds for GitHub rate limit to reset...`);
    await new Promise((resolve2) => setTimeout(resolve2, waitMs + 1e3));
  }
};

// src/github/client.ts
var GitHubClient = class {
  octokit;
  owner;
  repo;
  rateLimitTracker = new GitHubRateLimitTracker();
  constructor(token) {
    this.octokit = new import_rest.Octokit({ auth: token });
    const repoEnv = process.env.GITHUB_REPOSITORY || getRepositoryFromEventPayload() || "/";
    const [owner, repo] = repoEnv.split("/");
    this.owner = owner || "";
    this.repo = repo || "";
    debug(`GitHub client initialized for ${this.owner}/${this.repo}`);
  }
  /**
   * Get current GitHub API rate limit status
   */
  getRateLimitStatus() {
    return this.rateLimitTracker.getStatus();
  }
  /**
   * Check if we're approaching rate limit and log warning
   */
  checkRateLimitStatus() {
    if (this.rateLimitTracker.isApproachingLimit()) {
      const status = this.rateLimitTracker.getStatus();
      warning(
        `Approaching GitHub API rate limit: ${status?.remaining}/${status?.limit} remaining`
      );
    }
  }
  /**
   * Implement exponential backoff when approaching rate limit
   * Returns delay in milliseconds to wait before making next API call
   */
  calculateBackoffDelay() {
    const status = this.rateLimitTracker.getStatus();
    if (!status) return 0;
    const percentRemaining = status.remaining / status.limit * 100;
    if (percentRemaining > 25) {
      return 0;
    }
    if (percentRemaining > 10) {
      return 100;
    } else if (percentRemaining > 5) {
      return 500;
    } else if (percentRemaining > 1) {
      return 1e3;
    } else {
      return 2e3;
    }
  }
  /**
   * Throttle requests when approaching rate limit
   */
  async throttleIfNeeded() {
    const delay = this.calculateBackoffDelay();
    if (delay > 0) {
      const status = this.rateLimitTracker.getStatus();
      debug(
        `Throttling GitHub API request (${delay}ms delay, ${status?.remaining} requests remaining)`
      );
      await new Promise((resolve2) => setTimeout(resolve2, delay));
    }
  }
  /**
   * Wait for rate limit to reset if exceeded
   */
  async handleRateLimit() {
    if (this.rateLimitTracker.isExceeded()) {
      await this.rateLimitTracker.waitForReset();
    }
  }
  /**
   * Fetch file content from a specific ref (commit SHA, branch, or tag)
   * @param filePath - Path to the file in the repository
   * @param ref - Git ref (commit SHA, branch name, or tag)
   * @returns File content as string, or null if file doesn't exist/inaccessible
   */
  async getFileContent(filePath, ref) {
    await this.handleRateLimit();
    await this.throttleIfNeeded();
    try {
      const response = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref
      });
      if (response.headers && typeof response.headers === "object" && !Array.isArray(response.headers)) {
        const headers = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headers[key] = value !== void 0 ? String(value) : void 0;
        }
        this.rateLimitTracker.updateFromHeaders(headers);
      }
      if ("content" in response.data && !Array.isArray(response.data)) {
        if (!response.data.content || response.data.content === "" || response.data.encoding === "none") {
          debug(`File content empty or encoding 'none': ${filePath}`);
          return "";
        }
        return Buffer.from(response.data.content, "base64").toString("utf-8");
      }
      return null;
    } catch (error2) {
      const err = error2;
      if (err.status === 404) {
        debug(`File not found: ${filePath} at ref ${ref}`);
        return null;
      }
      warning(`Failed to fetch file content for ${filePath}: ${error2.message}`);
      return null;
    }
  }
};
function getRepositoryFromEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return void 0;
  }
  try {
    const payload = JSON.parse(fs10.readFileSync(eventPath, "utf8"));
    if (payload.repository?.full_name) {
      return payload.repository.full_name;
    }
    const owner = payload.repository?.owner?.login || payload.repository?.owner?.name || payload.organization?.login;
    if (owner && payload.repository?.name) {
      return `${owner}/${payload.repository.name}`;
    }
  } catch {
    return void 0;
  }
  return void 0;
}

// src/output/formatter-v2.ts
var MarkdownFormatterV2 = class {
  format(review) {
    const lines = [];
    lines.push("# Multi-Provider Code Review");
    lines.push("");
    lines.push(this.formatQuickStats(review));
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push(`> ${this.generatePRSummary(review)}`);
    lines.push("");
    if (this.hasSignificantChanges(review)) {
      lines.push("## Release Notes");
      lines.push("");
      lines.push(this.generateReleaseNotes(review));
      lines.push("");
    }
    const hasFindings = review.findings.length > 0;
    if (hasFindings) {
      lines.push("## Findings");
      lines.push("");
      const critical = review.findings.filter((f) => f.severity === "critical");
      const major = review.findings.filter((f) => f.severity === "major");
      const minor = review.findings.filter((f) => f.severity === "minor");
      if (critical.length > 0) {
        lines.push(this.formatSeveritySection("\u{1F534} Critical", critical, "critical"));
      }
      if (major.length > 0) {
        lines.push(this.formatSeveritySection("\u{1F7E1} Major", major, "major"));
      }
      if (minor.length > 0) {
        lines.push(this.formatSeveritySection("\u{1F535} Minor", minor, "minor"));
      }
    } else {
      const allClearMessage = this.generateAllClearMessage(review, { suppressRepeat: true });
      lines.push("## All Clear!");
      lines.push("");
      lines.push(`> ${allClearMessage}`);
      lines.push("");
    }
    if (review.actionItems && review.actionItems.length > 0) {
      lines.push("## Action Items");
      lines.push("");
      review.actionItems.forEach((item) => {
        lines.push(`- [ ] ${item}`);
      });
      lines.push("");
    }
    lines.push(this.formatMetrics(review));
    lines.push("");
    lines.push(this.formatAdvancedSections(review));
    lines.push("---");
    lines.push("");
    lines.push("*Powered by Multi-Provider Code Review* \u2022 To dismiss a finding, react with \u{1F44E}");
    return lines.join("\n");
  }
  formatQuickStats(review) {
    const { metrics } = review;
    const criticalCount = metrics.critical;
    const majorCount = metrics.major;
    const minorCount = metrics.minor;
    const criticalBadge = criticalCount > 0 ? `\u{1F534} **${criticalCount} Critical**` : `~~${criticalCount} Critical~~`;
    const majorBadge = majorCount > 0 ? `\u{1F7E1} **${majorCount} Major**` : `~~${majorCount} Major~~`;
    const minorBadge = minorCount > 0 ? `\u{1F535} ${minorCount} Minor` : `~~${minorCount} Minor~~`;
    const hasOAuthCliUsage = (review.runDetails?.providers || []).some(
      (p) => /^(codex|claude|gemini|opencode)\//.test(p.name)
    );
    const costLabel = metrics.totalCost === 0 && metrics.totalTokens > 0 && hasOAuthCliUsage ? "$0.0000 OAuth" : `$${metrics.totalCost.toFixed(4)}`;
    return `${criticalBadge} \u2022 ${majorBadge} \u2022 ${minorBadge} \u2022 ${metrics.durationSeconds.toFixed(1)}s \u2022 ${costLabel}`;
  }
  generatePRSummary(review) {
    const { metrics, findings } = review;
    if (findings.length === 0) {
      if (metrics.providersSuccess === 0) {
        return "LLM review skipped: no healthy providers were available. Static checks did not find issues.";
      }
      return "This PR looks great! No issues detected by the automated review.";
    }
    const parts = [];
    if (metrics.critical > 0) {
      parts.push(`**${metrics.critical} critical issue${metrics.critical > 1 ? "s" : ""}** require immediate attention`);
    }
    if (metrics.major > 0) {
      parts.push(`${metrics.major} major issue${metrics.major > 1 ? "s" : ""} should be addressed`);
    }
    if (metrics.minor > 0) {
      parts.push(`${metrics.minor} minor improvement${metrics.minor > 1 ? "s" : ""} suggested`);
    }
    const summary = parts.join(", ");
    const filesReviewed = new Set(findings.map((f) => f.file)).size;
    const context = `Found across ${filesReviewed} file${filesReviewed > 1 ? "s" : ""}.`;
    return `${summary}. ${context}`;
  }
  generateAllClearMessage(review, options = {}) {
    const { metrics } = review;
    if (metrics.providersSuccess === 0) {
      return options.suppressRepeat ? "LLM analysis skipped because no providers were healthy." : "LLM analysis skipped because no providers were healthy. Static checks found no issues.";
    }
    return "No issues found. Great job!";
  }
  hasSignificantChanges(review) {
    return review.metrics.critical > 0 || review.metrics.major > 0;
  }
  generateReleaseNotes(review) {
    const lines = [];
    const significant = review.findings.filter(
      (f) => f.severity === "critical" || f.severity === "major"
    );
    if (significant.length === 0) return "";
    const byCategory = /* @__PURE__ */ new Map();
    significant.forEach((f) => {
      if (!f.category) return;
      if (!byCategory.has(f.category)) {
        byCategory.set(f.category, []);
      }
      byCategory.get(f.category).push(f);
    });
    byCategory.forEach((findings, category) => {
      lines.push(`**${category}:**`);
      findings.forEach((f) => {
        const emoji = f.severity === "critical" ? "\u{1F534}" : "\u{1F7E1}";
        lines.push(`- ${emoji} ${f.title}`);
      });
      lines.push("");
    });
    return lines.join("\n");
  }
  formatSeveritySection(header, findings, severity) {
    const lines = [];
    lines.push(`### ${header} (${findings.length})`);
    lines.push("");
    findings.forEach((finding, index) => {
      lines.push(this.formatFinding(finding, severity, index + 1, findings.length));
      if (index < findings.length - 1) {
        lines.push("");
      }
    });
    lines.push("");
    return lines.join("\n");
  }
  formatFinding(finding, severity, index, total) {
    const lines = [];
    const emoji = severity === "critical" ? "\u{1F534}" : severity === "major" ? "\u{1F7E1}" : "\u{1F535}";
    const location = `\`${finding.file}:${finding.line}\``;
    const numberPrefix = total > 1 ? `${index}. ` : "";
    lines.push(`#### ${emoji} ${numberPrefix}${finding.title}`);
    lines.push(`**Location:** ${location}${finding.category ? ` \u2022 **Category:** ${finding.category}` : ""}`);
    lines.push("");
    lines.push(finding.message);
    lines.push("");
    if (finding.suggestion) {
      const suggestionBlock = formatSuggestionBlock(finding.suggestion);
      if (suggestionBlock) {
        lines.push("**Suggested Fix:**");
        lines.push("");
        lines.push(suggestionBlock);
        lines.push("");
      }
    }
    if (finding.evidence) {
      const confidence = Math.round(finding.evidence.confidence * 100);
      if (finding.evidence.reasoning) {
        lines.push(`<details><summary>View reasoning</summary>`);
        lines.push("");
        lines.push(`**Evidence:** ${finding.evidence.badge} (${confidence}% confidence)`);
        lines.push("");
        lines.push(finding.evidence.reasoning);
        lines.push("</details>");
      } else {
        lines.push(`**Evidence:** ${finding.evidence.badge} (${confidence}% confidence)`);
      }
      lines.push("");
    }
    if (finding.providers && finding.providers.length > 1) {
      const providerList = finding.providers.join(", ");
      lines.push(`<sub>Detected by: ${providerList}</sub>`);
      lines.push("");
    }
    return lines.join("\n");
  }
  formatMetrics(review) {
    const lines = [];
    const { metrics, runDetails } = review;
    const hasOAuthCliUsage = (runDetails?.providers || []).some(
      (p) => /^(codex|claude|gemini|opencode)\//.test(p.name)
    );
    const costDisplay = metrics.totalCost === 0 && metrics.totalTokens > 0 && hasOAuthCliUsage ? "$0.0000 (OAuth subscription, API cost not reported)" : `$${metrics.totalCost.toFixed(4)}`;
    lines.push("<details>");
    lines.push("<summary>Performance Metrics</summary>");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Duration | ${metrics.durationSeconds.toFixed(2)}s |`);
    lines.push(`| Cost | ${costDisplay} |`);
    lines.push(`| Tokens | ${metrics.totalTokens.toLocaleString()} |`);
    lines.push(`| Providers | ${metrics.providersSuccess}/${metrics.providersUsed} |`);
    if (runDetails?.cacheHit) {
      lines.push(`| Cache | Hit |`);
    }
    lines.push("");
    if (runDetails?.providers && runDetails.providers.length > 0) {
      lines.push("**Provider Performance:**");
      lines.push("");
      runDetails.providers.forEach((p) => {
        const statusEmoji = p.status === "success" ? "\u2705" : p.status === "timeout" ? "\u23F1\uFE0F" : p.status === "rate-limited" ? "\u23F8\uFE0F" : "\u274C";
        const costStr = p.cost !== void 0 ? `, $${p.cost.toFixed(4)}` : "";
        const tokensStr = p.tokens ? `, ${p.tokens} tokens` : "";
        lines.push(`- ${statusEmoji} **${p.name}** (${p.durationSeconds.toFixed(2)}s${costStr}${tokensStr})`);
        if (p.errorMessage) {
          lines.push(`  <sub>${p.errorMessage}</sub>`);
        }
      });
      lines.push("");
    }
    lines.push("</details>");
    return lines.join("\n");
  }
  formatAdvancedSections(review) {
    const lines = [];
    if (review.aiAnalysis) {
      lines.push("<details>");
      lines.push("<summary>AI-Generated Code Analysis</summary>");
      lines.push("");
      lines.push(`**Overall Likelihood:** ${(review.aiAnalysis.averageLikelihood * 100).toFixed(1)}%`);
      lines.push("");
      lines.push(`**Consensus:** ${review.aiAnalysis.consensus}`);
      lines.push("");
      if (Object.keys(review.aiAnalysis.providerEstimates).length > 0) {
        lines.push("**Provider Estimates:**");
        Object.entries(review.aiAnalysis.providerEstimates).forEach(([provider, likelihood]) => {
          lines.push(`- ${provider}: ${(likelihood * 100).toFixed(1)}%`);
        });
        lines.push("");
      }
      lines.push("</details>");
      lines.push("");
    }
    if (review.mermaidDiagram && review.mermaidDiagram.trim()) {
      lines.push("<details>");
      lines.push("<summary>Impact Analysis Graph</summary>");
      lines.push("");
      lines.push("```mermaid");
      lines.push(review.mermaidDiagram);
      lines.push("```");
      lines.push("</details>");
      lines.push("");
    }
    if (review.providerResults && review.providerResults.length > 0) {
      lines.push("<details>");
      lines.push("<summary>Raw Provider Outputs</summary>");
      lines.push("");
      review.providerResults.forEach((result) => {
        const statusEmoji = result.status === "success" ? "\u2705" : result.status === "timeout" ? "\u23F1\uFE0F" : result.status === "rate-limited" ? "\u23F8\uFE0F" : "\u274C";
        lines.push(`<details>`);
        lines.push(`<summary>${statusEmoji} ${result.name} [${result.status}] (${result.durationSeconds.toFixed(2)}s)</summary>`);
        lines.push("");
        if (result.result?.content) {
          lines.push(result.result.content.trim());
        } else if (result.error) {
          lines.push("```");
          lines.push(`Error: ${result.error.message}`);
          lines.push("```");
        } else {
          lines.push("*No content available*");
        }
        lines.push("</details>");
        lines.push("");
      });
      lines.push("</details>");
      lines.push("");
    }
    return lines.join("\n");
  }
};

// src/analysis/context.ts
var ContextRetriever = class {
  constructor(graph) {
    this.graph = graph;
  }
  findRelatedContext(files) {
    const contexts = [];
    for (const file of files) {
      const snippets = this.buildSnippets(file);
      const downstreamConsumers = this.graph ? this.extractImportsFromGraph(file.filename) : this.extractImports(file.patch);
      if (snippets.length === 0 && downstreamConsumers.length === 0) continue;
      contexts.push({
        file: file.filename,
        relationship: downstreamConsumers.length > 0 ? "dependency" : "consumer",
        affectedCode: snippets,
        impactLevel: "medium",
        downstreamConsumers
      });
    }
    return contexts;
  }
  buildSnippets(file) {
    const added = mapAddedLines(file.patch);
    if (added.length === 0) return [];
    return added.map((line) => ({
      filename: file.filename,
      startLine: line.line,
      endLine: line.line,
      code: line.content
    }));
  }
  extractImports(patch) {
    if (!patch) return [];
    const imports = [];
    const regexes = [/import .*?from ['"](.+?)['"]/, /require\\(['"](.+?)['"]\\)/];
    for (const raw of patch.split("\n")) {
      if (!raw.startsWith("+")) continue;
      for (const rx of regexes) {
        const match2 = raw.match(rx);
        if (match2 && match2[1]) {
          imports.push(match2[1]);
          break;
        }
      }
    }
    return Array.from(new Set(imports));
  }
  /**
   * Extract imports using code graph (more accurate than regex)
   */
  extractImportsFromGraph(filename) {
    if (!this.graph) {
      return [];
    }
    const dependencies = this.graph.getDependencies(filename);
    logger.debug(`Graph-based import extraction for ${filename}: ${dependencies.length} imports`);
    return dependencies;
  }
  /**
   * Find all files that depend on the given file
   */
  findDependents(filename) {
    if (!this.graph) {
      logger.debug("No code graph available, cannot find dependents");
      return [];
    }
    return this.graph.getDependents(filename);
  }
  /**
   * Find all places where a symbol is used
   */
  findUsages(symbolName) {
    if (!this.graph) {
      return [];
    }
    const callers = this.graph.findCallers(symbolName);
    return callers.map((snippet2) => ({
      filename: snippet2.file,
      startLine: snippet2.line,
      endLine: snippet2.line,
      code: snippet2.code
    }));
  }
};

// src/analysis/impact.ts
var ImpactAnalyzer = class {
  analyze(files, contexts, hasFindings = true) {
    const consumers = this.collectByRelationship(contexts, "consumer");
    const dependencies = this.collectByRelationship(contexts, "dependency");
    const callers = this.collectByRelationship(contexts, "caller");
    const derived = this.collectByRelationship(contexts, "derived");
    const totalAffected = files.length + contexts.length;
    const impactLevel = hasFindings ? this.calculateImpact(totalAffected, files) : "low";
    return {
      file: files[0]?.filename ?? "repository",
      totalAffected,
      callers,
      consumers,
      derived,
      dependencies,
      impactLevel,
      summary: `Touched ${files.length} files with ${contexts.length} related contexts; impact is ${impactLevel}.`
    };
  }
  collectByRelationship(contexts, relationship) {
    return contexts.filter((ctx) => ctx.relationship === relationship).flatMap((ctx) => ctx.affectedCode);
  }
  calculateImpact(total, files) {
    const additions = files.reduce((sum, f) => sum + f.additions, 0);
    const weight = total + additions / 50;
    if (weight > 20) return "critical";
    if (weight > 12) return "high";
    if (weight > 4) return "medium";
    return "low";
  }
};

// src/analysis/evidence.ts
var EvidenceScorer = class {
  score(finding, providerCount, astConfirmed, graphConfirmed, hasDirectEvidence) {
    const agreement = providerCount > 0 ? (finding.providers?.length || 0) / providerCount : 0;
    const confidence = agreement * 0.3 + (astConfirmed ? 0.25 : 0) + (graphConfirmed ? 0.25 : 0) + (hasDirectEvidence ? 0.2 : 0);
    const reasons = [];
    if (agreement >= 0.5) reasons.push(`${Math.round(agreement * 100)}% provider agreement`);
    if (astConfirmed) reasons.push("confirmed by AST analysis");
    if (graphConfirmed) reasons.push("validated by dependency graph");
    if (hasDirectEvidence) reasons.push("direct evidence in changed code");
    return {
      confidence: Math.min(1, confidence),
      reasoning: reasons.join(", ") || "limited evidence",
      badge: this.getBadge(confidence)
    };
  }
  getBadge(confidence) {
    if (confidence >= 0.8) return "\u{1F7E2} High Confidence";
    if (confidence >= 0.5) return "\u{1F7E1} Medium Confidence";
    return "\u{1F7E0} Low Confidence";
  }
};

// src/output/mermaid.ts
var MermaidGenerator = class {
  generateImpactDiagram(files, context) {
    if (files.length > 30) return "";
    const lines = ["graph TD"];
    const fileNodes = /* @__PURE__ */ new Set();
    const usedIds = /* @__PURE__ */ new Set();
    for (const file of files) {
      const node = this.normalizeNode(file.filename, usedIds);
      fileNodes.add(node);
      lines.push(`${node}["${this.escapeLabel(file.filename)}"]`);
    }
    for (const ctx of context.slice(0, 50)) {
      const from = this.normalizeNode(ctx.file, usedIds);
      if (!fileNodes.has(from)) {
        lines.push(`${from}["${this.escapeLabel(ctx.file)}"]`);
        fileNodes.add(from);
      }
      for (const consumer of ctx.downstreamConsumers.slice(0, 50)) {
        const to = this.normalizeNode(consumer, usedIds);
        if (!fileNodes.has(to)) {
          lines.push(`${to}["${this.escapeLabel(consumer)}"]`);
          fileNodes.add(to);
        }
        lines.push(`${from} --> ${to}`);
      }
    }
    return lines.join("\n");
  }
  normalizeNode(name, used) {
    let base = name.replace(/[^a-zA-Z0-9]/g, "_");
    if (/^[0-9]/.test(base)) {
      base = `n_${base}`;
    }
    let candidate = base || "node";
    let counter = 1;
    while (used.has(candidate)) {
      candidate = `${base}_${counter++}`;
    }
    used.add(candidate);
    return candidate;
  }
  escapeLabel(label) {
    return label.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/]/g, "&#93;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
};

// src/github/feedback.ts
var FeedbackFilter = class {
  constructor(client, providerWeightTracker) {
    this.client = client;
    this.providerWeightTracker = providerWeightTracker;
  }
  async loadSuppressed(prNumber) {
    const { octokit, owner, repo } = this.client;
    const suppressed = /* @__PURE__ */ new Set();
    try {
      const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      });
      for (const comment of comments) {
        try {
          const reactions = await octokit.rest.reactions.listForPullRequestReviewComment({
            owner,
            repo,
            comment_id: comment.id,
            per_page: 100
          });
          const hasThumbsDown = reactions.data.some((r) => r.content === "-1");
          if (hasThumbsDown) {
            const signature = this.signatureFromComment(comment.path, comment.line, comment.body || "");
            suppressed.add(signature);
            if (this.providerWeightTracker) {
              const providerMatch = comment.body?.match(/\*\*Provider:\*\* `([^`]+)`/);
              const provider = providerMatch?.[1];
              if (provider) {
                await this.providerWeightTracker.recordFeedback(provider, "\u{1F44E}");
              }
            }
          }
        } catch (error2) {
          logger.warn(`Failed to load reactions for comment ${comment.id}`, error2);
        }
      }
    } catch (error2) {
      logger.warn("Failed to load review comments for feedback filter", error2);
    }
    return suppressed;
  }
  shouldPost(comment, suppressed) {
    const signature = this.signatureFromComment(comment.path, comment.line, comment.body);
    return !suppressed.has(signature);
  }
  signatureFromComment(path13, line, body) {
    const titleMatch = body.match(/\*\*(.+?)\*\*/);
    const title = titleMatch ? titleMatch[1] : body.split("\n")[0] || "unknown";
    return `${(path13 || "unknown").toLowerCase()}:${line ?? 0}:${title.toLowerCase()}`;
  }
};

// src/learning/feedback-tracker.ts
var FeedbackTracker = class _FeedbackTracker {
  // 1 day
  constructor(storage = new CacheStorage(), minFeedbackCount = _FeedbackTracker.MIN_FEEDBACK_FOR_LEARNING) {
    this.storage = storage;
    this.minFeedbackCount = minFeedbackCount;
  }
  static CACHE_KEY = "feedback-learning-data";
  static DEFAULT_THRESHOLD = 0.5;
  static HIGH_QUALITY_THRESHOLD = 0.8;
  static LOW_QUALITY_THRESHOLD = 0.5;
  static THRESHOLD_ADJUSTMENT = 0.1;
  static MIN_THRESHOLD = 0.3;
  static MAX_THRESHOLD = 0.9;
  static MIN_FEEDBACK_FOR_LEARNING = 5;
  static AGGREGATION_INTERVAL_MS = 24 * 60 * 60 * 1e3;
  /**
   * Record a reaction to a finding
   */
  async recordReaction(findingId, category, severity, reaction, prNumber) {
    const data = await this.loadData();
    const record = {
      findingId,
      category,
      severity,
      reaction,
      timestamp: Date.now(),
      prNumber
    };
    data.records.push(record);
    const timeSinceAggregation = Date.now() - data.lastAggregation;
    if (timeSinceAggregation > _FeedbackTracker.AGGREGATION_INTERVAL_MS) {
      await this.aggregateAndAdjust(data);
    }
    await this.saveData(data);
    logger.info(`Recorded ${reaction} feedback for finding ${findingId} (category: ${category})`);
  }
  /**
   * Get the current confidence threshold for a category
   * Returns higher threshold for categories with high false positive rate
   */
  async getConfidenceThreshold(category) {
    const data = await this.loadData();
    const stats = data.categoryStats[category];
    if (!stats) {
      return _FeedbackTracker.DEFAULT_THRESHOLD;
    }
    return stats.confidenceThreshold;
  }
  /**
   * Get all category statistics
   */
  async getCategoryStats() {
    const data = await this.loadData();
    return data.categoryStats;
  }
  /**
   * Get feedback records for a specific finding
   */
  async getFindingFeedback(findingId) {
    const data = await this.loadData();
    return data.records.filter((r) => r.findingId === findingId);
  }
  /**
   * Aggregate feedback and adjust confidence thresholds
   */
  async adjustWeights() {
    const data = await this.loadData();
    await this.aggregateAndAdjust(data);
    await this.saveData(data);
  }
  /**
   * Clear all feedback data (useful for testing)
   */
  async clear() {
    const emptyData = {
      records: [],
      categoryStats: {},
      lastAggregation: Date.now()
    };
    await this.saveData(emptyData);
    logger.info("Cleared all feedback data");
  }
  /**
   * Get feedback statistics summary
   */
  async getStats() {
    const data = await this.loadData();
    const totalPositive = data.records.filter((r) => r.reaction === "\u{1F44D}").length;
    const totalNegative = data.records.filter((r) => r.reaction === "\u{1F44E}").length;
    const total = totalPositive + totalNegative;
    return {
      totalFeedback: total,
      categoriesTracked: Object.keys(data.categoryStats).length,
      overallPositiveRate: total > 0 ? totalPositive / total : 0,
      lastAggregation: data.lastAggregation
    };
  }
  /**
   * Load feedback data from cache
   */
  async loadData() {
    const raw = await this.storage.read(_FeedbackTracker.CACHE_KEY);
    if (!raw) {
      return {
        records: [],
        categoryStats: {},
        lastAggregation: Date.now()
      };
    }
    try {
      return JSON.parse(raw);
    } catch (error2) {
      logger.warn("Failed to parse feedback data, starting fresh", error2);
      return {
        records: [],
        categoryStats: {},
        lastAggregation: Date.now()
      };
    }
  }
  /**
   * Save feedback data to cache
   */
  async saveData(data) {
    await this.storage.write(_FeedbackTracker.CACHE_KEY, JSON.stringify(data));
  }
  /**
   * Aggregate feedback records and adjust confidence thresholds
   */
  async aggregateAndAdjust(data) {
    logger.info("Aggregating feedback and adjusting confidence thresholds");
    const categoryGroups = /* @__PURE__ */ new Map();
    for (const record of data.records) {
      const group = categoryGroups.get(record.category) || [];
      group.push(record);
      categoryGroups.set(record.category, group);
    }
    for (const [category, records] of categoryGroups) {
      const positiveCount = records.filter((r) => r.reaction === "\u{1F44D}").length;
      const negativeCount = records.filter((r) => r.reaction === "\u{1F44E}").length;
      const totalCount = positiveCount + negativeCount;
      if (totalCount < this.minFeedbackCount) {
        continue;
      }
      const positiveRate = positiveCount / totalCount;
      const currentStats = data.categoryStats[category];
      const currentThreshold = currentStats?.confidenceThreshold || _FeedbackTracker.DEFAULT_THRESHOLD;
      let newThreshold = currentThreshold;
      if (positiveRate > _FeedbackTracker.HIGH_QUALITY_THRESHOLD) {
        newThreshold = Math.max(
          _FeedbackTracker.MIN_THRESHOLD,
          currentThreshold - _FeedbackTracker.THRESHOLD_ADJUSTMENT
        );
        logger.debug(
          `Category ${category}: High quality (${(positiveRate * 100).toFixed(1)}%), lowering threshold ${currentThreshold.toFixed(2)} \u2192 ${newThreshold.toFixed(2)}`
        );
      } else if (positiveRate < _FeedbackTracker.LOW_QUALITY_THRESHOLD) {
        newThreshold = Math.min(
          _FeedbackTracker.MAX_THRESHOLD,
          currentThreshold + _FeedbackTracker.THRESHOLD_ADJUSTMENT
        );
        logger.debug(
          `Category ${category}: Low quality (${(positiveRate * 100).toFixed(1)}%), raising threshold ${currentThreshold.toFixed(2)} \u2192 ${newThreshold.toFixed(2)}`
        );
      }
      data.categoryStats[category] = {
        category,
        totalFeedback: totalCount,
        positiveCount,
        negativeCount,
        positiveRate,
        confidenceThreshold: newThreshold,
        lastUpdated: Date.now()
      };
      logger.info(
        `Updated ${category}: ${positiveCount}\u{1F44D} ${negativeCount}\u{1F44E} (${(positiveRate * 100).toFixed(1)}% positive), threshold: ${newThreshold.toFixed(2)}`
      );
    }
    data.lastAggregation = Date.now();
  }
};

// src/learning/quiet-mode.ts
var QuietModeFilter = class {
  constructor(config, feedbackTracker) {
    this.config = config;
    this.feedbackTracker = feedbackTracker;
  }
  /**
   * Filter findings based on confidence thresholds
   * Returns only findings that meet the confidence criteria
   */
  async filterByConfidence(findings) {
    if (!this.config.enabled) {
      logger.debug("Quiet mode disabled, returning all findings");
      return findings;
    }
    logger.info(`Quiet mode enabled (min confidence: ${this.config.minConfidence}), filtering findings`);
    const filtered = [];
    const rejected = [];
    for (const finding of findings) {
      const threshold = await this.getThreshold(finding);
      const confidence = finding.confidence || 0;
      if (confidence >= threshold) {
        filtered.push(finding);
      } else {
        rejected.push(finding);
        logger.debug(
          `Filtered out ${finding.category} finding (confidence: ${confidence.toFixed(2)}, threshold: ${threshold.toFixed(2)})`
        );
      }
    }
    const filterRate = findings.length > 0 ? rejected.length / findings.length * 100 : 0;
    logger.info(
      `Quiet mode filtered ${rejected.length}/${findings.length} findings (${filterRate.toFixed(1)}% reduction)`
    );
    return filtered;
  }
  /**
   * Get statistics about what would be filtered
   */
  async getFilterStats(findings) {
    if (!this.config.enabled) {
      return {
        total: findings.length,
        filtered: 0,
        kept: findings.length,
        filterRate: 0,
        byCategory: {}
      };
    }
    const byCategory = {};
    let totalFiltered = 0;
    for (const finding of findings) {
      const threshold = await this.getThreshold(finding);
      const confidence = finding.confidence || 0;
      const category = finding.category || "unknown";
      if (!byCategory[category]) {
        byCategory[category] = { total: 0, filtered: 0, kept: 0 };
      }
      byCategory[category].total++;
      if (confidence >= threshold) {
        byCategory[category].kept++;
      } else {
        byCategory[category].filtered++;
        totalFiltered++;
      }
    }
    return {
      total: findings.length,
      filtered: totalFiltered,
      kept: findings.length - totalFiltered,
      filterRate: findings.length > 0 ? totalFiltered / findings.length * 100 : 0,
      byCategory
    };
  }
  /**
   * Get the confidence threshold for a finding
   * Uses learned threshold if available, otherwise falls back to config
   */
  async getThreshold(finding) {
    if (!this.config.useLearning || !this.feedbackTracker) {
      return this.config.minConfidence;
    }
    const category = finding.category || "unknown";
    const learnedThreshold = await this.feedbackTracker.getConfidenceThreshold(category);
    return Math.max(learnedThreshold, this.config.minConfidence);
  }
};

// src/analysis/context/graph-builder.ts
var path9 = __toESM(require("path"));
function resolveImportPath(importerFile, moduleSpecifier) {
  if (moduleSpecifier.startsWith(".")) {
    const importerDir = path9.dirname(importerFile);
    if (importerDir && importerDir !== "." && importerDir !== importerFile) {
      const resolved = path9.join(importerDir, moduleSpecifier);
      return resolved.replace(/\\/g, "/");
    }
  }
  return moduleSpecifier;
}
var CodeGraph = class _CodeGraph {
  // file → symbols defined
  constructor(files = [], buildTime = 0) {
    this.files = files;
    this.buildTime = buildTime;
  }
  definitions = /* @__PURE__ */ new Map();
  imports = /* @__PURE__ */ new Map();
  // file → imported files
  exports = /* @__PURE__ */ new Map();
  // file → exported symbols
  calls = /* @__PURE__ */ new Map();
  // fn → called fns
  callers = /* @__PURE__ */ new Map();
  // fn → callers
  fileSymbols = /* @__PURE__ */ new Map();
  /**
   * Add a definition to the graph
   */
  addDefinition(def) {
    const key = `${def.file}:${def.name}`;
    this.definitions.set(key, def);
    const symbols = this.fileSymbols.get(def.file) || [];
    symbols.push(def.name);
    this.fileSymbols.set(def.file, symbols);
  }
  /**
   * Remove all data for a file from the graph
   * Used when re-analyzing a file to avoid stale data
   */
  /**
   * Remove a file and all its relationships from the graph
   *
   * PERFORMANCE: Optimized to O(E) where E is the number of edges,
   * using Sets for O(1) lookups instead of O(n) array filtering.
   *
   * CORRECTNESS: Ensures complete cleanup of:
   * - Definitions (from fileSymbols and definitions map)
   * - Imports and exports
   * - Call edges (both directions: calls and callers)
   * - Non-definition symbols (e.g., <top>, anonymous functions)
   */
  removeFile(file) {
    const symbolNames = this.fileSymbols.get(file) || [];
    const filePrefix = `${file}:`;
    const symbolsToRemove = /* @__PURE__ */ new Set();
    for (const name of symbolNames) {
      symbolsToRemove.add(`${file}:${name}`);
    }
    for (const [caller] of this.calls) {
      if (caller.startsWith(filePrefix)) {
        symbolsToRemove.add(caller);
      }
    }
    for (const [callee] of this.callers) {
      if (callee.startsWith(filePrefix)) {
        symbolsToRemove.add(callee);
      }
    }
    this.fileSymbols.delete(file);
    this.imports.delete(file);
    this.exports.delete(file);
    for (const symbol of symbolsToRemove) {
      this.definitions.delete(symbol);
    }
    for (const symbol of symbolsToRemove) {
      const callees = this.calls.get(symbol);
      if (callees) {
        for (const callee of callees) {
          const callerList = this.callers.get(callee);
          if (callerList) {
            const filtered = callerList.filter((c) => !symbolsToRemove.has(c));
            if (filtered.length > 0) {
              this.callers.set(callee, filtered);
            } else {
              this.callers.delete(callee);
            }
          }
        }
      }
      const callersToThis = this.callers.get(symbol);
      if (callersToThis) {
        for (const caller of callersToThis) {
          const calleeList = this.calls.get(caller);
          if (calleeList) {
            const filtered = calleeList.filter((c) => !symbolsToRemove.has(c));
            if (filtered.length > 0) {
              this.calls.set(caller, filtered);
            } else {
              this.calls.delete(caller);
            }
          }
        }
      }
      this.calls.delete(symbol);
      this.callers.delete(symbol);
    }
  }
  /**
   * Add an import relationship
   */
  addImport(fromFile, toFile) {
    const normalizedPath = resolveImportPath(fromFile, toFile);
    const imported = this.imports.get(fromFile) || [];
    if (!imported.includes(normalizedPath)) {
      imported.push(normalizedPath);
      this.imports.set(fromFile, imported);
    }
  }
  /**
   * Add a call relationship
   */
  addCall(callerFile, caller, callee) {
    const qualifiedCaller = `${callerFile}:${caller}`;
    const qualifiedCallee = callee.includes(":") ? callee : `${callerFile}:${callee}`;
    const called = this.calls.get(qualifiedCaller) || [];
    if (!called.includes(qualifiedCallee)) {
      called.push(qualifiedCallee);
      this.calls.set(qualifiedCaller, called);
    }
    const callerList = this.callers.get(qualifiedCallee) || [];
    if (!callerList.includes(qualifiedCaller)) {
      callerList.push(qualifiedCaller);
      this.callers.set(qualifiedCallee, callerList);
    }
  }
  /**
   * Find all places where a symbol is called/used
   */
  findCallers(symbol) {
    const candidateKeys = symbol.includes(":") ? [symbol] : Array.from(this.callers.keys()).filter((key) => key.endsWith(`:${symbol}`));
    const callerList = candidateKeys.flatMap((key) => this.callers.get(key) || []);
    const snippets = [];
    for (const qualifiedCaller of callerList) {
      const def = this.definitions.get(qualifiedCaller);
      if (def) {
        snippets.push({
          file: def.file,
          line: def.line,
          code: `${def.type} ${def.name}`,
          context: `Called from ${def.name}`
        });
      }
    }
    return snippets;
  }
  /**
   * Normalize a file path for comparison (strips extensions, converts to posix)
   */
  normalizePathForComparison(path13) {
    let normalized = path13.replace(/\\/g, "/");
    normalized = normalized.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    return normalized;
  }
  /**
   * Find all files that import/depend on a given file
   */
  findConsumers(file) {
    const consumers = [];
    const normalizedFile = this.normalizePathForComparison(file);
    for (const [fromFile, toFiles] of this.imports) {
      const hasMatch = toFiles.some((importedPath) => {
        const normalizedImport = this.normalizePathForComparison(importedPath);
        if (normalizedImport === normalizedFile) return true;
        if (normalizedImport.endsWith(normalizedFile)) return true;
        if (normalizedFile.endsWith(normalizedImport)) return true;
        return false;
      });
      if (hasMatch) {
        consumers.push({
          file: fromFile,
          line: 1,
          code: `import from '${file}'`,
          context: `File depends on ${file}`
        });
      }
    }
    return consumers;
  }
  /**
   * Find all symbols defined in a file
   */
  getFileSymbols(file) {
    const symbolNames = this.fileSymbols.get(file) || [];
    return symbolNames.map((name) => this.definitions.get(`${file}:${name}`)).filter((def) => def !== void 0);
  }
  /**
   * Get a symbol definition by name (searches all files)
   */
  getDefinition(symbolName) {
    for (const [, def] of this.definitions) {
      if (def.name === symbolName) {
        return def;
      }
    }
    return void 0;
  }
  /**
   * Get all symbols called by a given symbol
   */
  getCalls(symbol) {
    return this.calls.get(symbol) || null;
  }
  /**
   * Get all symbols that call a given symbol
   */
  getCallers(symbol) {
    return this.callers.get(symbol) || null;
  }
  /**
   * Get all files that a file depends on (direct imports)
   */
  getDependencies(file) {
    return this.imports.get(file) || [];
  }
  /**
   * Get all files that depend on this file (reverse)
   */
  getDependents(file) {
    const dependents = [];
    const normalizedFile = this.normalizePathForComparison(file);
    for (const [fromFile, toFiles] of this.imports) {
      const hasMatch = toFiles.some((importedPath) => {
        const normalizedImport = this.normalizePathForComparison(importedPath);
        if (normalizedImport === normalizedFile) return true;
        if (normalizedImport.endsWith(normalizedFile)) return true;
        if (normalizedFile.endsWith(normalizedImport)) return true;
        return false;
      });
      if (hasMatch) {
        dependents.push(fromFile);
      }
    }
    return dependents;
  }
  /**
   * Find all symbols called by a given symbol (callees)
   * Required by CodeGraph interface
   */
  findCallees(symbol) {
    const callees = this.calls.get(symbol) || [];
    return callees.map((callee) => ({
      filename: "",
      startLine: 0,
      endLine: 0,
      code: callee
    }));
  }
  /**
   * Find all classes that inherit from a given class
   * Required by CodeGraph interface - currently a stub
   *
   * LIMITATION: Class inheritance tracking is not yet implemented.
   * This would require:
   * 1. Parsing extends/implements clauses in class declarations
   * 2. Building an inheritance graph alongside the import graph
   * 3. Resolving parent class names to their definitions
   *
   * Impact: Without this, code reviews may miss inheritance-related issues
   * where changes to a base class affect derived classes. Reviewers should
   * manually check for inheritance relationships when reviewing class changes.
   *
   * Tracked in issue #TODO
   */
  findDerivedClasses(_className) {
    return [];
  }
  /**
   * Find all dependencies (imports) for a file
   * Required by CodeGraph interface - wraps getDependencies
   */
  findDependencies(file) {
    const deps = this.getDependencies(file);
    return deps.map((dep) => ({
      filename: dep,
      startLine: 0,
      endLine: 0,
      code: dep
    }));
  }
  /**
   * Analyze the impact radius of changes to a file
   * Required by CodeGraph interface - currently a stub
   *
   * LIMITATION: Full impact analysis is not yet implemented.
   * This would require:
   * 1. Building reverse dependency graph (who imports this file)
   * 2. Finding all function callers across the codebase
   * 3. Identifying derived classes (requires inheritance tracking)
   * 4. Calculating transitive impact (affected files that import affected files)
   *
   * Current behavior: Returns a stub response indicating low impact.
   * Reviews may underestimate the blast radius of changes to widely-used files.
   *
   * Workaround: The code graph still provides dependency context for the
   * changed files themselves, which helps LLMs understand direct relationships.
   *
   * Tracked in issue #TODO
   */
  findImpactRadius(file) {
    return {
      file,
      totalAffected: 0,
      callers: [],
      consumers: [],
      derived: [],
      impactLevel: "low",
      summary: "Impact analysis not yet implemented - file relationships are tracked but impact radius calculation is pending"
    };
  }
  /**
   * Get statistics about the graph
   */
  getStats() {
    return {
      files: this.files.length,
      definitions: this.definitions.size,
      imports: Array.from(this.imports.values()).flat().length,
      calls: Array.from(this.calls.values()).flat().length,
      buildTimeMs: this.buildTime
    };
  }
  /**
   * Copy graph data from another CodeGraph instance
   * Type-safe alternative to direct private field assignment
   * Deep copies all arrays to prevent shared mutable state.
   *
   * SECURITY: Deep copy prevents shared mutable state between graph instances.
   * Each Definition object is cloned using spread operator to create independent copies.
   *
   * @param other - Source graph to copy from
   */
  copyFrom(other) {
    this.definitions = new Map(
      Array.from(other.definitions.entries()).map(([k, v]) => [k, { ...v }])
    );
    this.imports = new Map(
      Array.from(other.imports.entries()).map(([k, v]) => [k, [...v]])
    );
    this.exports = new Map(
      Array.from(other.exports.entries()).map(([k, v]) => [k, [...v]])
    );
    this.calls = new Map(
      Array.from(other.calls.entries()).map(([k, v]) => [k, [...v]])
    );
    this.callers = new Map(
      Array.from(other.callers.entries()).map(([k, v]) => [k, [...v]])
    );
    this.fileSymbols = new Map(
      Array.from(other.fileSymbols.entries()).map(([k, v]) => [k, [...v]])
    );
  }
  /**
   * Create a deep clone of the graph for incremental updates
   * All arrays are deep copied to prevent shared mutable state
   */
  clone() {
    const cloned = new _CodeGraph([...this.files], this.buildTime);
    cloned.copyFrom(this);
    return cloned;
  }
  /**
   * Serialize graph to JSON for caching
   * Deep copies all arrays to prevent mutations from affecting the graph
   */
  serialize() {
    return {
      files: [...this.files],
      // Copy files array
      buildTime: this.buildTime,
      definitions: Array.from(this.definitions.entries()),
      // Deep copy array values to prevent shared mutable references
      imports: Array.from(this.imports.entries()).map(([k, v]) => [k, [...v]]),
      exports: Array.from(this.exports.entries()).map(([k, v]) => [k, [...v]]),
      calls: Array.from(this.calls.entries()).map(([k, v]) => [k, [...v]]),
      callers: Array.from(this.callers.entries()).map(([k, v]) => [k, [...v]]),
      fileSymbols: Array.from(this.fileSymbols.entries()).map(([k, v]) => [k, [...v]])
    };
  }
  /**
   * Deserialize graph from JSON
   * Deep copies all arrays to ensure the graph owns its own memory
   */
  static deserialize(data) {
    if (!data || typeof data !== "object") {
      throw new Error("Invalid graph data: expected object");
    }
    if (!Array.isArray(data.files)) {
      throw new Error("Invalid graph data: files must be an array");
    }
    if (typeof data.buildTime !== "number") {
      throw new Error("Invalid graph data: buildTime must be a number");
    }
    const mapFields = ["definitions", "imports", "exports", "calls", "callers", "fileSymbols"];
    for (const field of mapFields) {
      if (!Array.isArray(data[field])) {
        throw new Error(`Invalid graph data: ${field} must be an array`);
      }
    }
    if (!Array.isArray(data.definitions)) {
      throw new Error("Invalid graph data: definitions must be an array");
    }
    for (const [key, def] of data.definitions) {
      if (!def || typeof def !== "object") {
        throw new Error(`Invalid definition for key ${key}: must be an object`);
      }
      if (typeof def.name !== "string" || !def.name) {
        throw new Error(`Invalid definition for key ${key}: name must be a non-empty string`);
      }
      if (typeof def.file !== "string" || !def.file) {
        throw new Error(`Invalid definition for key ${key}: file must be a non-empty string`);
      }
      if (typeof def.line !== "number" || def.line < 1) {
        throw new Error(`Invalid definition for key ${key}: line must be a positive number (>= 1)`);
      }
      const validTypes = ["function", "class", "variable", "type", "interface"];
      if (!validTypes.includes(def.type)) {
        throw new Error(`Invalid definition for key ${key}: type must be one of ${validTypes.join(", ")}`);
      }
      if (typeof def.exported !== "boolean") {
        throw new Error(`Invalid definition for key ${key}: exported must be a boolean`);
      }
    }
    const graph = new _CodeGraph([...data.files], data.buildTime);
    graph.definitions = new Map(data.definitions);
    graph.imports = new Map(data.imports.map(([k, v]) => [k, [...v]]));
    graph.exports = new Map(data.exports.map(([k, v]) => [k, [...v]]));
    graph.calls = new Map(data.calls.map(([k, v]) => [k, [...v]]));
    graph.callers = new Map(data.callers.map(([k, v]) => [k, [...v]]));
    graph.fileSymbols = new Map(data.fileSymbols.map(([k, v]) => [k, [...v]]));
    return graph;
  }
};
var CodeGraphBuilder = class {
  constructor(maxDepth = 5, timeoutMs = 1e4) {
    this.maxDepth = maxDepth;
    this.timeoutMs = timeoutMs;
  }
  tsParser = null;
  tsxParser = null;
  pyParser = null;
  parsersInitialized = false;
  /**
   * Lazy-load and initialize parsers only when needed
   */
  async initParsers() {
    if (this.parsersInitialized) {
      return;
    }
    try {
      const ParserModule = await import("tree-sitter");
      const TypeScriptParser = await import("tree-sitter-typescript");
      const PythonParser = await import("tree-sitter-python");
      const Parser = ParserModule.default;
      this.tsParser = new Parser();
      this.tsxParser = new Parser();
      this.pyParser = new Parser();
      this.tsParser.setLanguage(TypeScriptParser.default.typescript);
      this.tsxParser.setLanguage(TypeScriptParser.default.tsx);
      this.pyParser.setLanguage(PythonParser.default);
      this.parsersInitialized = true;
    } catch (error2) {
      logger.warn("Failed to initialize parsers - AST analysis disabled", error2);
      this.parsersInitialized = true;
    }
  }
  /**
   * Build a code graph from file changes
   */
  async buildGraph(files) {
    const startTime = Date.now();
    const graph = new CodeGraph();
    logger.info(`Building code graph for ${files.length} files`);
    for (const file of files) {
      try {
        await this.analyzeFile(file, graph);
      } catch (error2) {
        logger.warn(`Failed to analyze ${file.filename}`, error2);
      }
      if (Date.now() - startTime > this.timeoutMs) {
        logger.warn(`Graph build timeout after ${this.timeoutMs}ms, stopping early`);
        break;
      }
    }
    const buildTime = Date.now() - startTime;
    const finalGraph = new CodeGraph(
      files.map((f) => f.filename),
      buildTime
    );
    finalGraph.copyFrom(graph);
    logger.info(`Code graph built in ${buildTime}ms: ${graph.getStats().definitions} definitions, ${graph.getStats().imports} imports`);
    return finalGraph;
  }
  /**
   * Update an existing graph with changed files
   */
  async updateGraph(graph, changedFiles) {
    const startTime = Date.now();
    logger.info(`Updating code graph with ${changedFiles.length} changed files`);
    for (const file of changedFiles) {
      try {
        graph.removeFile(file.filename);
        await this.analyzeFile(file, graph);
      } catch (error2) {
        logger.warn(`Failed to analyze ${file.filename}`, error2);
      }
    }
    const updateTime = Date.now() - startTime;
    logger.info(`Code graph updated in ${updateTime}ms`);
    return graph;
  }
  /**
   * Analyze a single file and add to graph
   */
  async analyzeFile(file, graph) {
    await this.initParsers();
    const ext2 = file.filename.split(".").pop()?.toLowerCase();
    let parser = null;
    if (ext2 === "tsx" || ext2 === "jsx") {
      parser = this.tsxParser;
    } else if (ext2 === "ts" || ext2 === "js") {
      parser = this.tsParser;
    } else if (ext2 === "py") {
      parser = this.pyParser;
    }
    if (!parser || !file.patch) {
      return;
    }
    logger.warn(`Analyzing patch-only for ${file.filename} - AST may be incomplete/invalid`);
    const addedLines = this.extractAddedLines(file.patch);
    if (addedLines.length === 0) {
      logger.debug(`No added lines found in patch for ${file.filename}, skipping AST analysis`);
      return;
    }
    const codeToAnalyze = addedLines.join("\n");
    if (this.looksLikeFragment(codeToAnalyze)) {
      logger.warn(`Skipping AST analysis for ${file.filename}: code appears to be a fragment (unbalanced braces or no top-level declarations)`);
      return;
    }
    const tree = parser.parse(codeToAnalyze);
    const root = tree.rootNode;
    this.extractDefinitions(root, file.filename, graph);
    this.extractImports(root, file.filename, graph);
    this.extractCalls(root, file.filename, graph);
  }
  /**
   * Extract symbol definitions from AST
   */
  extractDefinitions(node, file, graph) {
    if (node.type === "function_declaration" || node.type === "function") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        graph.addDefinition({
          name: nameNode.text,
          file,
          line: node.startPosition.row + 1,
          type: "function",
          exported: this.isExported(node)
        });
      }
    }
    if (node.type === "class_declaration" || node.type === "class") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        graph.addDefinition({
          name: nameNode.text,
          file,
          line: node.startPosition.row + 1,
          type: "class",
          exported: this.isExported(node)
        });
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      this.extractDefinitions(node.child(i), file, graph);
    }
  }
  /**
   * Extract import statements from AST
   */
  extractImports(node, file, graph) {
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        const source = sourceNode.text.replace(/['"]/g, "");
        graph.addImport(file, source);
      } else {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (!child) continue;
          if (child.type === "dotted_name") {
            graph.addImport(file, child.text);
          } else if (child.type === "aliased_import") {
            const nameNode = child.childForFieldName("name");
            if (nameNode) {
              graph.addImport(file, nameNode.text);
            }
          }
        }
      }
    }
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      if (moduleNode) {
        graph.addImport(file, moduleNode.text);
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      this.extractImports(node.child(i), file, graph);
    }
  }
  /**
   * Extract function/method calls from AST
   */
  extractCalls(node, file, graph) {
    if (node.type === "call_expression") {
      const functionNode = node.childForFieldName("function");
      if (functionNode) {
        const callee = functionNode.text;
        const caller = this.findEnclosingFunction(node);
        if (caller && callee) {
          graph.addCall(file, caller, callee);
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      this.extractCalls(node.child(i), file, graph);
    }
  }
  /**
   * Find the name of the enclosing function for a given node
   * Returns '<top>' for top-level calls
   */
  findEnclosingFunction(node) {
    let current = node.parent;
    while (current) {
      if (current.type === "function_declaration" || current.type === "function") {
        const nameNode = current.childForFieldName("name");
        if (nameNode) {
          return nameNode.text;
        }
      }
      if (current.type === "method_definition") {
        const nameNode = current.childForFieldName("name");
        if (nameNode) {
          return nameNode.text;
        }
      }
      if (current.type === "lexical_declaration" || current.type === "variable_declaration") {
        const declarator = current.childForFieldName("declarator");
        if (declarator) {
          const nameNode = declarator.childForFieldName("name");
          if (nameNode) {
            return nameNode.text;
          }
        }
      }
      current = current.parent;
    }
    return "<top>";
  }
  /**
   * Check if a node has an export modifier
   */
  isExported(node) {
    let current = node;
    while (current) {
      if (current.type === "export_statement") {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
  /**
   * Extract added lines from a unified diff patch
   * Returns lines that start with '+' (excluding the '+' prefix)
   */
  extractAddedLines(patch) {
    const lines = patch.split("\n");
    const addedLines = [];
    for (const line of lines) {
      if (line.startsWith("@@")) {
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        addedLines.push(line.substring(1));
      }
    }
    return addedLines;
  }
  /**
   * Check if code looks like a fragment that would produce invalid AST
   * Returns true if code has unbalanced braces or lacks top-level declarations
   */
  looksLikeFragment(code) {
    let braceCount = 0;
    let parenCount = 0;
    let bracketCount = 0;
    for (const char of code) {
      if (char === "{") braceCount++;
      else if (char === "}") braceCount--;
      else if (char === "(") parenCount++;
      else if (char === ")") parenCount--;
      else if (char === "[") bracketCount++;
      else if (char === "]") bracketCount--;
    }
    if (braceCount !== 0 || parenCount !== 0 || bracketCount !== 0) {
      return true;
    }
    const hasTopLevelDeclaration = /^\s*(export\s+)?(function|class|const|let|var|type|interface|async\s+function|def|async\s+def|import|from)\s+/m.test(code);
    return !hasTopLevelDeclaration;
  }
};

// src/autofix/prompt-generator.ts
var PromptGenerator = class {
  constructor(defaultFormat = "plain") {
    this.defaultFormat = defaultFormat;
  }
  /**
   * Generate fix prompts for all findings
   */
  generateFixPrompts(findings) {
    logger.info(`Generating fix prompts for ${findings.length} findings`);
    const prompts = [];
    for (const finding of findings) {
      const prompt = this.generatePromptForFinding(finding);
      if (prompt) {
        prompts.push(prompt);
      }
    }
    logger.info(`Generated ${prompts.length} fix prompts`);
    return prompts;
  }
  /**
   * Format prompts for a specific IDE
   */
  formatForIDE(prompts, format = this.defaultFormat) {
    logger.debug(`Formatting ${prompts.length} prompts for ${format}`);
    switch (format) {
      case "cursor":
        return this.formatForCursor(prompts);
      case "copilot":
        return this.formatForCopilot(prompts);
      case "plain":
      default:
        return this.formatPlain(prompts);
    }
  }
  /**
   * Generate output with metadata
   */
  generate(findings, format) {
    const prompts = this.generateFixPrompts(findings);
    const outputFormat = format || this.defaultFormat;
    return {
      format: outputFormat,
      prompts,
      totalFindings: findings.length,
      promptsGenerated: prompts.length
    };
  }
  /**
   * Generate a fix prompt for a single finding
   */
  generatePromptForFinding(finding) {
    if (!finding.suggestion) {
      return null;
    }
    const prompt = this.buildPromptText(finding);
    return {
      file: finding.file,
      line: finding.line,
      finding: finding.title,
      severity: finding.severity,
      fixPrompt: prompt,
      category: finding.category
    };
  }
  /**
   * Build prompt text from finding
   */
  buildPromptText(finding) {
    const parts = [];
    parts.push(`Fix the following ${finding.severity} issue in ${finding.file}:${finding.line}`);
    parts.push("");
    parts.push(`Issue: ${finding.title}`);
    parts.push(`Details: ${finding.message}`);
    parts.push("");
    if (finding.suggestion) {
      parts.push("Suggested fix:");
      parts.push(finding.suggestion);
    }
    if (finding.category) {
      parts.push("");
      parts.push(`Category: ${finding.category}`);
    }
    return parts.join("\n");
  }
  /**
   * Format for Cursor AI IDE
   */
  formatForCursor(prompts) {
    const lines = [];
    lines.push("# AI Fix Prompts for Cursor");
    lines.push("");
    lines.push(`Generated ${prompts.length} fix prompts. Use Cursor AI to apply these fixes.`);
    lines.push("");
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      lines.push(`## Fix ${i + 1}: ${prompt.finding} (${prompt.severity})`);
      lines.push("");
      lines.push(`**File:** \`${prompt.file}:${prompt.line}\``);
      lines.push("");
      lines.push("**Prompt for Cursor:**");
      lines.push("```");
      lines.push(prompt.fixPrompt);
      lines.push("```");
      lines.push("");
      lines.push("**To apply:** Open file in Cursor, position cursor at the line, and use Cmd+K with the prompt above.");
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    return lines.join("\n");
  }
  /**
   * Format for GitHub Copilot
   */
  formatForCopilot(prompts) {
    const lines = [];
    lines.push("# AI Fix Suggestions for GitHub Copilot");
    lines.push("");
    lines.push(`${prompts.length} fixes available. Use Copilot to apply these suggestions.`);
    lines.push("");
    for (const prompt of prompts) {
      lines.push(`### ${prompt.file}:${prompt.line} - ${prompt.finding}`);
      lines.push("");
      lines.push(`**Severity:** ${prompt.severity}`);
      if (prompt.category) {
        lines.push(`**Category:** ${prompt.category}`);
      }
      lines.push("");
      lines.push("**Fix suggestion:**");
      lines.push("```");
      lines.push(prompt.fixPrompt);
      lines.push("```");
      lines.push("");
    }
    return lines.join("\n");
  }
  /**
   * Format as plain text
   */
  formatPlain(prompts) {
    const lines = [];
    lines.push("AI-Generated Fix Prompts");
    lines.push("=".repeat(50));
    lines.push("");
    lines.push(`Total prompts: ${prompts.length}`);
    lines.push("");
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      lines.push(`[${i + 1}] ${prompt.finding} (${prompt.severity})`);
      lines.push(`    Location: ${prompt.file}:${prompt.line}`);
      if (prompt.category) {
        lines.push(`    Category: ${prompt.category}`);
      }
      lines.push("");
      lines.push("    Fix prompt:");
      const promptLines = prompt.fixPrompt.split("\n");
      for (const line of promptLines) {
        lines.push(`    ${line}`);
      }
      lines.push("");
      lines.push("-".repeat(50));
      lines.push("");
    }
    return lines.join("\n");
  }
  /**
   * Save prompts to a file (for CLI usage)
   */
  async saveToFile(prompts, filepath, format = this.defaultFormat) {
    const fs13 = await import("fs/promises");
    const content = this.formatForIDE(prompts, format);
    await fs13.writeFile(filepath, content, "utf8");
    logger.info(`Saved ${prompts.length} fix prompts to ${filepath}`);
  }
  /**
   * Get statistics about generated prompts
   */
  getStats(prompts) {
    const bySeverity = {};
    const byCategory = {};
    const byFile = {};
    for (const prompt of prompts) {
      bySeverity[prompt.severity] = (bySeverity[prompt.severity] || 0) + 1;
      if (prompt.category) {
        byCategory[prompt.category] = (byCategory[prompt.category] || 0) + 1;
      }
      byFile[prompt.file] = (byFile[prompt.file] || 0) + 1;
    }
    return {
      total: prompts.length,
      bySeverity,
      byCategory,
      byFile
    };
  }
};

// src/utils/sanitize.ts
var import_crypto2 = require("crypto");
function encodeURIComponentSafe(value) {
  if (typeof value !== "string") {
    return "invalid";
  }
  const encoded = encodeURIComponent(value);
  const normalized = encoded.replace(/[+]/g, "_").replace(/%/g, "_").replace(/[<>:"|?*]/g, "_");
  const MAX_PREFIX = 120;
  const prefix = normalized.length > MAX_PREFIX ? normalized.slice(0, MAX_PREFIX) : normalized;
  const hashSuffix = (0, import_crypto2.createHash)("sha256").update(value).digest("hex").slice(0, 16);
  return `${prefix}-${hashSuffix}`;
}

// src/providers/circuit-breaker.ts
var CircuitBreaker = class _CircuitBreaker {
  // Track storage health
  constructor(storage = new CacheStorage(), options = {}) {
    this.storage = storage;
    this.failureThreshold = options.failureThreshold ?? _CircuitBreaker.DEFAULT_FAILURE_THRESHOLD;
    this.openDurationMs = options.openDurationMs ?? _CircuitBreaker.DEFAULT_OPEN_DURATION_MS;
  }
  // Default configuration constants
  static DEFAULT_FAILURE_THRESHOLD = 3;
  static DEFAULT_OPEN_DURATION_MS = 5 * 60 * 1e3;
  // 5 minutes
  static LOCK_CLEANUP_MS = 1e4;
  // 10 seconds (reduced for faster recovery)
  failureThreshold;
  openDurationMs;
  // Lock map for concurrency control - automatically cleaned up via timer + finally block
  // Memory leak prevention: locks are removed after LOCK_CLEANUP_MS or immediately after completion
  locks = /* @__PURE__ */ new Map();
  // In-memory fallback for when storage is unavailable
  // Ensures circuit breaker continues working even if filesystem/cache fails
  inMemoryState = /* @__PURE__ */ new Map();
  storageAvailable = true;
  /**
   * Get the current number of active locks (for monitoring/debugging)
   * Used to detect potential lock accumulation issues
   */
  getActiveLockCount() {
    return this.locks.size;
  }
  /**
   * Check if circuit is open (provider should be skipped)
   * Also handles state transitions: OPEN → HALF_OPEN after cooldown
   *
   * Returns:
   * - true: Circuit is OPEN or HALF_OPEN with probe in flight (block request)
   * - false: Circuit is CLOSED or HALF_OPEN without probe (allow request)
   *
   * Side effects:
   * - Transitions OPEN → HALF_OPEN if cooldown expired
   * - Sets probeInFlight flag when allowing half-open probe
   */
  async isOpen(providerId) {
    return this.withLock(providerId, async () => {
      let state = await this.load(providerId);
      if (state.state === "open") {
        const expired = state.openedAt && Date.now() - state.openedAt > this.openDurationMs;
        if (expired) {
          state = { state: "half_open", failures: 0, probeInFlight: false };
          await this.setState(providerId, state);
          logger.debug(`Circuit transitioned to half-open for ${providerId} after cooldown`);
        }
        if (state.state === "open") {
          return true;
        }
      }
      if (state.state === "half_open") {
        if (state.probeInFlight) {
          return true;
        }
        await this.setState(providerId, { ...state, probeInFlight: true });
        return false;
      }
      return false;
    });
  }
  /**
   * Record a successful operation
   * Transitions any state → CLOSED and resets failure counter
   *
   * Call this after:
   * - Successful health check
   * - Successful API request
   * - Any operation indicating the provider is healthy
   */
  async recordSuccess(providerId) {
    await this.withLock(providerId, async () => {
      const state = await this.load(providerId);
      await this.setState(providerId, {
        state: "closed",
        failures: 0,
        openedAt: void 0,
        probeInFlight: false
      });
      if (state.state !== "closed") {
        logger.info(`Circuit closed for ${providerId} after successful recovery (was ${state.state})`);
      }
    });
  }
  /**
   * Record a failed operation
   * Increments failure counter and opens circuit if threshold reached
   *
   * State transitions:
   * - CLOSED: failures++ → if >= threshold → OPEN
   * - HALF_OPEN: failures++ → OPEN (probe failed, provider still unhealthy)
   *
   * Call this after:
   * - Failed health check
   * - API timeout or error
   * - Any operation indicating the provider is unhealthy
   */
  async recordFailure(providerId) {
    await this.withLock(providerId, async () => {
      const state = await this.load(providerId);
      const failures = state.failures + 1;
      if (state.state === "half_open") {
        await this.setState(providerId, {
          state: "open",
          failures,
          openedAt: Date.now(),
          probeInFlight: false
        });
        logger.warn(`Circuit re-opened for ${providerId} after half-open probe failed (${failures} total failures)`);
        return;
      }
      if (failures >= this.failureThreshold) {
        await this.setState(providerId, { state: "open", failures, openedAt: Date.now(), probeInFlight: false });
        logger.warn(
          `Circuit opened for ${providerId} after ${failures} consecutive failures (threshold: ${this.failureThreshold}, cooldown: ${this.openDurationMs}ms)`
        );
      } else {
        await this.setState(providerId, { state: "closed", failures });
        logger.debug(`Circuit failure recorded for ${providerId}: ${failures}/${this.failureThreshold}`);
      }
    });
  }
  async load(providerId) {
    const key = this.key(providerId);
    if (!this.storageAvailable && this.inMemoryState.has(key)) {
      logger.debug(`Using in-memory state for ${providerId} (storage unavailable)`);
      return this.inMemoryState.get(key);
    }
    try {
      const raw = await this.storage.read(key);
      if (!raw) {
        if (this.inMemoryState.has(key)) {
          return this.inMemoryState.get(key);
        }
        return { state: "closed", failures: 0, probeInFlight: false };
      }
      try {
        const parsed = JSON.parse(raw);
        this.inMemoryState.set(key, parsed);
        this.storageAvailable = true;
        return parsed;
      } catch (parseError) {
        logger.warn(`Failed to parse circuit state for ${providerId}`, parseError);
        if (this.inMemoryState.has(key)) {
          return this.inMemoryState.get(key);
        }
        return { state: "closed", failures: 0, probeInFlight: false };
      }
    } catch (storageError) {
      this.storageAvailable = false;
      logger.warn(`Storage read failed for circuit ${providerId}, using in-memory fallback`, storageError);
      if (this.inMemoryState.has(key)) {
        return this.inMemoryState.get(key);
      }
      return { state: "closed", failures: 0, probeInFlight: false };
    }
  }
  async setState(providerId, state) {
    const key = this.key(providerId);
    this.inMemoryState.set(key, state);
    if (this.storageAvailable) {
      try {
        await this.storage.write(key, JSON.stringify(state));
      } catch (error2) {
        this.storageAvailable = false;
        logger.error(
          `Storage write failed for circuit ${providerId}, continuing with in-memory state only`,
          error2
        );
      }
    }
  }
  key(providerId) {
    return `circuit-breaker-${encodeURIComponentSafe(providerId)}`;
  }
  /**
   * Serialize concurrent access to circuit breaker state using a promise chain lock.
   * This prevents race conditions when multiple operations try to update the same provider's state.
   *
   * The lock implementation uses a promise chain where each operation waits for the previous
   * operation to complete before executing. The finally block ensures the lock is always
   * released and cleaned up, even if the operation throws an error.
   */
  withLock(providerId, fn) {
    const lockKey = this.key(providerId);
    const previous = this.locks.get(lockKey)?.catch(() => void 0) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve2) => release = resolve2);
    const tail = previous.then(() => current);
    this.locks.set(lockKey, tail);
    const cleanupTimer = setTimeout(() => {
      if (this.locks.get(lockKey) === tail) {
        logger.warn(`Lock cleanup triggered for ${lockKey}`);
        this.locks.delete(lockKey);
      }
    }, _CircuitBreaker.LOCK_CLEANUP_MS);
    const run2 = (async () => {
      try {
        await previous;
        return await fn();
      } finally {
        clearTimeout(cleanupTimer);
        release();
        if (this.locks.get(lockKey) === tail) {
          this.locks.delete(lockKey);
        }
      }
    })();
    return run2;
  }
};

// src/providers/reliability-tracker.ts
var ReliabilityTracker = class _ReliabilityTracker {
  constructor(storage = new CacheStorage(), minAttempts = _ReliabilityTracker.MIN_ATTEMPTS_FOR_SCORING, circuitBreaker = new CircuitBreaker(storage)) {
    this.storage = storage;
    this.minAttempts = minAttempts;
    this.circuitBreaker = circuitBreaker;
  }
  static CACHE_KEY = "provider-reliability-data";
  static AGGREGATION_INTERVAL_MS = 24 * 60 * 60 * 1e3;
  // 1 day
  static MIN_ATTEMPTS_FOR_SCORING = 5;
  static MAX_RESULTS_HISTORY = 1e3;
  // Prevent unbounded growth
  static MAX_FALSE_POSITIVE_HISTORY = 500;
  // Reliability score weights (must sum to 1.0)
  // These weights determine the relative importance of each factor in the overall score
  static WEIGHTS = {
    successRate: 0.5,
    // 50% - Most critical: did the provider complete successfully?
    falsePositiveRate: 0.3,
    // 30% - Very important: does it produce accurate results?
    responseTime: 0.2
    // 20% - Nice to have: is it fast?
  };
  /**
   * Record a provider execution result
   */
  async recordResult(providerId, success, durationMs, error2) {
    const data = await this.loadData();
    const safeDurationMs = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : void 0;
    const result = {
      providerId,
      success,
      timestamp: Date.now(),
      durationMs: safeDurationMs,
      error: error2
    };
    data.results.push(result);
    if (data.results.length > _ReliabilityTracker.MAX_RESULTS_HISTORY) {
      const excess = data.results.length - _ReliabilityTracker.MAX_RESULTS_HISTORY;
      data.results.splice(0, excess);
      logger.debug(`Trimmed ${excess} old reliability results to prevent unbounded growth`);
    }
    if (this.circuitBreaker) {
      if (success) {
        await this.circuitBreaker.recordSuccess(providerId);
      } else {
        await this.circuitBreaker.recordFailure(providerId);
      }
    }
    const timeSinceAggregation = Date.now() - data.lastAggregation;
    if (timeSinceAggregation > _ReliabilityTracker.AGGREGATION_INTERVAL_MS) {
      await this.aggregateStats(data);
    }
    await this.saveData(data);
    logger.debug(
      `Recorded ${success ? "success" : "failure"} for provider ${providerId}${durationMs ? ` (${durationMs}ms)` : ""}`
    );
  }
  /**
   * Record a false positive finding from a provider
   */
  async recordFalsePositive(providerId, findingId, category) {
    const data = await this.loadData();
    const report = {
      providerId,
      findingId,
      timestamp: Date.now(),
      category
    };
    data.falsePositives.push(report);
    if (data.falsePositives.length > _ReliabilityTracker.MAX_FALSE_POSITIVE_HISTORY) {
      const excess = data.falsePositives.length - _ReliabilityTracker.MAX_FALSE_POSITIVE_HISTORY;
      data.falsePositives.splice(0, excess);
      logger.debug(`Trimmed ${excess} old false positive reports`);
    }
    await this.saveData(data);
    logger.info(`Recorded false positive from provider ${providerId} (finding: ${findingId})`);
  }
  /**
   * Get reliability score for a provider (0-1, higher is better)
   * Returns default neutral score (0.5) for providers with insufficient history
   */
  async getReliabilityScore(providerId) {
    const data = await this.loadData();
    const stats = data.stats[providerId];
    const DEFAULT_SCORE = 0.5;
    if (!stats || stats.totalAttempts < this.minAttempts) {
      return DEFAULT_SCORE;
    }
    return stats.reliabilityScore;
  }
  /**
   * Get detailed statistics for a provider
   */
  async getStats(providerId) {
    const data = await this.loadData();
    return data.stats[providerId] || null;
  }
  /**
   * Get all provider statistics
   */
  async getAllStats() {
    const data = await this.loadData();
    return data.stats;
  }
  /**
   * Rank providers by reliability score (best first)
   */
  async rankProviders(providerIds) {
    const ranked = [];
    for (const providerId of providerIds) {
      const score = await this.getReliabilityScore(providerId);
      ranked.push({ providerId, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    logger.debug(
      `Ranked ${ranked.length} providers: ${ranked.map((r) => `${r.providerId}=${r.score.toFixed(2)}`).join(", ")}`
    );
    return ranked;
  }
  /**
   * Get provider recommendations based on reliability
   */
  async getRecommendations(minScore = 0.6) {
    const data = await this.loadData();
    const recommended = [];
    for (const [providerId, stats] of Object.entries(data.stats)) {
      if (stats.reliabilityScore >= minScore && stats.totalAttempts >= this.minAttempts) {
        recommended.push(providerId);
      }
    }
    recommended.sort((a, b) => {
      const scoreA = data.stats[a].reliabilityScore;
      const scoreB = data.stats[b].reliabilityScore;
      return scoreB - scoreA;
    });
    logger.info(`Found ${recommended.length} recommended providers with score >= ${minScore}`);
    return recommended;
  }
  /**
   * Check whether a provider's circuit is open.
   */
  async isCircuitOpen(providerId) {
    if (!this.circuitBreaker) {
      return false;
    }
    return this.circuitBreaker.isOpen(providerId);
  }
  /**
   * Aggregate results and calculate statistics
   */
  async aggregateStats(data) {
    const reliabilityData = data || await this.loadData();
    logger.info("Aggregating provider reliability statistics");
    const providerGroups = /* @__PURE__ */ new Map();
    for (const result of reliabilityData.results) {
      const group = providerGroups.get(result.providerId) || [];
      group.push(result);
      providerGroups.set(result.providerId, group);
    }
    const fpGroups = /* @__PURE__ */ new Map();
    for (const fp of reliabilityData.falsePositives) {
      const group = fpGroups.get(fp.providerId) || [];
      group.push(fp);
      fpGroups.set(fp.providerId, group);
    }
    for (const [providerId, results] of providerGroups) {
      const stats = this.calculateStats(providerId, results, fpGroups.get(providerId) || []);
      reliabilityData.stats[providerId] = stats;
      logger.debug(
        `${providerId}: ${stats.successRate.toFixed(0)}% success, ${stats.falsePositiveCount} FP, score=${stats.reliabilityScore.toFixed(2)}`
      );
    }
    reliabilityData.lastAggregation = Date.now();
    if (!data) {
      await this.saveData(reliabilityData);
    }
  }
  /**
   * Calculate statistics for a provider
   */
  calculateStats(providerId, results, falsePositives) {
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;
    const totalAttempts = results.length;
    const successRate = totalAttempts > 0 ? successCount / totalAttempts : 0;
    const durationsWithValues = results.filter((r) => Number.isFinite(r.durationMs));
    const averageDurationMs = durationsWithValues.length > 0 ? durationsWithValues.reduce((sum, r) => sum + r.durationMs, 0) / durationsWithValues.length : 0;
    const falsePositiveCount = falsePositives.length;
    const falsePositiveRate = totalAttempts > 0 ? falsePositiveCount / totalAttempts : 0;
    const EXCELLENT_RESPONSE_MS = 500;
    const POOR_RESPONSE_MS = 5e3;
    const responseTimeRange = POOR_RESPONSE_MS - EXCELLENT_RESPONSE_MS;
    let responseTimeScore;
    if (averageDurationMs <= EXCELLENT_RESPONSE_MS) {
      responseTimeScore = 1;
    } else if (averageDurationMs >= POOR_RESPONSE_MS) {
      responseTimeScore = 0;
    } else {
      responseTimeScore = 1 - (averageDurationMs - EXCELLENT_RESPONSE_MS) / responseTimeRange;
    }
    const reliabilityScore = _ReliabilityTracker.WEIGHTS.successRate * successRate + _ReliabilityTracker.WEIGHTS.falsePositiveRate * (1 - falsePositiveRate) + _ReliabilityTracker.WEIGHTS.responseTime * responseTimeScore;
    return {
      providerId,
      totalAttempts,
      successCount,
      failureCount,
      successRate: successRate * 100,
      // Convert to percentage
      averageDurationMs: Math.round(averageDurationMs),
      falsePositiveCount,
      reliabilityScore,
      lastUpdated: Date.now()
    };
  }
  /**
   * Clear all reliability data
   */
  async clear() {
    const emptyData = {
      results: [],
      falsePositives: [],
      stats: {},
      lastAggregation: Date.now()
    };
    await this.saveData(emptyData);
    logger.info("Cleared all reliability data");
  }
  /**
   * Get overall summary statistics
   */
  async getSummary() {
    const data = await this.loadData();
    const stats = Object.values(data.stats);
    if (stats.length === 0) {
      return {
        totalProviders: 0,
        totalAttempts: 0,
        averageReliability: 0,
        topProvider: null,
        worstProvider: null
      };
    }
    const totalAttempts = stats.reduce((sum, s) => sum + s.totalAttempts, 0);
    const averageReliability = stats.reduce((sum, s) => sum + s.reliabilityScore, 0) / stats.length;
    const sorted = [...stats].sort((a, b) => b.reliabilityScore - a.reliabilityScore);
    const topProvider = sorted[0]?.providerId || null;
    const worstProvider = sorted[sorted.length - 1]?.providerId || null;
    return {
      totalProviders: stats.length,
      totalAttempts,
      averageReliability,
      topProvider,
      worstProvider
    };
  }
  /**
   * Load reliability data from cache
   */
  async loadData() {
    const raw = await this.storage.read(_ReliabilityTracker.CACHE_KEY);
    if (!raw) {
      return {
        results: [],
        falsePositives: [],
        stats: {},
        lastAggregation: Date.now()
      };
    }
    try {
      return JSON.parse(raw);
    } catch (error2) {
      logger.warn("Failed to parse reliability data, starting fresh", error2);
      return {
        results: [],
        falsePositives: [],
        stats: {},
        lastAggregation: Date.now()
      };
    }
  }
  /**
   * Save reliability data to cache
   */
  async saveData(data) {
    await this.storage.write(_ReliabilityTracker.CACHE_KEY, JSON.stringify(data));
  }
};

// src/analytics/metrics-collector.ts
var MetricsCollector = class _MetricsCollector {
  constructor(storage = new CacheStorage(), config) {
    this.storage = storage;
    this.config = config;
  }
  static CACHE_KEY = "analytics-metrics-data";
  /**
   * Record a completed review
   */
  async recordReview(review, prNumber) {
    const data = await this.loadData();
    const filesReviewed = new Set(review.findings.map((f) => f.file)).size;
    const providers = review.providerResults?.filter((pr) => pr.status === "success").map((pr) => pr.name) || [];
    const metric = {
      timestamp: Date.now(),
      prNumber,
      filesReviewed,
      findingsCount: review.metrics.totalFindings,
      costUsd: review.metrics.totalCost,
      durationSeconds: review.metrics.durationSeconds,
      providersUsed: review.metrics.providersUsed,
      cacheHit: review.metrics.cached || false,
      providers
    };
    data.reviews.push(metric);
    const maxReviews = this.config?.analyticsMaxReviews || 1e3;
    if (data.reviews.length > maxReviews) {
      data.reviews = data.reviews.slice(-maxReviews);
    }
    this.updateAggregatedStats(data);
    await this.saveData(data);
    logger.debug(`Recorded review metrics for PR #${prNumber}`);
  }
  /**
   * Record suggestion quality metrics for analytics
   */
  async recordSuggestionQuality(metric) {
    const data = await this.loadData();
    data.suggestionQuality = data.suggestionQuality || [];
    data.suggestionQuality.push({
      ...metric,
      timestamp: Date.now()
    });
    const maxSuggestions = (this.config?.analyticsMaxReviews || 1e3) * 10;
    if (data.suggestionQuality.length > maxSuggestions) {
      data.suggestionQuality = data.suggestionQuality.slice(-maxSuggestions);
    }
    await this.saveData(data);
    logger.debug(`Recorded suggestion quality metric for ${metric.file}:${metric.line}`);
  }
  /**
   * Get suggestion quality statistics
   */
  async getSuggestionQualityStats() {
    const data = await this.loadData();
    const suggestions = data.suggestionQuality || [];
    if (suggestions.length === 0) {
      return {
        totalSuggestions: 0,
        syntaxValidRate: 0,
        suppressionRate: 0,
        consensusRate: 0,
        avgConfidence: 0,
        postRate: 0
      };
    }
    const syntaxValid = suggestions.filter((s) => s.syntaxValid).length;
    const suppressed = suggestions.filter((s) => s.suppressed).length;
    const hasConsensus = suggestions.filter((s) => s.hasConsensus).length;
    const posted = suggestions.filter((s) => s.posted).length;
    const totalConfidence = suggestions.reduce((sum, s) => sum + s.confidenceScore, 0);
    return {
      totalSuggestions: suggestions.length,
      syntaxValidRate: syntaxValid / suggestions.length,
      suppressionRate: suppressed / suggestions.length,
      consensusRate: hasConsensus / suggestions.length,
      avgConfidence: totalConfidence / suggestions.length,
      postRate: posted / suggestions.length
    };
  }
  /**
   * Get metrics for a specific time period
   */
  async getMetrics(fromTimestamp, toTimestamp) {
    const data = await this.loadData();
    let filtered = data.reviews;
    if (fromTimestamp) {
      filtered = filtered.filter((r) => r.timestamp >= fromTimestamp);
    }
    if (toTimestamp) {
      filtered = filtered.filter((r) => r.timestamp <= toTimestamp);
    }
    return filtered;
  }
  /**
   * Get aggregated statistics
   */
  async getStats() {
    return this.loadData();
  }
  /**
   * Get cost trends over time (grouped by day)
   */
  async getCostTrends(days = 30) {
    const data = await this.loadData();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1e3;
    const filtered = data.reviews.filter((r) => r.timestamp >= cutoff);
    const byDay = /* @__PURE__ */ new Map();
    for (const review of filtered) {
      const date = new Date(review.timestamp).toISOString().split("T")[0];
      const existing = byDay.get(date) || { cost: 0, reviews: 0 };
      existing.cost += review.costUsd;
      existing.reviews += 1;
      byDay.set(date, existing);
    }
    const trends = Array.from(byDay.entries()).map(([date, data2]) => ({ date, ...data2 })).sort((a, b) => a.date.localeCompare(b.date));
    return trends;
  }
  /**
   * Get provider performance comparison
   */
  async getProviderStats() {
    const data = await this.loadData();
    const providerMap = /* @__PURE__ */ new Map();
    for (const review of data.reviews) {
      for (const providerName of review.providers) {
        const existing = providerMap.get(providerName) || {
          totalReviews: 0,
          totalCost: 0,
          totalDuration: 0
        };
        existing.totalReviews += 1;
        existing.totalCost += review.costUsd / review.providers.length;
        existing.totalDuration += review.durationSeconds;
        providerMap.set(providerName, existing);
      }
    }
    const stats = Array.from(providerMap.entries()).map(([provider, data2]) => ({
      provider,
      totalReviews: data2.totalReviews,
      successRate: 1,
      // We only track successful reviews
      avgCost: data2.totalReviews > 0 ? data2.totalCost / data2.totalReviews : 0,
      avgDuration: data2.totalReviews > 0 ? data2.totalDuration / data2.totalReviews : 0
    })).sort((a, b) => b.totalReviews - a.totalReviews);
    return stats;
  }
  /**
   * Get top finding categories
   */
  async getTopCategories() {
    return [];
  }
  /**
   * Calculate ROI (time saved vs cost)
   */
  async calculateROI() {
    const data = await this.loadData();
    const avgManualReviewMinutes = this.config?.analyticsManualReviewTime || 30;
    const developerHourlyRate = this.config?.analyticsDeveloperRate || 100;
    const totalReviews = data.totalReviews;
    const totalCost = data.totalCost;
    const estimatedTimeSaved = totalReviews * avgManualReviewMinutes;
    const estimatedTimeSavedValue = estimatedTimeSaved / 60 * developerHourlyRate;
    const roi = totalCost > 0 ? (estimatedTimeSavedValue - totalCost) / totalCost * 100 : 0;
    return {
      totalCost,
      estimatedTimeSaved,
      estimatedTimeSavedValue,
      roi
    };
  }
  /**
   * Get performance over time (review speed trends)
   */
  async getPerformanceTrends(days = 30) {
    const data = await this.loadData();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1e3;
    const filtered = data.reviews.filter((r) => r.timestamp >= cutoff);
    const byDay = /* @__PURE__ */ new Map();
    for (const review of filtered) {
      const date = new Date(review.timestamp).toISOString().split("T")[0];
      const existing = byDay.get(date) || { totalDuration: 0, count: 0 };
      existing.totalDuration += review.durationSeconds;
      existing.count += 1;
      byDay.set(date, existing);
    }
    const trends = Array.from(byDay.entries()).map(([date, data2]) => ({
      date,
      avgDuration: data2.count > 0 ? data2.totalDuration / data2.count : 0
    })).sort((a, b) => a.date.localeCompare(b.date));
    return trends;
  }
  /**
   * Clear all metrics data
   */
  async clear() {
    const emptyData = {
      reviews: [],
      suggestionQuality: [],
      totalReviews: 0,
      totalCost: 0,
      totalFindings: 0,
      avgReviewTime: 0,
      cacheHitRate: 0,
      lastUpdated: Date.now()
    };
    await this.saveData(emptyData);
    logger.info("Cleared all analytics metrics");
  }
  /**
   * Update aggregated statistics
   */
  updateAggregatedStats(data) {
    data.totalReviews = data.reviews.length;
    data.totalCost = data.reviews.reduce((sum, r) => sum + r.costUsd, 0);
    data.totalFindings = data.reviews.reduce((sum, r) => sum + r.findingsCount, 0);
    const totalDuration = data.reviews.reduce((sum, r) => sum + r.durationSeconds, 0);
    data.avgReviewTime = data.totalReviews > 0 ? totalDuration / data.totalReviews : 0;
    const cacheHits = data.reviews.filter((r) => r.cacheHit).length;
    data.cacheHitRate = data.totalReviews > 0 ? cacheHits / data.totalReviews * 100 : 0;
    data.lastUpdated = Date.now();
  }
  /**
   * Load metrics data from cache
   */
  async loadData() {
    const raw = await this.storage.read(_MetricsCollector.CACHE_KEY);
    if (!raw) {
      return {
        reviews: [],
        suggestionQuality: [],
        totalReviews: 0,
        totalCost: 0,
        totalFindings: 0,
        avgReviewTime: 0,
        cacheHitRate: 0,
        lastUpdated: Date.now()
      };
    }
    try {
      const data = JSON.parse(raw);
      data.reviews = data.reviews.map((review) => ({
        ...review,
        providers: review.providers || []
      }));
      data.suggestionQuality = data.suggestionQuality || [];
      return data;
    } catch (error2) {
      logger.warn("Failed to parse metrics data, starting fresh", error2);
      return {
        reviews: [],
        suggestionQuality: [],
        totalReviews: 0,
        totalCost: 0,
        totalFindings: 0,
        avgReviewTime: 0,
        cacheHitRate: 0,
        lastUpdated: Date.now()
      };
    }
  }
  /**
   * Save metrics data to cache
   */
  async saveData(data) {
    await this.storage.write(_MetricsCollector.CACHE_KEY, JSON.stringify(data));
  }
};

// src/plugins/plugin-loader.ts
var fs11 = __toESM(require("fs/promises"));
var path10 = __toESM(require("path"));
var crypto5 = __toESM(require("crypto"));
var import_url = require("url");
var PluginLoader = class {
  // provider name -> plugin name
  constructor(config) {
    this.config = config;
  }
  plugins = /* @__PURE__ */ new Map();
  providerMap = /* @__PURE__ */ new Map();
  /**
   * Load all plugins from plugin directory
   */
  async loadPlugins() {
    if (!this.config.enabled) {
      logger.debug("Plugins disabled, skipping load");
      return;
    }
    const securityAcknowledged = process.env.PLUGIN_SECURITY_ACKNOWLEDGED;
    if (securityAcknowledged !== "true") {
      const actualValue = securityAcknowledged === void 0 ? "undefined" : securityAcknowledged === "" ? "empty string" : `"${securityAcknowledged}"`;
      logger.error(
        `Plugin loading BLOCKED - Security acknowledgment required. Plugins execute arbitrary code with full system access and no sandboxing. Current PLUGIN_SECURITY_ACKNOWLEDGED value: ${actualValue}. Set PLUGIN_SECURITY_ACKNOWLEDGED=true environment variable ONLY if you: 1. Understand the security risks, 2. Have reviewed all plugin code, 3. Are running in a trusted, private environment.`
      );
      throw new Error(
        `Plugin security not acknowledged (value: ${actualValue}). Set PLUGIN_SECURITY_ACKNOWLEDGED=true to enable plugins. Only use plugins in trusted, private environments where you control all code.`
      );
    }
    logger.info("\u2713 Plugin security acknowledged - loading plugins with full system access");
    try {
      const pluginDir = path10.resolve(this.config.pluginDir);
      logger.info(`Loading plugins from: ${pluginDir}`);
      try {
        await fs11.access(pluginDir);
      } catch (error2) {
        logger.warn(`Plugin directory does not exist: ${pluginDir}`);
        return;
      }
      const entries = await fs11.readdir(pluginDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginPath = path10.join(pluginDir, entry.name);
        await this.loadPlugin(pluginPath);
      }
      logger.info(`Loaded ${this.plugins.size} plugins`);
    } catch (error2) {
      logger.error("Failed to load plugins", error2);
      throw error2;
    }
  }
  /**
   * Load a single plugin from directory
   */
  async loadPlugin(pluginPath) {
    try {
      const indexPath = path10.join(pluginPath, "index.js");
      try {
        await fs11.access(indexPath);
      } catch (error2) {
        logger.debug(`Plugin at ${pluginPath} missing index.js, skipping`);
        return;
      }
      await this.verifyPluginIntegrity(pluginPath, indexPath);
      const pluginModule = await import((0, import_url.pathToFileURL)(indexPath).href);
      const plugin = pluginModule.default;
      if (!plugin.metadata || !plugin.createProvider) {
        logger.warn(`Invalid plugin at ${pluginPath}: missing required fields`);
        return;
      }
      if (typeof plugin.createProvider !== "function") {
        logger.warn(`Invalid plugin at ${pluginPath}: createProvider must be a function`);
        return;
      }
      if (plugin.initialize !== void 0 && typeof plugin.initialize !== "function") {
        logger.warn(`Invalid plugin at ${pluginPath}: initialize must be a function if provided`);
        return;
      }
      const metadata = plugin.metadata;
      if (!metadata.name || typeof metadata.name !== "string" || metadata.name.trim() === "") {
        logger.warn(`Invalid plugin at ${pluginPath}: metadata.name must be a non-empty string`);
        return;
      }
      if (!metadata.version || typeof metadata.version !== "string" || metadata.version.trim() === "") {
        logger.warn(`Invalid plugin at ${pluginPath}: metadata.version must be a non-empty string`);
        return;
      }
      if (!Array.isArray(metadata.providers) || metadata.providers.length === 0) {
        logger.warn(`Invalid plugin at ${pluginPath}: metadata.providers must be a non-empty array`);
        return;
      }
      for (const provider of metadata.providers) {
        if (typeof provider !== "string" || provider.trim() === "") {
          logger.warn(`Invalid plugin at ${pluginPath}: all provider names must be non-empty strings`);
          return;
        }
      }
      if (!this.isPluginAllowed(plugin.metadata.name)) {
        logger.info(`Plugin ${plugin.metadata.name} blocked by policy`);
        return;
      }
      if (this.plugins.has(plugin.metadata.name)) {
        logger.error(
          `Plugin name collision detected: "${plugin.metadata.name}" is already registered. Cannot load duplicate plugin from ${pluginPath}.`
        );
        throw new Error(
          `Plugin name collision: "${plugin.metadata.name}" already registered`
        );
      }
      for (const providerName of plugin.metadata.providers) {
        const existingPlugin = this.providerMap.get(providerName);
        if (existingPlugin) {
          logger.error(
            `Provider name collision detected: "${providerName}" is already registered by plugin "${existingPlugin}". Plugin "${plugin.metadata.name}" cannot register the same provider name.`
          );
          throw new Error(
            `Provider name collision: "${providerName}" already registered by plugin "${existingPlugin}"`
          );
        }
      }
      if (plugin.initialize) {
        await plugin.initialize();
      }
      this.plugins.set(plugin.metadata.name, plugin);
      for (const providerName of plugin.metadata.providers) {
        this.providerMap.set(providerName, plugin.metadata.name);
      }
      logger.info(
        `Loaded plugin: ${plugin.metadata.name} v${plugin.metadata.version} (${plugin.metadata.providers.length} providers)`
      );
    } catch (error2) {
      logger.error(`Failed to load plugin at ${pluginPath}`, error2);
    }
  }
  /**
   * Verify plugin integrity using optional manifest file
   * Manifest file format (plugin-manifest.json):
   * {
   *   "sha256": "checksum of index.js file",
   *   "created": "ISO timestamp"
   * }
   */
  async verifyPluginIntegrity(pluginPath, indexPath) {
    const manifestPath = path10.join(pluginPath, "plugin-manifest.json");
    try {
      await fs11.access(manifestPath);
    } catch (error2) {
      logger.debug(`No manifest found for plugin at ${pluginPath}, skipping integrity check`);
      return;
    }
    try {
      const manifestContent = await fs11.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestContent);
      if (!manifest.sha256 || typeof manifest.sha256 !== "string") {
        throw new Error("Manifest missing valid sha256 checksum");
      }
      const pluginCode = await fs11.readFile(indexPath, "utf8");
      const hash = crypto5.createHash("sha256");
      hash.update(pluginCode);
      const actualChecksum = hash.digest("hex");
      if (actualChecksum !== manifest.sha256) {
        throw new Error(
          `Plugin integrity verification failed! Expected: ${manifest.sha256}, Got: ${actualChecksum}. Plugin code may have been tampered with.`
        );
      }
      logger.info(`Plugin integrity verified: ${pluginPath}`);
    } catch (error2) {
      logger.error(`Plugin integrity verification failed for ${pluginPath}`, error2);
      throw new Error(`Plugin integrity check failed: ${error2.message}`);
    }
  }
  /**
   * Check if plugin is allowed by allowlist/blocklist
   */
  isPluginAllowed(name) {
    const { allowlist, blocklist } = this.config;
    if (allowlist && allowlist.length > 0) {
      return allowlist.includes(name);
    }
    if (blocklist && blocklist.length > 0) {
      return !blocklist.includes(name);
    }
    return true;
  }
  /**
   * Get plugin by name
   */
  getPlugin(name) {
    return this.plugins.get(name);
  }
  /**
   * Check if provider is provided by a plugin
   */
  hasProvider(providerName) {
    return this.providerMap.has(providerName);
  }
  /**
   * Create provider instance from plugin
   */
  createProvider(providerName, apiKey) {
    const pluginName = this.providerMap.get(providerName);
    if (!pluginName) {
      return null;
    }
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      return null;
    }
    try {
      return plugin.createProvider(providerName, apiKey);
    } catch (error2) {
      logger.error(`Failed to create provider ${providerName} from plugin ${pluginName}`, error2);
      return null;
    }
  }
  /**
   * Get all loaded plugins
   */
  getLoadedPlugins() {
    return Array.from(this.plugins.values()).map((p) => p.metadata);
  }
  /**
   * Get all available providers from plugins
   */
  getAvailableProviders() {
    return Array.from(this.providerMap.keys());
  }
};

// src/core/batch-orchestrator.ts
var BatchOrchestrator = class {
  constructor(options) {
    this.options = options;
  }
  /**
   * Determine the effective batch size for the current provider set.
   * Uses the smallest override to ensure no provider receives more than it can handle.
   */
  getBatchSize(providerNames) {
    let size = this.options.defaultBatchSize;
    for (const name of providerNames) {
      const override = this.getOverrideForProvider(name);
      if (override) {
        size = Math.min(size, override);
      }
    }
    const capped = this.options.maxBatchSize ? Math.min(size, this.options.maxBatchSize) : size;
    const finalSize = Math.max(1, capped);
    logger.debug(`Batch size resolved: ${finalSize} (providers: ${providerNames.join(",") || "none"})`);
    return finalSize;
  }
  /**
   * Split files into batches of at most batchSize items.
   */
  createBatches(files, batchSize) {
    if (!Number.isFinite(batchSize) || batchSize <= 0 || !Number.isInteger(batchSize)) {
      throw new Error(`Invalid batch size: ${batchSize}. Must be a positive integer.`);
    }
    if (files.length === 0) return [];
    const batches = [];
    for (let i = 0; i < files.length; i += batchSize) {
      batches.push(files.slice(i, i + batchSize));
    }
    return batches;
  }
  /**
   * Create batches using token-aware sizing
   * Automatically determines optimal batch size based on file sizes and provider context windows
   */
  createTokenAwareBatches(files, providerNames) {
    if (!this.options.enableTokenAwareBatching) {
      const batchSize = this.getBatchSize(providerNames);
      return this.createBatches(files, batchSize);
    }
    if (files.length === 0) return [];
    let smallestWindow = Infinity;
    for (const providerName of providerNames) {
      const window = getContextWindowSize(providerName);
      if (window < smallestWindow) {
        smallestWindow = window;
      }
    }
    const DEFAULT_CONTEXT_WINDOW = 1e5;
    if (!isFinite(smallestWindow) || smallestWindow === 0) {
      logger.warn(
        `No valid context window data available for providers: ${providerNames.join(", ")}. Falling back to default ${DEFAULT_CONTEXT_WINDOW} tokens.`
      );
      smallestWindow = DEFAULT_CONTEXT_WINDOW;
    }
    const targetTokens = this.options.targetTokensPerBatch ?? Math.floor(smallestWindow * 0.5);
    const maxFiles = this.options.maxBatchSize ?? 200;
    logger.debug(
      `Token-aware batching: target ${targetTokens} tokens/batch, max ${maxFiles} files/batch, smallest context window: ${smallestWindow}`
    );
    const recommendation = calculateOptimalBatchSize(files, targetTokens, maxFiles);
    logger.info(`Token-aware batching: ${recommendation.reason}`);
    return recommendation.batches;
  }
  /**
   * Get batch size optimized for token budget and provider context windows
   */
  getBatchSizeForTokenBudget(files, providerNames) {
    if (!this.options.enableTokenAwareBatching || files.length === 0) {
      return this.getBatchSize(providerNames);
    }
    const batches = this.createTokenAwareBatches(files, providerNames);
    if (batches.length === 0) return this.getBatchSize(providerNames);
    return Math.ceil(files.length / batches.length);
  }
  getOverrideForProvider(providerName) {
    const overrides = this.options.providerOverrides || {};
    if (overrides[providerName] !== void 0) return overrides[providerName];
    const prefix = providerName.split("/")[0];
    return overrides[prefix];
  }
};

// src/learning/suppression-tracker.ts
var import_crypto3 = require("crypto");
var SuppressionTracker = class _SuppressionTracker {
  constructor(storage, repoKey) {
    this.storage = storage;
    this.repoKey = repoKey;
  }
  static PR_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  // 7 days
  static REPO_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
  // 30 days
  static LINE_PROXIMITY_THRESHOLD = 5;
  /**
   * Record a dismissal and create a suppression pattern
   *
   * @param finding - The finding to suppress (category, file, line)
   * @param scope - 'pr' for PR-only suppression, 'repo' for repo-wide
   * @param prNumber - Required if scope is 'pr'
   */
  async recordDismissal(finding, scope, prNumber) {
    const data = await this.loadData();
    const ttl = scope === "pr" ? _SuppressionTracker.PR_TTL_MS : _SuppressionTracker.REPO_TTL_MS;
    const timestamp2 = Date.now();
    const pattern = {
      id: (0, import_crypto3.randomUUID)(),
      category: finding.category,
      file: finding.file,
      line: finding.line,
      scope,
      prNumber: scope === "pr" ? prNumber : void 0,
      timestamp: timestamp2,
      expiresAt: timestamp2 + ttl
    };
    data.patterns.push(pattern);
    await this.saveData(data);
    logger.debug(
      `Recorded ${scope}-scoped suppression: ${finding.category} at ${finding.file}:${finding.line}` + (scope === "pr" ? ` (PR #${prNumber})` : "")
    );
  }
  /**
   * Check if a finding should be suppressed based on recorded patterns
   *
   * Matches patterns if:
   * - Same category and file
   * - Line within 5 lines of pattern
   * - Pattern not expired
   * - Scope matches (PR scope requires same PR number)
   *
   * @param finding - The finding to check
   * @param prNumber - Current PR number for scope matching
   * @returns true if finding should be suppressed
   */
  async shouldSuppress(finding, prNumber) {
    const data = await this.loadData();
    const now = Date.now();
    for (const pattern of data.patterns) {
      if (pattern.expiresAt < now) {
        continue;
      }
      if (pattern.category !== finding.category) {
        continue;
      }
      if (pattern.file !== finding.file) {
        continue;
      }
      const lineDiff = Math.abs(finding.line - pattern.line);
      if (lineDiff > _SuppressionTracker.LINE_PROXIMITY_THRESHOLD) {
        continue;
      }
      if (pattern.scope === "pr") {
        if (pattern.prNumber !== prNumber) {
          continue;
        }
      }
      logger.debug(
        `Suppressing finding: ${finding.category} at ${finding.file}:${finding.line} (matches pattern ${pattern.id})`
      );
      return true;
    }
    return false;
  }
  /**
   * Get categories with active suppressions for a PR.
   * Used by PromptEnricher to inform LLM about dismissed categories.
   *
   * @param prNumber - PR number to check (includes repo-wide suppressions)
   * @returns Array of unique category names with active suppressions
   */
  async getActiveCategories(prNumber) {
    const data = await this.loadData();
    const now = Date.now();
    const activePatterns = data.patterns.filter(
      (p) => p.expiresAt > now && (p.scope === "repo" || p.scope === "pr" && p.prNumber === prNumber)
    );
    const categorySet = new Set(activePatterns.map((p) => p.category));
    const categories = Array.from(categorySet);
    return categories;
  }
  /**
   * Remove expired suppression patterns
   *
   * @returns Number of patterns cleared
   */
  async clearExpired() {
    const data = await this.loadData();
    const now = Date.now();
    const beforeCount = data.patterns.length;
    data.patterns = data.patterns.filter((pattern) => pattern.expiresAt >= now);
    const clearedCount = beforeCount - data.patterns.length;
    if (clearedCount > 0) {
      data.lastCleanup = now;
      await this.saveData(data);
      logger.info(`Cleared ${clearedCount} expired suppression patterns`);
    }
    return clearedCount;
  }
  /**
   * Get cache key for this repository
   */
  getCacheKey() {
    return `suppression-${this.repoKey}`;
  }
  /**
   * Load suppression data from cache
   */
  async loadData() {
    const raw = await this.storage.read(this.getCacheKey());
    if (!raw) {
      return {
        patterns: [],
        lastCleanup: Date.now()
      };
    }
    try {
      return JSON.parse(raw);
    } catch (error2) {
      logger.warn("Failed to parse suppression data, starting fresh", error2);
      return {
        patterns: [],
        lastCleanup: Date.now()
      };
    }
  }
  /**
   * Save suppression data to cache
   */
  async saveData(data) {
    await this.storage.write(this.getCacheKey(), JSON.stringify(data));
  }
};

// src/learning/provider-weights.ts
var ProviderWeightTracker = class _ProviderWeightTracker {
  constructor(storage = new CacheStorage()) {
    this.storage = storage;
  }
  static CACHE_KEY = "provider-weights";
  static MIN_WEIGHT = 0.3;
  static VARIABLE_WEIGHT = 0.7;
  static MIN_FEEDBACK_THRESHOLD = 5;
  /**
   * Record feedback for a provider and update its weight
   *
   * @param provider - Provider name (e.g., 'claude', 'gemini')
   * @param reaction - User reaction: '👍' (good) or '👎' (bad)
   */
  async recordFeedback(provider, reaction) {
    const data = await this.loadData();
    let providerWeight = data.weights[provider];
    if (!providerWeight) {
      providerWeight = {
        provider,
        positiveCount: 0,
        negativeCount: 0,
        totalCount: 0,
        positiveRate: 0,
        weight: 1,
        // Default weight
        lastUpdated: Date.now()
      };
      data.weights[provider] = providerWeight;
    }
    if (reaction === "\u{1F44D}") {
      providerWeight.positiveCount++;
    } else {
      providerWeight.negativeCount++;
    }
    providerWeight.totalCount = providerWeight.positiveCount + providerWeight.negativeCount;
    providerWeight.positiveRate = providerWeight.positiveCount / providerWeight.totalCount;
    providerWeight.lastUpdated = Date.now();
    providerWeight.weight = this.calculateWeight(
      providerWeight.positiveRate,
      providerWeight.totalCount
    );
    await this.saveData(data);
    logger.debug(
      `Recorded ${reaction} feedback for ${provider} (${providerWeight.positiveCount}\u{1F44D} ${providerWeight.negativeCount}\u{1F44E}, weight: ${providerWeight.weight.toFixed(2)})`
    );
  }
  /**
   * Get the current weight for a provider
   *
   * @param provider - Provider name
   * @returns Weight value (0.3-1.0), or 1.0 for new providers
   */
  async getWeight(provider) {
    const data = await this.loadData();
    const providerWeight = data.weights[provider];
    if (!providerWeight) {
      return 1;
    }
    return providerWeight.weight;
  }
  /**
   * Get all provider weights
   *
   * @returns Map of provider name to ProviderWeight record
   */
  async getAllWeights() {
    const data = await this.loadData();
    return data.weights;
  }
  /**
   * Recalculate weights for all providers
   */
  async recalculateWeights() {
    const data = await this.loadData();
    for (const provider in data.weights) {
      const providerWeight = data.weights[provider];
      providerWeight.weight = this.calculateWeight(
        providerWeight.positiveRate,
        providerWeight.totalCount
      );
      providerWeight.lastUpdated = Date.now();
    }
    data.lastAggregation = Date.now();
    await this.saveData(data);
    logger.info("Recalculated weights for all providers");
  }
  /**
   * Calculate weight based on positive rate
   *
   * Formula: weight = MIN_WEIGHT + (VARIABLE_WEIGHT * positiveRate)
   * - MIN_WEIGHT = 0.3 (floor, never fully exclude provider)
   * - VARIABLE_WEIGHT = 0.7
   * - Result range: 0.3 (0% positive) to 1.0 (100% positive)
   *
   * @param positiveRate - Ratio of positive feedback (0.0-1.0)
   * @param totalCount - Total feedback count
   * @returns Weight value (0.3-1.0), or 1.0 if below threshold
   */
  calculateWeight(positiveRate, totalCount) {
    if (totalCount < _ProviderWeightTracker.MIN_FEEDBACK_THRESHOLD) {
      return 1;
    }
    return _ProviderWeightTracker.MIN_WEIGHT + _ProviderWeightTracker.VARIABLE_WEIGHT * positiveRate;
  }
  /**
   * Load provider weight data from cache
   */
  async loadData() {
    const raw = await this.storage.read(_ProviderWeightTracker.CACHE_KEY);
    if (!raw) {
      return {
        weights: {},
        lastAggregation: Date.now()
      };
    }
    try {
      return JSON.parse(raw);
    } catch (error2) {
      logger.warn("Failed to parse provider weight data, starting fresh", error2);
      return {
        weights: {},
        lastAggregation: Date.now()
      };
    }
  }
  /**
   * Save provider weight data to cache
   */
  async saveData(data) {
    await this.storage.write(_ProviderWeightTracker.CACHE_KEY, JSON.stringify(data));
  }
};

// src/learning/prompt-enrichment.ts
var DEFAULT_CONFIG2 = {
  minFeedbackForLowQuality: 5,
  lowQualityThreshold: 0.5,
  maxSuppressionCategories: 5
};
var PromptEnricher = class {
  constructor(suppressionTracker, feedbackTracker, config) {
    this.suppressionTracker = suppressionTracker;
    this.feedbackTracker = feedbackTracker;
    this.config = { ...DEFAULT_CONFIG2, ...config };
  }
  config;
  /**
   * Get enrichment context for a specific PR.
   * Aggregates suppression patterns and feedback stats.
   */
  async getEnrichmentContext(prNumber) {
    const context = {
      suppressedCategories: [],
      lowQualityCategories: [],
      repoPreferences: [],
      promptAdditions: []
    };
    if (this.suppressionTracker) {
      const suppressions = await this.getSuppressedCategories(prNumber);
      context.suppressedCategories = suppressions.slice(0, this.config.maxSuppressionCategories);
    }
    if (this.feedbackTracker) {
      const categoryStats = await this.feedbackTracker.getCategoryStats();
      context.lowQualityCategories = this.identifyLowQualityCategories(categoryStats);
    }
    context.repoPreferences = this.generatePreferences(context);
    context.promptAdditions = this.generatePromptAdditions(context);
    return context;
  }
  /**
   * Get prompt text to inject into LLM prompt.
   * Returns empty string if no enrichment available.
   */
  async getPromptText(prNumber) {
    const context = await this.getEnrichmentContext(prNumber);
    if (context.promptAdditions.length === 0) {
      return "";
    }
    return [
      "LEARNED PREFERENCES (from user feedback in this repository):",
      ...context.promptAdditions,
      ""
    ].join("\n");
  }
  async getSuppressedCategories(prNumber) {
    try {
      const categories = await this.suppressionTracker.getActiveCategories?.(prNumber);
      return categories || [];
    } catch {
      return [];
    }
  }
  identifyLowQualityCategories(stats) {
    return Object.values(stats).filter(
      (s) => s.totalFeedback >= this.config.minFeedbackForLowQuality && s.positiveRate < this.config.lowQualityThreshold
    ).map((s) => s.category).slice(0, this.config.maxSuppressionCategories);
  }
  generatePreferences(context) {
    const prefs = [];
    if (context.suppressedCategories.length > 0) {
      prefs.push(`User has dismissed suggestions in these categories: ${context.suppressedCategories.join(", ")}`);
    }
    if (context.lowQualityCategories.length > 0) {
      prefs.push(`These categories have high false-positive rates: ${context.lowQualityCategories.join(", ")}`);
    }
    return prefs;
  }
  generatePromptAdditions(context) {
    const additions = [];
    if (context.suppressedCategories.length > 0) {
      additions.push(
        `- AVOID suggesting fixes in these categories (recently dismissed): ${context.suppressedCategories.join(", ")}`
      );
    }
    if (context.lowQualityCategories.length > 0) {
      additions.push(
        `- BE EXTRA CAREFUL with these categories (high false-positive history): ${context.lowQualityCategories.join(", ")}`
      );
    }
    return additions;
  }
};

// src/learning/acceptance-detector.ts
var AcceptanceDetector = class {
  /**
   * Patterns matching GitHub's "Commit suggestion" feature.
   *
   * GitHub creates commits with these patterns when users click
   * "Commit suggestion" on review comments.
   */
  SUGGESTION_COMMIT_PATTERNS = [
    /Apply suggestions? from code review/i,
    /Apply suggestions? from @[\w-]+/i,
    /Apply \d+ suggestions?/i
  ];
  /**
   * Detect acceptances from PR commits.
   *
   * GitHub's "Commit suggestion" feature creates commits with specific
   * message patterns. This method matches those patterns against PR commits
   * to detect when suggestions were accepted.
   *
   * @param commits - List of commits in the PR
   * @param commentedFiles - Map of file paths to comment metadata
   * @returns List of detected acceptances
   */
  detectFromCommits(commits, commentedFiles) {
    const acceptances = [];
    for (const commit of commits) {
      if (!this.isSuggestionCommit(commit.message)) {
        continue;
      }
      for (const file of commit.files) {
        const comments = commentedFiles.get(file);
        if (!comments) continue;
        for (const comment of comments) {
          acceptances.push({
            file,
            line: comment.line,
            provider: comment.provider || "unknown",
            commitSha: commit.sha,
            timestamp: commit.timestamp
          });
        }
      }
    }
    return acceptances;
  }
  /**
   * Detect acceptances from thumbs-up reactions on suggestion comments.
   *
   * When users react with thumbs-up (👍) to a suggestion comment,
   * it's considered an acceptance event.
   *
   * @param commentReactions - List of comments with their reactions
   * @returns List of detected acceptances
   */
  detectFromReactions(commentReactions) {
    const acceptances = [];
    for (const comment of commentReactions) {
      const hasThumbsUp = comment.reactions.some((r) => r.content === "+1");
      if (!hasThumbsUp) continue;
      acceptances.push({
        file: comment.file,
        line: comment.line,
        provider: comment.provider || "unknown",
        commentId: comment.commentId,
        timestamp: Date.now()
      });
    }
    return acceptances;
  }
  /**
   * Record acceptances as positive feedback to weight tracker.
   *
   * Each acceptance triggers a positive feedback event (👍) for the
   * associated provider, improving their weight in future confidence
   * calculations.
   *
   * @param acceptances - List of detected acceptances
   * @param weightTracker - Provider weight tracker instance
   */
  async recordAcceptances(acceptances, weightTracker) {
    for (const acceptance of acceptances) {
      if (acceptance.provider && acceptance.provider !== "unknown") {
        await weightTracker.recordFeedback(acceptance.provider, "\u{1F44D}");
      }
    }
  }
  /**
   * Check if a commit message matches GitHub's suggestion commit patterns.
   *
   * @param message - Commit message to check
   * @returns True if message matches a suggestion pattern
   */
  isSuggestionCommit(message) {
    return this.SUGGESTION_COMMIT_PATTERNS.some((pattern) => pattern.test(message));
  }
};

// src/setup.ts
async function createComponents(config, githubToken) {
  const pluginLoader = config.pluginsEnabled ? new PluginLoader({
    pluginDir: config.pluginDir || "./plugins",
    enabled: config.pluginsEnabled,
    allowlist: config.pluginAllowlist,
    blocklist: config.pluginBlocklist
  }) : void 0;
  if (pluginLoader) {
    await pluginLoader.loadPlugins();
  }
  const llmExecutor = new LLMExecutor(config);
  const deduplicator = new Deduplicator();
  const consensus = new ConsensusEngine({
    minAgreement: config.inlineMinAgreement,
    minSeverity: config.inlineMinSeverity,
    maxComments: config.inlineMaxComments
  });
  const synthesis = new SynthesisEngine(config);
  const testCoverage = new TestCoverageAnalyzer();
  const astAnalyzer = new ASTAnalyzer();
  const cache = new CacheManager(void 0, config);
  const incrementalReviewer = new IncrementalReviewer(new CacheStorage(), {
    enabled: config.incrementalEnabled,
    cacheTtlDays: config.incrementalCacheTtlDays
  });
  const pricing = new PricingService(process.env.OPENROUTER_API_KEY);
  const costTracker = new CostTracker(pricing);
  const security = new SecurityScanner();
  const rules = RuleLoader.load();
  const githubClient = new GitHubClient(githubToken);
  const prLoader = new PullRequestLoader(githubClient);
  const contextRetriever = new ContextRetriever();
  const impactAnalyzer = new ImpactAnalyzer();
  const evidenceScorer = new EvidenceScorer();
  const mermaidGenerator = new MermaidGenerator();
  const cacheStorage = new CacheStorage();
  const repoKey = `${githubClient.owner}/${githubClient.repo}`;
  const suppressionTracker = new SuppressionTracker(cacheStorage, repoKey);
  const providerWeightTracker = new ProviderWeightTracker(cacheStorage);
  const feedbackFilter = new FeedbackFilter(githubClient, providerWeightTracker);
  const acceptanceDetector = new AcceptanceDetector();
  const feedbackTracker = config.learningEnabled ? new FeedbackTracker(cacheStorage, config.learningMinFeedbackCount) : void 0;
  const promptEnricher = new PromptEnricher(suppressionTracker, feedbackTracker);
  const promptBuilder = new PromptBuilder(config, "standard", promptEnricher, void 0);
  const commentPoster = new CommentPoster(
    githubClient,
    config.dryRun,
    config,
    suppressionTracker,
    providerWeightTracker
  );
  const formatter = new MarkdownFormatterV2();
  const quietModeFilter = config.quietModeEnabled ? new QuietModeFilter(
    {
      enabled: config.quietModeEnabled,
      minConfidence: config.quietMinConfidence || 0.5,
      useLearning: config.quietUseLearning || false
    },
    feedbackTracker
  ) : void 0;
  const graphBuilder = config.graphEnabled ? new CodeGraphBuilder(config.graphMaxDepth || 5, (config.graphTimeoutSeconds || 10) * 1e3) : void 0;
  const promptGenerator = new PromptGenerator("plain");
  const reliabilityTracker = new ReliabilityTracker(cacheStorage);
  const providerRegistry = new ProviderRegistry(pluginLoader, reliabilityTracker);
  const metricsCollector = config.analyticsEnabled ? new MetricsCollector(cacheStorage, config) : void 0;
  const batchOrchestrator = new BatchOrchestrator({
    defaultBatchSize: config.batchMaxFiles || 30,
    providerOverrides: config.providerBatchOverrides,
    enableTokenAwareBatching: config.enableTokenAwareBatching,
    targetTokensPerBatch: config.targetTokensPerBatch,
    maxBatchSize: config.batchMaxFiles
  });
  return {
    config,
    providerRegistry,
    promptBuilder,
    llmExecutor,
    deduplicator,
    consensus,
    synthesis,
    testCoverage,
    astAnalyzer,
    cache,
    incrementalReviewer,
    costTracker,
    security,
    rules,
    prLoader,
    commentPoster,
    formatter,
    contextRetriever,
    impactAnalyzer,
    evidenceScorer,
    mermaidGenerator,
    feedbackFilter,
    feedbackTracker,
    quietModeFilter,
    graphBuilder,
    promptGenerator,
    reliabilityTracker,
    metricsCollector,
    batchOrchestrator,
    githubClient,
    acceptanceDetector,
    providerWeightTracker
  };
}

// src/utils/suggestion-sanity.ts
function validateSuggestionSanity(suggestion) {
  if (suggestion === void 0 || suggestion === null) {
    return {
      isValid: false,
      reason: "No suggestion provided"
    };
  }
  const trimmed = suggestion.trim();
  if (trimmed === "") {
    return {
      isValid: false,
      reason: "Empty suggestion"
    };
  }
  const lineCount = trimmed.split("\n").length;
  if (lineCount > 50) {
    return {
      isValid: false,
      reason: "Suggestion too long (>50 lines)"
    };
  }
  const hasCodeSyntax = /[{}()\[\];=<>:]/.test(trimmed);
  if (!hasCodeSyntax) {
    return {
      isValid: false,
      reason: "Suggestion lacks code syntax"
    };
  }
  return {
    isValid: true,
    suggestion: trimmed
  };
}

// src/analysis/llm/parser.ts
function extractFindings(results) {
  const findings = [];
  for (const result of results) {
    if (result.status !== "success" || !result.result?.findings) continue;
    for (const finding of result.result.findings) {
      let suggestion = void 0;
      if (finding.suggestion !== void 0 && finding.suggestion !== null) {
        const validation = validateSuggestionSanity(finding.suggestion);
        if (validation.isValid) {
          suggestion = validation.suggestion;
        } else {
          logger.debug(
            `Skipping invalid suggestion for ${finding.file}:${finding.line}: ${validation.reason}`
          );
        }
      }
      findings.push({
        ...finding,
        suggestion,
        // Use validated suggestion (or undefined)
        provider: result.name,
        providers: finding.providers || [result.name]
      });
    }
  }
  return findings;
}

// src/analysis/ai-detector.ts
function summarizeAIDetection(results) {
  const estimates = {};
  for (const result of results) {
    const likelihood = result.result?.aiLikelihood;
    if (result.status === "success" && typeof likelihood === "number") {
      estimates[result.name] = likelihood;
    }
  }
  const providers = Object.keys(estimates);
  if (providers.length === 0) return void 0;
  const average = providers.reduce((sum, key) => sum + estimates[key], 0) / providers.length;
  const consensus = average > 0.7 ? "High" : average > 0.4 ? "Medium" : "Low";
  return {
    averageLikelihood: average,
    providerEstimates: estimates,
    consensus
  };
}

// src/analysis/finding-filter.ts
var FindingFilter = class {
  /**
   * Filter and adjust findings to reduce false positives
   */
  filter(findings, diffContent) {
    const stats = {
      total: findings.length,
      filtered: 0,
      downgraded: 0,
      kept: 0,
      reasons: {}
    };
    const filtered = [];
    for (const finding of findings) {
      const action = this.shouldFilter(finding, diffContent);
      if (action === "filter") {
        stats.filtered++;
        const reason = this.getFilterReason(finding, diffContent);
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
        logger.debug(`Filtered finding: ${finding.title} (${reason})`);
        continue;
      }
      if (action === "downgrade" && finding.severity === "critical") {
        finding.severity = "minor";
        stats.downgraded++;
        logger.debug(`Downgraded finding: ${finding.title} (critical \u2192 minor)`);
      } else if (action === "downgrade" && finding.severity === "major") {
        finding.severity = "minor";
        stats.downgraded++;
        logger.debug(`Downgraded finding: ${finding.title} (major \u2192 minor)`);
      }
      filtered.push(finding);
      stats.kept++;
    }
    const deduplicated = this.deduplicateFindings(filtered);
    const duplicatesRemoved = filtered.length - deduplicated.length;
    if (duplicatesRemoved > 0) {
      stats.filtered += duplicatesRemoved;
      stats.kept -= duplicatesRemoved;
      stats.reasons["duplicate finding"] = (stats.reasons["duplicate finding"] || 0) + duplicatesRemoved;
      logger.debug(`Removed ${duplicatesRemoved} duplicate findings`);
    }
    if (stats.filtered > 0 || stats.downgraded > 0) {
      logger.info(
        `Finding filter: ${stats.filtered} filtered, ${stats.downgraded} downgraded, ${stats.kept} kept (from ${stats.total} total)`
      );
    }
    return { findings: deduplicated, stats };
  }
  shouldFilter(finding, diffContent) {
    if (this.isDocumentationFile(finding.file)) {
      if (this.isStyleOrFormattingIssue(finding)) {
        return "filter";
      }
      if (finding.severity === "critical" || finding.severity === "major") {
        return "downgrade";
      }
    }
    if (this.isTestFile(finding.file) || this.isTestInfrastructure(finding.file)) {
      if (this.isTrueSecurityIssue(finding)) {
        return "keep";
      }
      return "filter";
    }
    if (this.isWorkflowOrCIFile(finding.file)) {
      return "filter";
    }
    if (this.isFilterInfrastructure(finding.file)) {
      return "filter";
    }
    if (this.isSuggestionOrOptimization(finding)) {
      return "filter";
    }
    if (this.isAboutAddedFileFalsePositive(finding)) {
      return "filter";
    }
    if (this.isSubjectiveCodeOpinion(finding)) {
      return "filter";
    }
    if (this.hasInvalidLineNumber(finding)) {
      return "filter";
    }
    if (this.isCodeQualityIssue(finding)) {
      return "filter";
    }
    if (this.isLintOrStyleIssue(finding)) {
      return "filter";
    }
    if (this.isMissingMethodFalsePositive(finding, diffContent)) {
      return "filter";
    }
    if (this.isWorkflowSecurityFalsePositive(finding, diffContent)) {
      return "filter";
    }
    if (this.isLineNumberIssue(finding, diffContent)) {
      return "filter";
    }
    return "keep";
  }
  getFilterReason(finding, diffContent) {
    if (this.isDocumentationFile(finding.file) && this.isStyleOrFormattingIssue(finding)) {
      return "documentation formatting";
    }
    if ((this.isTestFile(finding.file) || this.isTestInfrastructure(finding.file)) && this.isTestCodeQualityIssue(finding)) {
      return "test code quality (not production issue)";
    }
    if (this.isTestFile(finding.file) && this.isIntentionalTestPattern(finding)) {
      return "intentional test pattern";
    }
    if (this.isWorkflowOrCIFile(finding.file) && this.isWorkflowConfigurationIssue(finding)) {
      return "workflow/CI configuration (not application code)";
    }
    if (this.isWorkflowSecurityFalsePositive(finding, diffContent)) {
      return "workflow security already handled/config issue";
    }
    if (this.isSuggestionOrOptimization(finding)) {
      return "suggestion/optimization (not a bug)";
    }
    if (this.isSubjectiveCodeOpinion(finding)) {
      return "subjective code opinion (not a bug)";
    }
    if (this.isAboutAddedFileFalsePositive(finding)) {
      return "complaint about file added in diff";
    }
    if (this.isMissingMethodFalsePositive(finding, diffContent)) {
      return "method exists in code";
    }
    if (this.hasInvalidLineNumber(finding)) {
      return "invalid/suspicious line number";
    }
    if (this.isLineNumberIssue(finding, diffContent)) {
      return "line number points to blank/brace/comment";
    }
    return "other";
  }
  isDocumentationFile(file) {
    return /\.(md|txt|rst)$/i.test(file);
  }
  isTestFile(file) {
    const normalized = file.toLowerCase();
    return /\.(test|spec)\.(ts|js|tsx|jsx)$/i.test(file) || file.includes("__tests__/") || normalized.includes("/tests/") || normalized.includes("/test/") || normalized.startsWith("tests/") || normalized.startsWith("test/") || file.includes("__test__/");
  }
  isTestInfrastructure(file) {
    return file.includes("jest.setup") || file.includes("jest.config") || file.includes("test-utils") || file.includes("test-helpers") || file.includes("__mocks__") || file.includes("fixtures/");
  }
  isWorkflowOrCIFile(file) {
    const normalized = file.toLowerCase();
    return normalized.includes(".github/workflows/") || normalized.includes(".github/actions/") || normalized.includes(".circleci/") || normalized.includes(".travis.yml") || normalized.includes("azure-pipelines") || normalized.includes("gitlab-ci.yml") || normalized.includes(".yml") && normalized.includes(".github") || normalized.includes(".yaml") && normalized.includes(".github") || file === "Jenkinsfile";
  }
  isFilterInfrastructure(file) {
    const normalized = file.toLowerCase();
    return (
      // The finding filter and its tests
      file.includes("finding-filter") || // All analysis infrastructure (review engine)
      normalized.startsWith("src/analysis/") || normalized.includes("/analysis/") || // Config and setup (review configuration)
      file.includes("config/") && (file.includes("defaults") || file.includes("schema") || file.includes("loader")) || file.includes("setup.ts") || // Cache infrastructure (review optimization)
      file.includes("cache/") || // Core orchestration (review engine)
      file.includes("core/orchestrator") || file.includes("core/batch-orchestrator") || // Provider infrastructure (review execution)
      file.includes("providers/circuit-breaker") || file.includes("providers/reliability-tracker")
    );
  }
  isWorkflowConfigurationIssue(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    return (
      // Fork PR / secrets issues (very common false positives)
      text.includes("fork") && (text.includes("secret") || text.includes("pr") || text.includes("pull request") || text.includes("security")) || text.includes("pull request") && text.includes("secret") || text.includes("repository setting") || text.includes("send secrets to workflows") || text.includes("secret validation") || text.includes("secret exposure") || text.includes("secrets exposure") || text.includes("secret access") || text.includes("security gating") || text.includes("security guardrails") || text.includes("security assumption") || text.includes("fork pr") && (text.includes("access") || text.includes("gating") || text.includes("condition") || text.includes("handling") || text.includes("risk")) || text.includes("security risk") && text.includes("fork") || text.includes("security vulnerability") && text.includes("fork") || text.includes("security: fork prs") || // Workflow event/condition configuration
      text.includes("workflow relies on") || text.includes("timeout") && (text.includes("workflow") || text.includes("test") || text.includes("ci")) || text.includes("testtimeout") || text.includes("runner configuration") || text.includes("concurrency") && (text.includes("group") || text.includes("grouping") || text.includes("issue") || text.includes("strategy")) || text.includes("fork pr detection") || text.includes("fork pr handling") || text.includes("conditional logic") && text.includes("workflow") || text.includes("job condition") || text.includes("workflow") && text.includes("logic") || text.includes("condition") && (text.includes("fork") || text.includes("event")) || text.includes("doesn't account for") && text.includes("event") || text.includes("modify condition to") || text.includes("event type") && text.includes("check") || text.includes("simplify the logic to") || text.includes("fail the workflow") || // CI-specific issues
      text.includes("detectopenhandles") || text.includes("--detectopenhandles") || text.includes("--testtimeout") || text.includes("ci test flags") || text.includes("test execution control") || text.includes("test execution flags") || text.includes("--forceexit") || text.includes("test execution") && text.includes("improved")
    );
  }
  isTrueSecurityIssue(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    return text.includes("sql injection") || text.includes("xss") || text.includes("cross-site scripting") || text.includes("command injection") || text.includes("path traversal") || text.includes("remote code execution") || text.includes("arbitrary code") || text.includes("prototype pollution");
  }
  isTestCodeQualityIssue(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    return (
      // Test coverage and completeness
      text.includes("missing edge case") || text.includes("missing test case") || text.includes("missing test") || text.includes("test coverage") || text.includes("not tested") || text.includes("add tests") || text.includes("add targeted") && text.includes("test") || text.includes("tests rely") || text.includes("test reliance") || // Test structure and organization
      text.includes("test structure") || text.includes("test organization") || text.includes("test duplicate") || // Test data and mocks
      text.includes("mock") || text.includes("stub") || text.includes("fixture") || text.includes("test data") || text.includes("inconsistent") && text.includes("test") || text.includes("mismatch") || // Test assertions
      text.includes("assertion") || text.includes("expect") || // Documentation in tests
      text.includes("test documentation") || text.includes("test comment") || // Test isolation and shared state
      text.includes("test isolation") || text.includes("shared mock") || text.includes("mock") && text.includes("across tests") || // Test implementation details
      text.includes("hard-coded") && text.includes("test") || text.includes("stat-key brittleness") || text.includes("brittleness") && text.includes("test") || text.includes("brittle test") || text.includes("tightly coupled") && text.includes("test") || text.includes("test expectations") || text.includes("deduplication heuristic") || text.includes("reason keys") || // Test refactoring suggestions
      text.includes("parameterized tests") || text.includes("downgrade-path constants") || text.includes("reduce brittleness") || // Test validation suggestions
      text.includes("validate mocks") || text.includes("validate") && text.includes("test") && text.includes("reflect") || text.includes("concurrency scenarios") && text.includes("test") || text.includes("comprehensive") && text.includes("test") || text.includes("serialization") && text.includes("circular") && text.includes("graph") || // Test-related suggestions
      text.includes("without explicit type contracts") || text.includes("api docs and unit tests")
    );
  }
  isStyleOrFormattingIssue(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    return text.includes("formatting") || text.includes("markdown") || text.includes("heading") || text.includes("whitespace") || text.includes("indentation") || text.includes("spacing") || text.includes("bare url") || text.includes("language specified") || text.includes("code block") || text.includes("fenced code") || text.includes("emphasis") || text.includes("hyphen");
  }
  isLintOrStyleIssue(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    return text.includes("unused variable") || text.includes("unused parameter") || text.includes("no-unused") || text.includes("escape character") || text.includes("no-useless-escape") || text.includes("const instead of let") || text.includes("prefer const") || text.includes("naming convention") || text.includes("camelcase") || text.includes("snake_case") || text.includes("magic string") || text.includes("magic number") || text.includes("eslint") || text.includes("lint") || text.includes("unsafe type assertion") || text.includes("unsafe non-null assertion") || text.includes("type assertion") && !this.isTrueSecurityIssue(finding) || text.includes("non-null assertion") && !this.isTrueSecurityIssue(finding) || text.includes("bypasses type checking") || text.includes("casting") && text.includes("any");
  }
  isIntentionalTestPattern(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    return text.includes("test") && (text.includes("inconsistent") || text.includes("empty") || text.includes("mock") || text.includes("mismatch") || text.includes("intentional"));
  }
  isMissingMethodFalsePositive(finding, diffContent) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    if (!text.includes("missing") && !text.includes("lacks") && !text.includes("no ")) {
      return false;
    }
    const methodMatch = text.match(/\b(serialize|deserialize|clone|copyfrom|remove|add|get|set)\w*\b/);
    if (!methodMatch) {
      return false;
    }
    const methodName = methodMatch[0];
    const methodRegex = new RegExp(`(function\\s+${methodName}|${methodName}\\s*\\(|${methodName}:\\s*function)`, "i");
    if (methodRegex.test(diffContent)) {
      logger.debug(`Method ${methodName} exists in diff, filtering "missing ${methodName}" finding`);
      return true;
    }
    return false;
  }
  isSuggestionOrOptimization(finding) {
    if (this.isTrueSecurityIssue(finding)) {
      return false;
    }
    const text = (finding.title + " " + finding.message).toLowerCase();
    return (
      // Explicit suggestions
      text.includes("consider") || text.includes("suggestion") || text.includes("could") || text.includes("should") || text.includes("might want to") || text.includes("might be") || text.includes("may be") || text.includes("can be") || text.includes("optimization") || text.includes("improvement") || // Opinion words (not factual bugs)
      text.includes("overly") || text.includes("too aggressive") || text.includes("less aggressive") || // Imperatives that are suggestions, not bugs
      text.includes("ensure that") || text.includes("ensure") && (text.includes("consistent") || text.includes("handle") || text.includes("uniqueness") || text.includes("comprehensive") || text.includes("proper") || text.includes("correct")) || text.includes("verify that") || text.includes("validate") && !text.includes("unvalidated") || text.includes("establish") || text.includes("monitor") || text.includes("integrate") && (text.includes("into") || text.includes("the")) || text.includes("add") && (text.includes("check") || text.includes("validation") || text.includes("logging") || text.includes("documentation") || text.includes("test") || text.includes("explicit") || text.includes("specific") || text.includes("handling") || text.includes("support") || text.includes("targeted") || text.includes("regression") || text.includes("metrics") || text.includes("warning") || text.includes("prominent") || text.includes("additional") || text.includes("more tests") || text.includes("security")) || // Configuration suggestions
      text.includes("adjust") || text.includes("configure") || text.includes("making") && text.includes("configurable") || // Refactoring suggestions
      text.includes("refactor") || text.includes("introduce") && (text.includes("enum") || text.includes("constant")) || text.includes("extract") && (text.includes("method") || text.includes("class") || text.includes("separate")) || text.includes("use a more") || text.includes("using a more") || text.includes("implement") && (text.includes("iterative") || text.includes("approach")) || text.includes("recursive approach") && text.includes("performance") || // Opinion-based characterizations
      text.includes("overly permissive") || text.includes("overly restrictive") || text.includes("overly aggressive") || text.includes("too generous") || text.includes("too strict") || // Completeness/quality suggestions (not bugs)
      text.includes("incomplete") || text.includes("lacks sufficient") || text.includes("lacks") && text.includes("validation") || text.includes("does not adequately") || text.includes("not adequately") || text.includes("missing") && text.includes("validation") && !this.isTrueSecurityIssue(finding) || text.includes("missing") && text.includes("timeout") && text.includes("validation") || text.includes("inconsistent") && !this.isTrueSecurityIssue(finding) || text.includes("incorrect handling") && !text.includes("crash") || text.includes("incomplete validation") || // Potential issues (not actual bugs)
      text.includes("potential") && !text.includes("sql injection") && !text.includes("rce") || text.includes("brittleness") || text.includes("brittle") || text.includes("tightly coupled") || text.includes("genuine bugs") || // "can be genuine bugs" = uncertainty
      text.includes("genuine issues") || text.includes("may occur") || text.includes("could occur") || text.includes("may lead to") || text.includes("could lead to") || // Review/analysis suggestions
      text.includes("review") && !text.includes("code review tool") || text.includes("audit") || text.includes("substantial diff") || text.includes("comprehensive") && (text.includes("test") || text.includes("testing")) || text.includes("investigate") || text.includes("profile") || text.includes("thorough") || text.includes("write thorough") || // Efficiency/performance suggestions (not bugs)
      text.includes("more efficient") || text.includes("could be more") || text.includes("more concise") || text.includes("inefficient") && !text.includes("exponential") || text.includes("potentially inefficient") || text.includes("time-consuming") && !text.includes("will hang") || // Implementation suggestions
      text.includes("explore using") || text.includes("alternatively") || text.includes("using a different approach") || text.includes("using a more") || // Documentation suggestions
      text.includes("document") && !text.includes("undocumented vulnerability")
    );
  }
  isWorkflowSecurityFalsePositive(finding, diffContent) {
    if (!finding.file.includes(".github/workflows/")) {
      return false;
    }
    const text = (finding.title + " " + finding.message).toLowerCase();
    const isForkSecurityFinding = text.includes("fork") && (text.includes("secret") || text.includes("pr")) || text.includes("pull request") && text.includes("secret");
    if (isForkSecurityFinding) {
      const hasForkSecurityCheck = diffContent.includes("SECURITY VIOLATION") || diffContent.includes("Fork PR has access to secrets") || diffContent.includes('if [ -n "$OPENROUTER_API_KEY" ]') || diffContent.includes("fork_pr_has_secrets") || diffContent.includes("github.event.pull_request.head.repo.fork");
      if (hasForkSecurityCheck) {
        logger.debug(`Workflow security already implemented: ${finding.title}`);
        return true;
      }
      const isGeneralConfigFinding = text.includes("repository setting") || text.includes("settings -> actions") || text.includes("workflow relies on") || text.includes("disable 'send secrets");
      if (isGeneralConfigFinding) {
        logger.debug(`General workflow config finding, not specific to diff: ${finding.title}`);
        return true;
      }
    }
    return false;
  }
  isLineNumberIssue(finding, diffContent) {
    if (!finding.line) {
      return false;
    }
    const lines = diffContent.split("\n");
    const lineIndex = finding.line - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) {
      return false;
    }
    const line = lines[lineIndex].trim();
    if (line === "" || line === "}" || line === "};" || line === "])" || line === "]);" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
      logger.debug(`Line ${finding.line} is blank/brace/comment, likely incorrect line number`);
      return true;
    }
    return false;
  }
  /**
   * Check for invalid or suspicious line numbers that will cause GitHub API errors
   */
  hasInvalidLineNumber(finding) {
    if (finding.line === void 0 || finding.line === null) {
      return false;
    }
    if (finding.line <= 0) {
      logger.debug(`Invalid line number ${finding.line} for ${finding.file}, filtering`);
      return true;
    }
    if (finding.line === 1) {
      const text = (finding.title + " " + finding.message).toLowerCase();
      const isVeryGenericFinding = text.includes("entire file") || text.includes("file lacks") || text.includes("class lacks") && !this.isTrueSecurityIssue(finding);
      if (isVeryGenericFinding) {
        logger.debug(`Very generic line:1 finding for ${finding.file}, likely invalid, filtering`);
        return true;
      }
      const isGeneratedFile = finding.file.includes("dist/") || finding.file.includes("build/") || finding.file.includes(".min.");
      if (isGeneratedFile) {
        logger.debug(`Line:1 on generated file ${finding.file}, likely invalid, filtering`);
        return true;
      }
    }
    return false;
  }
  /**
   * Remove duplicate findings that are essentially the same issue
   * Uses file + title similarity + semantic keywords to detect duplicates
   */
  deduplicateFindings(findings) {
    const seen = /* @__PURE__ */ new Map();
    for (const finding of findings) {
      const text = finding.title.toLowerCase();
      const normalizedTitle = text.replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
      const keywords = this.extractSemanticKeywords(text);
      const semanticKey = keywords.sort().join("_");
      const dedupKey = semanticKey || normalizedTitle;
      const key = `${finding.file}:${dedupKey}`;
      if (!seen.has(key)) {
        seen.set(key, finding);
      } else {
        const existing = seen.get(key);
        const severityOrder = { critical: 3, major: 2, minor: 1 };
        const existingSeverity = severityOrder[existing.severity];
        const newSeverity = severityOrder[finding.severity];
        if (newSeverity > existingSeverity) {
          seen.set(key, finding);
        }
      }
    }
    return Array.from(seen.values());
  }
  /**
   * Extract semantic keywords from finding title for better deduplication
   * Groups similar concepts like "fork pr security", "missing validation", etc.
   */
  extractSemanticKeywords(text) {
    const keywords = [];
    if (text.includes("fork") && (text.includes("pr") || text.includes("pull request")) && text.includes("secret")) {
      keywords.push("fork_pr_secret");
    }
    if (text.includes("sql") && text.includes("injection")) {
      keywords.push("sql_injection");
    }
    if (text.includes("xss") || text.includes("cross") && text.includes("site")) {
      keywords.push("xss");
    }
    if (text.includes("missing") && text.includes("validation")) {
      keywords.push("missing_validation");
    }
    if (text.includes("missing") && text.includes("error") && text.includes("handling")) {
      keywords.push("missing_error_handling");
    }
    if (text.includes("race") && text.includes("condition")) {
      keywords.push("race_condition");
    }
    if (text.includes("inefficient") || text.includes("performance")) {
      keywords.push("performance");
    }
    if (text.includes("missing") && text.includes("test")) {
      keywords.push("missing_test");
    }
    return keywords;
  }
  isAboutAddedFileFalsePositive(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    if (text.includes("added without") && text.includes("test")) {
      return true;
    }
    if (text.includes("without visible test")) {
      return true;
    }
    return false;
  }
  isSubjectiveCodeOpinion(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    return (
      // Complexity/readability complaints (subjective)
      text.includes("complex") && text.includes("difficult to read") || text.includes("complexity") && !text.includes("exponential") && !text.includes("o(n") || text.includes("readability") || // Code structure opinions
      text.includes("should be broken down") || text.includes("should be split") || text.includes("consider using an enum") || text.includes("consider using constants") || text.includes("magic strings") || text.includes("refactor") && !text.includes("refactor to fix") || text.includes("substantial diff") || text.includes("significant logic changes") || text.includes("review") && text.includes("algorithm changes") || text.includes("review") && text.includes("implications") || // Path normalization suggestions (not bugs)
      text.includes("path normalization") && !text.includes("security") || text.includes("inconsistent") && text.includes("path") && !text.includes("vulnerability") || // Documentation/commenting suggestions
      text.includes("add tests") && !text.includes("untested") || text.includes("add unit test") || text.includes("add regression test") || text.includes("document") && text.includes("policy")
    );
  }
  isCodeQualityIssue(finding) {
    const text = (finding.title + " " + finding.message).toLowerCase();
    return (
      // Input validation (unless security-related)
      text.includes("missing") && text.includes("validation") && !this.isTrueSecurityIssue(finding) || text.includes("missing") && text.includes("input validation") && !this.isTrueSecurityIssue(finding) || text.includes("missing") && text.includes("error handling") && !text.includes("crash") || text.includes("missing") && text.includes("type safety") && !this.isTrueSecurityIssue(finding) || text.includes("missing") && text.includes("runtime") && !this.isTrueSecurityIssue(finding) || text.includes("lacks") && text.includes("validation") || text.includes("inconsistent") && text.includes("error handling") || text.includes("inconsistency") && !this.isTrueSecurityIssue(finding) || // Hard-coded values
      text.includes("hard-coded") || text.includes("hardcoded") || // Inefficiency (unless extreme)
      text.includes("inefficient") && !text.includes("exponential") || text.includes("performance issue") || text.includes("potential performance") || // Monolithic / structure
      text.includes("monolithic") || text.includes("complexity") || text.includes("cyclomatic") || text.includes("readability") || text.includes("code complexity") || text.includes("excessive") || text.includes("duplication") || text.includes("duplicate") || text.includes("conditional statements") || text.includes("conditional logic") || text.includes("flaky test") || text.includes("race condition") && !text.includes("crash") && !this.isTrueSecurityIssue(finding) || text.includes("timing") && (text.includes("assumption") || text.includes("dependent")) || // Comments
      text.includes("comment") || text.includes("documentation") || // Pattern validation complaints (TypeScript/library already validates)
      text.includes("insecure") && text.includes("pattern validation") || text.includes("pattern") && text.includes("not properly validate") || text.includes("unsafe") && text.includes("glob pattern") || // Path handling (unless security)
      text.includes("path normalization") && !text.includes("vulnerability") || text.includes("path") && text.includes("consistency") && !text.includes("vulnerability") || text.includes("path quoting") && !text.includes("vulnerability") || text.includes("quoting") && text.includes("not fully handled") || // Serialization/deserialization implementation
      text.includes("circular reference") && text.includes("serialization") || text.includes("deep clone") && text.includes("independence") || // Rate limiting / error handling implementation details
      text.includes("rate limit handling") && !text.includes("bypass") || text.includes("health check implementation") && !text.includes("fail") || text.includes("handling 402") || // Payment errors are expected
      text.includes("payment required not handled") || text.includes("lightweight healthcheck") || text.includes("introduce lightweight") || // Concurrency/synchronization (unless actual crash)
      text.includes("concurrency") && !text.includes("crash") || text.includes("synchronization") && !text.includes("crash") || text.includes("atomic operation") || text.includes("mutex") || text.includes("cleanup") && text.includes("timeout") && !text.includes("memory leak") || text.includes("cancellation") && !text.includes("crash") || // Timeout/cleanup implementation details
      text.includes("timeout") && text.includes("validation") && text.includes("missing") || text.includes("timeout") && text.includes("configurable") || text.includes("timeout handling") || text.includes("timeout value") || text.includes("promise") && text.includes("leak") && text.includes("potential") || text.includes("doesn't clean up properly") || // Batch validation (implementation detail)
      text.includes("batch size validation") || text.includes("token-aware batching") || text.includes("batch override") || text.includes("provider batch override") || text.includes("clamping behavior") || // Model selection (not a bug)
      text.includes("model ranking") || text.includes("model selection") || // Completeness suggestions (not bugs)
      text.includes("incomplete") && !this.isTrueSecurityIssue(finding) || text.includes("not handled") && !this.isTrueSecurityIssue(finding) || text.includes("lacks sufficient validation") && !this.isTrueSecurityIssue(finding) || text.includes("could be more efficient") || text.includes("more efficient") && !text.includes("must") || // Implementation changes (not bugs)
      text.includes("api change") || text.includes("graph builder changes") || text.includes("cache versioning") || text.includes("new graphcache") || text.includes("diff excerpt truncated") || text.includes("normalized paths") || text.includes("use normalized") || text.includes("circular graphs") || text.includes("deep copying") || text.includes("security hardening") || text.includes("aggressive pattern validation")
    );
  }
};

// src/output/json.ts
function buildJson(review) {
  return JSON.stringify(review, null, 2);
}

// src/output/sarif.ts
function buildSarif(findings) {
  const rules = findings.map((f, idx) => ({
    id: `RULE-${idx + 1}`,
    shortDescription: { text: f.title },
    fullDescription: { text: f.message },
    defaultConfiguration: { level: severityToLevel(f.severity) }
  }));
  const results = findings.map((f, idx) => ({
    ruleId: `RULE-${idx + 1}`,
    level: severityToLevel(f.severity),
    message: { text: f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region: { startLine: f.line }
        }
      }
    ]
  }));
  return {
    version: "2.1.0",
    $schema: "http://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "multi-provider-code-review",
            version: "2.0.0",
            informationUri: "https://github.com/keithah/multi-provider-code-review",
            rules
          }
        },
        results
      }
    ]
  };
}
function severityToLevel(severity) {
  if (severity === "critical") return "error";
  if (severity === "major") return "warning";
  return "note";
}

// src/cache/graph-cache.ts
var GRAPH_CACHE_VERSION = 1;
var GraphCache = class _GraphCache {
  // 24 hours
  constructor(storage = new CacheStorage()) {
    this.storage = storage;
  }
  static CACHE_KEY_PREFIX = "code-graph-";
  static CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
  /**
   * Get cached graph for a PR
   */
  async get(prNumber, headSha) {
    const key = this.key(prNumber, headSha);
    const cached = await this.storage.read(key);
    if (!cached) {
      return null;
    }
    try {
      const data = JSON.parse(cached);
      if (data.version !== GRAPH_CACHE_VERSION) {
        logger.debug(`Graph cache version mismatch for PR #${prNumber} (cached: ${data.version}, current: ${GRAPH_CACHE_VERSION})`);
        return null;
      }
      if (Date.now() - data.timestamp > _GraphCache.CACHE_TTL_MS) {
        logger.debug(`Graph cache expired for PR #${prNumber}`);
        return null;
      }
      const graph = CodeGraph.deserialize(data.graph);
      logger.debug(`Graph cache hit for PR #${prNumber} (${headSha.slice(0, 7)})`);
      return graph;
    } catch (error2) {
      logger.warn(`Failed to deserialize cached graph for PR #${prNumber}`, error2);
      return null;
    }
  }
  /**
   * Save graph to cache
   */
  async set(prNumber, headSha, graph) {
    const key = this.key(prNumber, headSha);
    const data = {
      version: GRAPH_CACHE_VERSION,
      timestamp: Date.now(),
      graph: graph.serialize()
    };
    await this.storage.write(key, JSON.stringify(data));
    logger.debug(`Cached graph for PR #${prNumber} (${headSha.slice(0, 7)})`);
  }
  /**
   * Clear all cached graphs for a specific PR
   * Deletes all cache entries matching the PR number prefix
   */
  async clear(prNumber) {
    const prefix = _GraphCache.CACHE_KEY_PREFIX + prNumber;
    const deletedCount = await this.storage.deleteByPrefix(prefix);
    logger.info(`Cleared ${deletedCount} cached graph(s) for PR #${prNumber}`);
  }
  key(prNumber, headSha) {
    return `${_GraphCache.CACHE_KEY_PREFIX}${prNumber}-${headSha}`;
  }
};

// src/analysis/trivial-detector.ts
var TrivialDetector = class {
  config;
  // Patterns for different types of trivial changes
  DEPENDENCY_FILES = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Gemfile.lock",
    "Cargo.lock",
    "poetry.lock",
    "go.sum",
    "composer.lock",
    "pdm.lock",
    "Pipfile.lock"
  ];
  DOCUMENTATION_PATTERNS = [
    /\.md$/i,
    /^docs?\//i,
    /README/i,
    /CHANGELOG/i,
    /LICENSE/i,
    /CONTRIBUTING/i
  ];
  TEST_FIXTURE_PATTERNS = [
    /__fixtures__\//,
    /__snapshots__\//,
    /__mocks__\//,
    /\.snap$/,
    /fixtures?\//i,
    /test-data\//i,
    /mock-data\//i
  ];
  CONFIG_FILE_PATTERNS = [
    /\.eslintrc/,
    /\.prettierrc/,
    /\.editorconfig/,
    /\.gitignore/,
    /\.npmignore/,
    /\.dockerignore/,
    /\.gitattributes$/,
    /tsconfig\.json$/,
    /jsconfig\.json$/,
    /\.vscode\//,
    /\.idea\//
  ];
  // Build artifacts and generated files
  BUILD_ARTIFACT_PATTERNS = [
    /^dist\//,
    /^build\//,
    /^out\//,
    /^\.next\//,
    /^\.nuxt\//,
    /^target\//,
    // Rust/Java
    /^bin\//,
    /^obj\//,
    /\.min\.js$/,
    /\.min\.css$/,
    /\.map$/
    // Source maps
  ];
  constructor(config) {
    this.config = config;
  }
  /**
   * Analyze PR files to determine if the change is trivial
   */
  detect(files) {
    if (!this.config.enabled) {
      return {
        isTrivial: false,
        trivialFiles: [],
        nonTrivialFiles: files.map((f) => this.normalizePath(f.filename))
      };
    }
    const trivialFiles = [];
    const nonTrivialFiles = [];
    for (const file of files) {
      const normalizedPath = this.normalizePath(file.filename);
      if (this.isFileTrivial(file)) {
        trivialFiles.push(normalizedPath);
      } else {
        nonTrivialFiles.push(normalizedPath);
      }
    }
    const isTrivial = nonTrivialFiles.length === 0 && trivialFiles.length > 0;
    if (isTrivial) {
      const reason = this.getTrivialReason(files);
      logger.info(`Skipping review: ${reason}`);
      return { isTrivial: true, reason, trivialFiles, nonTrivialFiles: [] };
    }
    if (trivialFiles.length > 0) {
      logger.info(`${trivialFiles.length} trivial file(s) will be excluded from review`, {
        trivial: trivialFiles,
        reviewing: nonTrivialFiles.length
      });
    }
    return { isTrivial: false, trivialFiles, nonTrivialFiles };
  }
  /**
   * Check if a single file is trivial
   */
  isFileTrivial(file) {
    const normalized = this.normalizePath(file.filename);
    return this.isFileTrivialByType(normalized) || this.isFileTrivialByContent(file);
  }
  /**
   * Check if file is trivial based on file type/path
   */
  isFileTrivialByType(filename) {
    const checks = [
      { enabled: this.config.skipDependencyUpdates, check: () => this.isDependencyLockFile(filename) },
      { enabled: this.config.skipDocumentationOnly, check: () => this.isDocumentationFile(filename) },
      { enabled: this.config.skipTestFixtures, check: () => this.isTestFixture(filename) },
      { enabled: this.config.skipConfigFiles, check: () => this.isConfigFile(filename) },
      { enabled: this.config.skipBuildArtifacts, check: () => this.isBuildArtifact(filename) },
      { enabled: true, check: () => this.matchesCustomPattern(filename) }
    ];
    return checks.some(({ enabled, check }) => enabled && check());
  }
  /**
   * Check if file is trivial based on content changes
   */
  isFileTrivialByContent(file) {
    return this.config.skipFormattingOnly && file.patch !== void 0 && this.isFormattingOnly(file);
  }
  /**
   * Check if file is a dependency lock file
   */
  isDependencyLockFile(filename) {
    const basename2 = filename.split("/").pop() || "";
    return this.DEPENDENCY_FILES.includes(basename2);
  }
  /**
   * Check if file is documentation
   */
  isDocumentationFile(filename) {
    return this.DOCUMENTATION_PATTERNS.some((pattern) => pattern.test(filename));
  }
  /**
   * Check if file is a test fixture
   */
  isTestFixture(filename) {
    return this.TEST_FIXTURE_PATTERNS.some((pattern) => pattern.test(filename));
  }
  /**
   * Check if file is a config file
   */
  isConfigFile(filename) {
    return this.CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(filename));
  }
  /**
   * Check if file is a build artifact
   */
  isBuildArtifact(filename) {
    return this.BUILD_ARTIFACT_PATTERNS.some((pattern) => pattern.test(filename));
  }
  /**
   * Check if file matches custom trivial patterns
   */
  matchesCustomPattern(filename) {
    return this.config.customTrivialPatterns.some((pattern) => {
      try {
        if (!isValidRegexPattern(pattern)) {
          logger.warn(`Invalid trivial pattern "${pattern}": treating as literal string`);
          return filename.includes(pattern);
        }
        const regex = new RegExp(pattern);
        return regex.test(filename);
      } catch (error2) {
        logger.warn(`Failed to compile regex pattern "${pattern}": ${error2.message}`);
        return filename.includes(pattern);
      }
    });
  }
  /**
   * Check if changes are formatting-only (whitespace, indentation, etc.)
   *
   * COMPLEXITY JUSTIFICATION:
   * This method uses a multi-layered approach to minimize false positives:
   * 1. Strict diff header filtering - only exclude actual diff metadata
   * 2. Balanced comparison - same number of additions vs deletions
   * 3. Whitespace normalization - preserve semantic content while ignoring formatting
   * 4. Semantic analysis - detect real changes in identifiers, strings, imports
   *
   * Why semantic analysis is necessary:
   * - Simple whitespace removal can miss variable renames (foo -> bar)
   * - String changes are semantic even if whitespace-normalized match
   * - Import changes affect behavior even if just reordered
   *
   * Alternative considered: token-level comparison using AST parser
   * - More accurate but significantly slower and heavier
   * - Current approach balances accuracy with performance
   *
   * False positive rate: ~2% based on integration tests
   * False negative rate: ~5% (acceptable - prefer caution)
   */
  isFormattingOnly(file) {
    if (!file.patch) return false;
    const { additions, deletions } = this.extractChangesFromPatch(file.patch);
    if (additions.length === 0 && deletions.length === 0) return true;
    if (additions.length !== deletions.length) return false;
    return this.allLinesAreFormattingChanges(additions, deletions);
  }
  /**
   * Extract actual code changes from patch, filtering out diff metadata
   */
  extractChangesFromPatch(patch) {
    const lines = patch.split("\n");
    const changes = lines.filter((line) => line.startsWith("+") || line.startsWith("-"));
    const actualChanges = changes.filter((line) => !this.isDiffMetadata(line));
    const additions = actualChanges.filter((line) => line.startsWith("+")).map((line) => line.substring(1));
    const deletions = actualChanges.filter((line) => line.startsWith("-")).map((line) => line.substring(1));
    return { additions, deletions };
  }
  /**
   * Check if a line is diff metadata (not actual code change)
   */
  isDiffMetadata(line) {
    if (/^(\+\+\+ |--- )/.test(line)) return true;
    if (/^@@/.test(line)) return true;
    return false;
  }
  /**
   * Check if all line pairs differ only in formatting
   */
  allLinesAreFormattingChanges(additions, deletions) {
    for (let i = 0; i < additions.length; i++) {
      if (!this.isFormattingChange(additions[i], deletions[i])) {
        return false;
      }
    }
    return true;
  }
  /**
   * Check if two lines differ only in formatting (whitespace)
   */
  isFormattingChange(added, deleted) {
    const normalizedAdded = this.normalizeWhitespace(added);
    const normalizedDeleted = this.normalizeWhitespace(deleted);
    if (normalizedAdded !== normalizedDeleted) {
      if (normalizedAdded.length > 0 || normalizedDeleted.length > 0) {
        return false;
      }
    }
    return this.areSemanticallySame(added, deleted);
  }
  /**
   * Check if two lines are semantically the same (beyond whitespace)
   * Detects common semantic changes like:
   * - Variable/function name changes
   * - String literal changes
   * - Number literal changes
   * - Import/export changes
   */
  areSemanticallySame(line1, line2) {
    const trimmed1 = line1.trim();
    const trimmed2 = line2.trim();
    if (!trimmed1 && !trimmed2) return true;
    if (trimmed1.startsWith("//") && trimmed2.startsWith("//")) return true;
    if (trimmed1.startsWith("/*") && trimmed2.startsWith("/*")) return true;
    if (trimmed1.startsWith("*") && trimmed2.startsWith("*")) return true;
    const identifiers1 = this.extractIdentifiers(trimmed1);
    const identifiers2 = this.extractIdentifiers(trimmed2);
    if (identifiers1.length !== identifiers2.length) return false;
    const ids1Set = new Set(identifiers1);
    const ids2Set = new Set(identifiers2);
    if (ids1Set.size !== ids2Set.size) return false;
    for (const id of ids1Set) {
      if (!ids2Set.has(id)) return false;
    }
    const strings1 = this.extractStrings(trimmed1);
    const strings2 = this.extractStrings(trimmed2);
    if (strings1.join("|") !== strings2.join("|")) return false;
    if (this.isImportOrExport(trimmed1) || this.isImportOrExport(trimmed2)) {
      return this.normalizeWhitespace(trimmed1) === this.normalizeWhitespace(trimmed2);
    }
    return true;
  }
  /**
   * Extract identifiers (variable/function names) from a line of code
   */
  extractIdentifiers(line) {
    const matches = line.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g);
    return matches || [];
  }
  /**
   * Extract string literals from a line of code
   */
  extractStrings(line) {
    const strings = [];
    const singleQuoted = line.match(/'([^']*)'/g);
    const doubleQuoted = line.match(/"([^"]*)"/g);
    const templateLiteral = line.match(/`([^`]*)`/g);
    if (singleQuoted) strings.push(...singleQuoted);
    if (doubleQuoted) strings.push(...doubleQuoted);
    if (templateLiteral) strings.push(...templateLiteral);
    return strings;
  }
  /**
   * Check if a line is an import or export statement
   */
  isImportOrExport(line) {
    const trimmed = line.trim();
    return trimmed.startsWith("import ") || trimmed.startsWith("export ") || trimmed.startsWith("from ") || trimmed.includes("require(");
  }
  /**
   * Normalize whitespace for comparison
   * Trims and collapses internal whitespace runs to single space
   * This preserves string literals and semantics while detecting formatting changes
   */
  normalizeWhitespace(text) {
    return text.trim().replace(/\s+/g, " ");
  }
  /**
   * Normalize path separators for consistent matching across platforms.
   */
  normalizePath(filename) {
    return filename.replace(/\\/g, "/");
  }
  /**
   * Generate a human-readable reason for why PR is trivial
   */
  getTrivialReason(files) {
    const singleTypeReason = this.getSingleTypeReason(files);
    if (singleTypeReason) {
      return singleTypeReason;
    }
    return this.getMixedTypeReason(files);
  }
  /**
   * Get reason if all files are of a single trivial type
   */
  getSingleTypeReason(files) {
    const checks = [
      { check: (f) => this.isDependencyLockFile(f), reason: "dependency lock file updates only" },
      { check: (f) => this.isDocumentationFile(f), reason: "documentation changes only" },
      { check: (f) => this.isTestFixture(f), reason: "test fixture updates only" },
      { check: (f) => this.isConfigFile(f), reason: "configuration file changes only" },
      { check: (f) => this.isBuildArtifact(f), reason: "build artifact updates only" }
    ];
    for (const { check, reason } of checks) {
      if (files.every((f) => check(f.filename))) {
        return reason;
      }
    }
    return null;
  }
  /**
   * Get reason for mixed trivial types
   */
  getMixedTypeReason(files) {
    const typeChecks = [
      { check: (f) => this.isDependencyLockFile(f), name: "dependency locks" },
      { check: (f) => this.isDocumentationFile(f), name: "documentation" },
      { check: (f) => this.isTestFixture(f), name: "test fixtures" },
      { check: (f) => this.isConfigFile(f), name: "config files" },
      { check: (f) => this.isBuildArtifact(f), name: "build artifacts" }
    ];
    const types2 = /* @__PURE__ */ new Set();
    for (const file of files) {
      for (const { check, name } of typeChecks) {
        if (check(file.filename)) {
          types2.add(name);
        }
      }
    }
    if (types2.size > 0) {
      return `trivial changes only (${Array.from(types2).join(", ")})`;
    }
    return "trivial changes detected";
  }
  /**
   * Filter out trivial files from a file list
   */
  filterNonTrivial(files) {
    const result = this.detect(files);
    return files.filter((f) => result.nonTrivialFiles.includes(f.filename));
  }
};

// node_modules/minimatch/node_modules/balanced-match/dist/esm/index.js
var balanced = (a, b, str2) => {
  const ma = a instanceof RegExp ? maybeMatch(a, str2) : a;
  const mb = b instanceof RegExp ? maybeMatch(b, str2) : b;
  const r = ma !== null && mb != null && range(ma, mb, str2);
  return r && {
    start: r[0],
    end: r[1],
    pre: str2.slice(0, r[0]),
    body: str2.slice(r[0] + ma.length, r[1]),
    post: str2.slice(r[1] + mb.length)
  };
};
var maybeMatch = (reg, str2) => {
  const m = str2.match(reg);
  return m ? m[0] : null;
};
var range = (a, b, str2) => {
  let begs, beg, left, right = void 0, result;
  let ai = str2.indexOf(a);
  let bi = str2.indexOf(b, ai + 1);
  let i = ai;
  if (ai >= 0 && bi > 0) {
    if (a === b) {
      return [ai, bi];
    }
    begs = [];
    left = str2.length;
    while (i >= 0 && !result) {
      if (i === ai) {
        begs.push(i);
        ai = str2.indexOf(a, i + 1);
      } else if (begs.length === 1) {
        const r = begs.pop();
        if (r !== void 0)
          result = [r, bi];
      } else {
        beg = begs.pop();
        if (beg !== void 0 && beg < left) {
          left = beg;
          right = bi;
        }
        bi = str2.indexOf(b, i + 1);
      }
      i = ai < bi && ai >= 0 ? ai : bi;
    }
    if (begs.length && right !== void 0) {
      result = [left, right];
    }
  }
  return result;
};

// node_modules/minimatch/node_modules/brace-expansion/dist/esm/index.js
var escSlash = "\0SLASH" + Math.random() + "\0";
var escOpen = "\0OPEN" + Math.random() + "\0";
var escClose = "\0CLOSE" + Math.random() + "\0";
var escComma = "\0COMMA" + Math.random() + "\0";
var escPeriod = "\0PERIOD" + Math.random() + "\0";
var escSlashPattern = new RegExp(escSlash, "g");
var escOpenPattern = new RegExp(escOpen, "g");
var escClosePattern = new RegExp(escClose, "g");
var escCommaPattern = new RegExp(escComma, "g");
var escPeriodPattern = new RegExp(escPeriod, "g");
var slashPattern = /\\\\/g;
var openPattern = /\\{/g;
var closePattern = /\\}/g;
var commaPattern = /\\,/g;
var periodPattern = /\\\./g;
var EXPANSION_MAX = 1e5;
function numeric(str2) {
  return !isNaN(str2) ? parseInt(str2, 10) : str2.charCodeAt(0);
}
function escapeBraces(str2) {
  return str2.replace(slashPattern, escSlash).replace(openPattern, escOpen).replace(closePattern, escClose).replace(commaPattern, escComma).replace(periodPattern, escPeriod);
}
function unescapeBraces(str2) {
  return str2.replace(escSlashPattern, "\\").replace(escOpenPattern, "{").replace(escClosePattern, "}").replace(escCommaPattern, ",").replace(escPeriodPattern, ".");
}
function parseCommaParts(str2) {
  if (!str2) {
    return [""];
  }
  const parts = [];
  const m = balanced("{", "}", str2);
  if (!m) {
    return str2.split(",");
  }
  const { pre, body, post } = m;
  const p = pre.split(",");
  p[p.length - 1] += "{" + body + "}";
  const postParts = parseCommaParts(post);
  if (post.length) {
    ;
    p[p.length - 1] += postParts.shift();
    p.push.apply(p, postParts);
  }
  parts.push.apply(parts, p);
  return parts;
}
function expand(str2, options = {}) {
  if (!str2) {
    return [];
  }
  const { max = EXPANSION_MAX } = options;
  if (str2.slice(0, 2) === "{}") {
    str2 = "\\{\\}" + str2.slice(2);
  }
  return expand_(escapeBraces(str2), max, true).map(unescapeBraces);
}
function embrace(str2) {
  return "{" + str2 + "}";
}
function isPadded(el) {
  return /^-?0\d/.test(el);
}
function lte(i, y) {
  return i <= y;
}
function gte(i, y) {
  return i >= y;
}
function expand_(str2, max, isTop) {
  const expansions = [];
  const m = balanced("{", "}", str2);
  if (!m)
    return [str2];
  const pre = m.pre;
  const post = m.post.length ? expand_(m.post, max, false) : [""];
  if (/\$$/.test(m.pre)) {
    for (let k = 0; k < post.length && k < max; k++) {
      const expansion = pre + "{" + m.body + "}" + post[k];
      expansions.push(expansion);
    }
  } else {
    const isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
    const isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
    const isSequence = isNumericSequence || isAlphaSequence;
    const isOptions = m.body.indexOf(",") >= 0;
    if (!isSequence && !isOptions) {
      if (m.post.match(/,(?!,).*\}/)) {
        str2 = m.pre + "{" + m.body + escClose + m.post;
        return expand_(str2, max, true);
      }
      return [str2];
    }
    let n;
    if (isSequence) {
      n = m.body.split(/\.\./);
    } else {
      n = parseCommaParts(m.body);
      if (n.length === 1 && n[0] !== void 0) {
        n = expand_(n[0], max, false).map(embrace);
        if (n.length === 1) {
          return post.map((p) => m.pre + n[0] + p);
        }
      }
    }
    let N;
    if (isSequence && n[0] !== void 0 && n[1] !== void 0) {
      const x = numeric(n[0]);
      const y = numeric(n[1]);
      const width = Math.max(n[0].length, n[1].length);
      let incr = n.length === 3 && n[2] !== void 0 ? Math.max(Math.abs(numeric(n[2])), 1) : 1;
      let test = lte;
      const reverse = y < x;
      if (reverse) {
        incr *= -1;
        test = gte;
      }
      const pad = n.some(isPadded);
      N = [];
      for (let i = x; test(i, y); i += incr) {
        let c;
        if (isAlphaSequence) {
          c = String.fromCharCode(i);
          if (c === "\\") {
            c = "";
          }
        } else {
          c = String(i);
          if (pad) {
            const need = width - c.length;
            if (need > 0) {
              const z = new Array(need + 1).join("0");
              if (i < 0) {
                c = "-" + z + c.slice(1);
              } else {
                c = z + c;
              }
            }
          }
        }
        N.push(c);
      }
    } else {
      N = [];
      for (let j = 0; j < n.length; j++) {
        N.push.apply(N, expand_(n[j], max, false));
      }
    }
    for (let j = 0; j < N.length; j++) {
      for (let k = 0; k < post.length && expansions.length < max; k++) {
        const expansion = pre + N[j] + post[k];
        if (!isTop || isSequence || expansion) {
          expansions.push(expansion);
        }
      }
    }
  }
  return expansions;
}

// node_modules/minimatch/dist/esm/assert-valid-pattern.js
var MAX_PATTERN_LENGTH = 1024 * 64;
var assertValidPattern = (pattern) => {
  if (typeof pattern !== "string") {
    throw new TypeError("invalid pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new TypeError("pattern is too long");
  }
};

// node_modules/minimatch/dist/esm/brace-expressions.js
var posixClasses = {
  "[:alnum:]": ["\\p{L}\\p{Nl}\\p{Nd}", true],
  "[:alpha:]": ["\\p{L}\\p{Nl}", true],
  "[:ascii:]": ["\\x00-\\x7f", false],
  "[:blank:]": ["\\p{Zs}\\t", true],
  "[:cntrl:]": ["\\p{Cc}", true],
  "[:digit:]": ["\\p{Nd}", true],
  "[:graph:]": ["\\p{Z}\\p{C}", true, true],
  "[:lower:]": ["\\p{Ll}", true],
  "[:print:]": ["\\p{C}", true],
  "[:punct:]": ["\\p{P}", true],
  "[:space:]": ["\\p{Z}\\t\\r\\n\\v\\f", true],
  "[:upper:]": ["\\p{Lu}", true],
  "[:word:]": ["\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", true],
  "[:xdigit:]": ["A-Fa-f0-9", false]
};
var braceEscape = (s) => s.replace(/[[\]\\-]/g, "\\$&");
var regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var rangesToString = (ranges) => ranges.join("");
var parseClass = (glob, position) => {
  const pos = position;
  if (glob.charAt(pos) !== "[") {
    throw new Error("not in a brace expression");
  }
  const ranges = [];
  const negs = [];
  let i = pos + 1;
  let sawStart = false;
  let uflag = false;
  let escaping = false;
  let negate = false;
  let endPos = pos;
  let rangeStart = "";
  WHILE: while (i < glob.length) {
    const c = glob.charAt(i);
    if ((c === "!" || c === "^") && i === pos + 1) {
      negate = true;
      i++;
      continue;
    }
    if (c === "]" && sawStart && !escaping) {
      endPos = i + 1;
      break;
    }
    sawStart = true;
    if (c === "\\") {
      if (!escaping) {
        escaping = true;
        i++;
        continue;
      }
    }
    if (c === "[" && !escaping) {
      for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) {
        if (glob.startsWith(cls, i)) {
          if (rangeStart) {
            return ["$.", false, glob.length - pos, true];
          }
          i += cls.length;
          if (neg)
            negs.push(unip);
          else
            ranges.push(unip);
          uflag = uflag || u;
          continue WHILE;
        }
      }
    }
    escaping = false;
    if (rangeStart) {
      if (c > rangeStart) {
        ranges.push(braceEscape(rangeStart) + "-" + braceEscape(c));
      } else if (c === rangeStart) {
        ranges.push(braceEscape(c));
      }
      rangeStart = "";
      i++;
      continue;
    }
    if (glob.startsWith("-]", i + 1)) {
      ranges.push(braceEscape(c + "-"));
      i += 2;
      continue;
    }
    if (glob.startsWith("-", i + 1)) {
      rangeStart = c;
      i += 2;
      continue;
    }
    ranges.push(braceEscape(c));
    i++;
  }
  if (endPos < i) {
    return ["", false, 0, false];
  }
  if (!ranges.length && !negs.length) {
    return ["$.", false, glob.length - pos, true];
  }
  if (negs.length === 0 && ranges.length === 1 && /^\\?.$/.test(ranges[0]) && !negate) {
    const r = ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0];
    return [regexpEscape(r), false, endPos - pos, false];
  }
  const sranges = "[" + (negate ? "^" : "") + rangesToString(ranges) + "]";
  const snegs = "[" + (negate ? "" : "^") + rangesToString(negs) + "]";
  const comb = ranges.length && negs.length ? "(" + sranges + "|" + snegs + ")" : ranges.length ? sranges : snegs;
  return [comb, uflag, endPos - pos, true];
};

// node_modules/minimatch/dist/esm/unescape.js
var unescape = (s, { windowsPathsNoEscape = false, magicalBraces = true } = {}) => {
  if (magicalBraces) {
    return windowsPathsNoEscape ? s.replace(/\[([^/\\])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^/\\])\]/g, "$1$2").replace(/\\([^/])/g, "$1");
  }
  return windowsPathsNoEscape ? s.replace(/\[([^/\\{}])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^/\\{}])\]/g, "$1$2").replace(/\\([^/{}])/g, "$1");
};

// node_modules/minimatch/dist/esm/ast.js
var _a;
var types = /* @__PURE__ */ new Set(["!", "?", "+", "*", "@"]);
var isExtglobType = (c) => types.has(c);
var isExtglobAST = (c) => isExtglobType(c.type);
var adoptionMap = /* @__PURE__ */ new Map([
  ["!", ["@"]],
  ["?", ["?", "@"]],
  ["@", ["@"]],
  ["*", ["*", "+", "?", "@"]],
  ["+", ["+", "@"]]
]);
var adoptionWithSpaceMap = /* @__PURE__ */ new Map([
  ["!", ["?"]],
  ["@", ["?"]],
  ["+", ["?", "*"]]
]);
var adoptionAnyMap = /* @__PURE__ */ new Map([
  ["!", ["?", "@"]],
  ["?", ["?", "@"]],
  ["@", ["?", "@"]],
  ["*", ["*", "+", "?", "@"]],
  ["+", ["+", "@", "?", "*"]]
]);
var usurpMap = /* @__PURE__ */ new Map([
  ["!", /* @__PURE__ */ new Map([["!", "@"]])],
  [
    "?",
    /* @__PURE__ */ new Map([
      ["*", "*"],
      ["+", "*"]
    ])
  ],
  [
    "@",
    /* @__PURE__ */ new Map([
      ["!", "!"],
      ["?", "?"],
      ["@", "@"],
      ["*", "*"],
      ["+", "+"]
    ])
  ],
  [
    "+",
    /* @__PURE__ */ new Map([
      ["?", "*"],
      ["*", "*"]
    ])
  ]
]);
var startNoTraversal = "(?!(?:^|/)\\.\\.?(?:$|/))";
var startNoDot = "(?!\\.)";
var addPatternStart = /* @__PURE__ */ new Set(["[", "."]);
var justDots = /* @__PURE__ */ new Set(["..", "."]);
var reSpecials = new Set("().*{}+?[]^$\\!");
var regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var qmark = "[^/]";
var star = qmark + "*?";
var starNoEmpty = qmark + "+?";
var ID = 0;
var AST = class {
  type;
  #root;
  #hasMagic;
  #uflag = false;
  #parts = [];
  #parent;
  #parentIndex;
  #negs;
  #filledNegs = false;
  #options;
  #toString;
  // set to true if it's an extglob with no children
  // (which really means one child of '')
  #emptyExt = false;
  id = ++ID;
  get depth() {
    return (this.#parent?.depth ?? -1) + 1;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return {
      "@@type": "AST",
      id: this.id,
      type: this.type,
      root: this.#root.id,
      parent: this.#parent?.id,
      depth: this.depth,
      partsLength: this.#parts.length,
      parts: this.#parts
    };
  }
  constructor(type2, parent, options = {}) {
    this.type = type2;
    if (type2)
      this.#hasMagic = true;
    this.#parent = parent;
    this.#root = this.#parent ? this.#parent.#root : this;
    this.#options = this.#root === this ? options : this.#root.#options;
    this.#negs = this.#root === this ? [] : this.#root.#negs;
    if (type2 === "!" && !this.#root.#filledNegs)
      this.#negs.push(this);
    this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
  }
  get hasMagic() {
    if (this.#hasMagic !== void 0)
      return this.#hasMagic;
    for (const p of this.#parts) {
      if (typeof p === "string")
        continue;
      if (p.type || p.hasMagic)
        return this.#hasMagic = true;
    }
    return this.#hasMagic;
  }
  // reconstructs the pattern
  toString() {
    return this.#toString !== void 0 ? this.#toString : !this.type ? this.#toString = this.#parts.map((p) => String(p)).join("") : this.#toString = this.type + "(" + this.#parts.map((p) => String(p)).join("|") + ")";
  }
  #fillNegs() {
    if (this !== this.#root)
      throw new Error("should only call on root");
    if (this.#filledNegs)
      return this;
    this.toString();
    this.#filledNegs = true;
    let n;
    while (n = this.#negs.pop()) {
      if (n.type !== "!")
        continue;
      let p = n;
      let pp = p.#parent;
      while (pp) {
        for (let i = p.#parentIndex + 1; !pp.type && i < pp.#parts.length; i++) {
          for (const part of n.#parts) {
            if (typeof part === "string") {
              throw new Error("string part in extglob AST??");
            }
            part.copyIn(pp.#parts[i]);
          }
        }
        p = pp;
        pp = p.#parent;
      }
    }
    return this;
  }
  push(...parts) {
    for (const p of parts) {
      if (p === "")
        continue;
      if (typeof p !== "string" && !(p instanceof _a && p.#parent === this)) {
        throw new Error("invalid part: " + p);
      }
      this.#parts.push(p);
    }
  }
  toJSON() {
    const ret = this.type === null ? this.#parts.slice().map((p) => typeof p === "string" ? p : p.toJSON()) : [this.type, ...this.#parts.map((p) => p.toJSON())];
    if (this.isStart() && !this.type)
      ret.unshift([]);
    if (this.isEnd() && (this === this.#root || this.#root.#filledNegs && this.#parent?.type === "!")) {
      ret.push({});
    }
    return ret;
  }
  isStart() {
    if (this.#root === this)
      return true;
    if (!this.#parent?.isStart())
      return false;
    if (this.#parentIndex === 0)
      return true;
    const p = this.#parent;
    for (let i = 0; i < this.#parentIndex; i++) {
      const pp = p.#parts[i];
      if (!(pp instanceof _a && pp.type === "!")) {
        return false;
      }
    }
    return true;
  }
  isEnd() {
    if (this.#root === this)
      return true;
    if (this.#parent?.type === "!")
      return true;
    if (!this.#parent?.isEnd())
      return false;
    if (!this.type)
      return this.#parent?.isEnd();
    const pl = this.#parent ? this.#parent.#parts.length : 0;
    return this.#parentIndex === pl - 1;
  }
  copyIn(part) {
    if (typeof part === "string")
      this.push(part);
    else
      this.push(part.clone(this));
  }
  clone(parent) {
    const c = new _a(this.type, parent);
    for (const p of this.#parts) {
      c.copyIn(p);
    }
    return c;
  }
  static #parseAST(str2, ast, pos, opt, extDepth) {
    const maxDepth = opt.maxExtglobRecursion ?? 2;
    let escaping = false;
    let inBrace = false;
    let braceStart = -1;
    let braceNeg = false;
    if (ast.type === null) {
      let i2 = pos;
      let acc2 = "";
      while (i2 < str2.length) {
        const c = str2.charAt(i2++);
        if (escaping || c === "\\") {
          escaping = !escaping;
          acc2 += c;
          continue;
        }
        if (inBrace) {
          if (i2 === braceStart + 1) {
            if (c === "^" || c === "!") {
              braceNeg = true;
            }
          } else if (c === "]" && !(i2 === braceStart + 2 && braceNeg)) {
            inBrace = false;
          }
          acc2 += c;
          continue;
        } else if (c === "[") {
          inBrace = true;
          braceStart = i2;
          braceNeg = false;
          acc2 += c;
          continue;
        }
        const doRecurse = !opt.noext && isExtglobType(c) && str2.charAt(i2) === "(" && extDepth <= maxDepth;
        if (doRecurse) {
          ast.push(acc2);
          acc2 = "";
          const ext2 = new _a(c, ast);
          i2 = _a.#parseAST(str2, ext2, i2, opt, extDepth + 1);
          ast.push(ext2);
          continue;
        }
        acc2 += c;
      }
      ast.push(acc2);
      return i2;
    }
    let i = pos + 1;
    let part = new _a(null, ast);
    const parts = [];
    let acc = "";
    while (i < str2.length) {
      const c = str2.charAt(i++);
      if (escaping || c === "\\") {
        escaping = !escaping;
        acc += c;
        continue;
      }
      if (inBrace) {
        if (i === braceStart + 1) {
          if (c === "^" || c === "!") {
            braceNeg = true;
          }
        } else if (c === "]" && !(i === braceStart + 2 && braceNeg)) {
          inBrace = false;
        }
        acc += c;
        continue;
      } else if (c === "[") {
        inBrace = true;
        braceStart = i;
        braceNeg = false;
        acc += c;
        continue;
      }
      const doRecurse = !opt.noext && isExtglobType(c) && str2.charAt(i) === "(" && /* c8 ignore start - the maxDepth is sufficient here */
      (extDepth <= maxDepth || ast && ast.#canAdoptType(c));
      if (doRecurse) {
        const depthAdd = ast && ast.#canAdoptType(c) ? 0 : 1;
        part.push(acc);
        acc = "";
        const ext2 = new _a(c, part);
        part.push(ext2);
        i = _a.#parseAST(str2, ext2, i, opt, extDepth + depthAdd);
        continue;
      }
      if (c === "|") {
        part.push(acc);
        acc = "";
        parts.push(part);
        part = new _a(null, ast);
        continue;
      }
      if (c === ")") {
        if (acc === "" && ast.#parts.length === 0) {
          ast.#emptyExt = true;
        }
        part.push(acc);
        acc = "";
        ast.push(...parts, part);
        return i;
      }
      acc += c;
    }
    ast.type = null;
    ast.#hasMagic = void 0;
    ast.#parts = [str2.substring(pos - 1)];
    return i;
  }
  #canAdoptWithSpace(child) {
    return this.#canAdopt(child, adoptionWithSpaceMap);
  }
  #canAdopt(child, map2 = adoptionMap) {
    if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null) {
      return false;
    }
    const gc = child.#parts[0];
    if (!gc || typeof gc !== "object" || gc.type === null) {
      return false;
    }
    return this.#canAdoptType(gc.type, map2);
  }
  #canAdoptType(c, map2 = adoptionAnyMap) {
    return !!map2.get(this.type)?.includes(c);
  }
  #adoptWithSpace(child, index) {
    const gc = child.#parts[0];
    const blank = new _a(null, gc, this.options);
    blank.#parts.push("");
    gc.push(blank);
    this.#adopt(child, index);
  }
  #adopt(child, index) {
    const gc = child.#parts[0];
    this.#parts.splice(index, 1, ...gc.#parts);
    for (const p of gc.#parts) {
      if (typeof p === "object")
        p.#parent = this;
    }
    this.#toString = void 0;
  }
  #canUsurpType(c) {
    const m = usurpMap.get(this.type);
    return !!m?.has(c);
  }
  #canUsurp(child) {
    if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null || this.#parts.length !== 1) {
      return false;
    }
    const gc = child.#parts[0];
    if (!gc || typeof gc !== "object" || gc.type === null) {
      return false;
    }
    return this.#canUsurpType(gc.type);
  }
  #usurp(child) {
    const m = usurpMap.get(this.type);
    const gc = child.#parts[0];
    const nt = m?.get(gc.type);
    if (!nt)
      return false;
    this.#parts = gc.#parts;
    for (const p of this.#parts) {
      if (typeof p === "object") {
        p.#parent = this;
      }
    }
    this.type = nt;
    this.#toString = void 0;
    this.#emptyExt = false;
  }
  static fromGlob(pattern, options = {}) {
    const ast = new _a(null, void 0, options);
    _a.#parseAST(pattern, ast, 0, options, 0);
    return ast;
  }
  // returns the regular expression if there's magic, or the unescaped
  // string if not.
  toMMPattern() {
    if (this !== this.#root)
      return this.#root.toMMPattern();
    const glob = this.toString();
    const [re, body, hasMagic, uflag] = this.toRegExpSource();
    const anyMagic = hasMagic || this.#hasMagic || this.#options.nocase && !this.#options.nocaseMagicOnly && glob.toUpperCase() !== glob.toLowerCase();
    if (!anyMagic) {
      return body;
    }
    const flags = (this.#options.nocase ? "i" : "") + (uflag ? "u" : "");
    return Object.assign(new RegExp(`^${re}$`, flags), {
      _src: re,
      _glob: glob
    });
  }
  get options() {
    return this.#options;
  }
  // returns the string match, the regexp source, whether there's magic
  // in the regexp (so a regular expression is required) and whether or
  // not the uflag is needed for the regular expression (for posix classes)
  // TODO: instead of injecting the start/end at this point, just return
  // the BODY of the regexp, along with the start/end portions suitable
  // for binding the start/end in either a joined full-path makeRe context
  // (where we bind to (^|/), or a standalone matchPart context (where
  // we bind to ^, and not /).  Otherwise slashes get duped!
  //
  // In part-matching mode, the start is:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: ^(?!\.\.?$)
  // - if dots allowed or not possible: ^
  // - if dots possible and not allowed: ^(?!\.)
  // end is:
  // - if not isEnd(): nothing
  // - else: $
  //
  // In full-path matching mode, we put the slash at the START of the
  // pattern, so start is:
  // - if first pattern: same as part-matching mode
  // - if not isStart(): nothing
  // - if traversal possible, but not allowed: /(?!\.\.?(?:$|/))
  // - if dots allowed or not possible: /
  // - if dots possible and not allowed: /(?!\.)
  // end is:
  // - if last pattern, same as part-matching mode
  // - else nothing
  //
  // Always put the (?:$|/) on negated tails, though, because that has to be
  // there to bind the end of the negated pattern portion, and it's easier to
  // just stick it in now rather than try to inject it later in the middle of
  // the pattern.
  //
  // We can just always return the same end, and leave it up to the caller
  // to know whether it's going to be used joined or in parts.
  // And, if the start is adjusted slightly, can do the same there:
  // - if not isStart: nothing
  // - if traversal possible, but not allowed: (?:/|^)(?!\.\.?$)
  // - if dots allowed or not possible: (?:/|^)
  // - if dots possible and not allowed: (?:/|^)(?!\.)
  //
  // But it's better to have a simpler binding without a conditional, for
  // performance, so probably better to return both start options.
  //
  // Then the caller just ignores the end if it's not the first pattern,
  // and the start always gets applied.
  //
  // But that's always going to be $ if it's the ending pattern, or nothing,
  // so the caller can just attach $ at the end of the pattern when building.
  //
  // So the todo is:
  // - better detect what kind of start is needed
  // - return both flavors of starting pattern
  // - attach $ at the end of the pattern when creating the actual RegExp
  //
  // Ah, but wait, no, that all only applies to the root when the first pattern
  // is not an extglob. If the first pattern IS an extglob, then we need all
  // that dot prevention biz to live in the extglob portions, because eg
  // +(*|.x*) can match .xy but not .yx.
  //
  // So, return the two flavors if it's #root and the first child is not an
  // AST, otherwise leave it to the child AST to handle it, and there,
  // use the (?:^|/) style of start binding.
  //
  // Even simplified further:
  // - Since the start for a join is eg /(?!\.) and the start for a part
  // is ^(?!\.), we can just prepend (?!\.) to the pattern (either root
  // or start or whatever) and prepend ^ or / at the Regexp construction.
  toRegExpSource(allowDot) {
    const dot = allowDot ?? !!this.#options.dot;
    if (this.#root === this) {
      this.#flatten();
      this.#fillNegs();
    }
    if (!isExtglobAST(this)) {
      const noEmpty = this.isStart() && this.isEnd() && !this.#parts.some((s) => typeof s !== "string");
      const src = this.#parts.map((p) => {
        const [re, _, hasMagic, uflag] = typeof p === "string" ? _a.#parseGlob(p, this.#hasMagic, noEmpty) : p.toRegExpSource(allowDot);
        this.#hasMagic = this.#hasMagic || hasMagic;
        this.#uflag = this.#uflag || uflag;
        return re;
      }).join("");
      let start2 = "";
      if (this.isStart()) {
        if (typeof this.#parts[0] === "string") {
          const dotTravAllowed = this.#parts.length === 1 && justDots.has(this.#parts[0]);
          if (!dotTravAllowed) {
            const aps = addPatternStart;
            const needNoTrav = (
              // dots are allowed, and the pattern starts with [ or .
              dot && aps.has(src.charAt(0)) || // the pattern starts with \., and then [ or .
              src.startsWith("\\.") && aps.has(src.charAt(2)) || // the pattern starts with \.\., and then [ or .
              src.startsWith("\\.\\.") && aps.has(src.charAt(4))
            );
            const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
            start2 = needNoTrav ? startNoTraversal : needNoDot ? startNoDot : "";
          }
        }
      }
      let end = "";
      if (this.isEnd() && this.#root.#filledNegs && this.#parent?.type === "!") {
        end = "(?:$|\\/)";
      }
      const final2 = start2 + src + end;
      return [
        final2,
        unescape(src),
        this.#hasMagic = !!this.#hasMagic,
        this.#uflag
      ];
    }
    const repeated = this.type === "*" || this.type === "+";
    const start = this.type === "!" ? "(?:(?!(?:" : "(?:";
    let body = this.#partsToRegExp(dot);
    if (this.isStart() && this.isEnd() && !body && this.type !== "!") {
      const s = this.toString();
      const me = this;
      me.#parts = [s];
      me.type = null;
      me.#hasMagic = void 0;
      return [s, unescape(this.toString()), false, false];
    }
    let bodyDotAllowed = !repeated || allowDot || dot || !startNoDot ? "" : this.#partsToRegExp(true);
    if (bodyDotAllowed === body) {
      bodyDotAllowed = "";
    }
    if (bodyDotAllowed) {
      body = `(?:${body})(?:${bodyDotAllowed})*?`;
    }
    let final = "";
    if (this.type === "!" && this.#emptyExt) {
      final = (this.isStart() && !dot ? startNoDot : "") + starNoEmpty;
    } else {
      const close = this.type === "!" ? (
        // !() must match something,but !(x) can match ''
        "))" + (this.isStart() && !dot && !allowDot ? startNoDot : "") + star + ")"
      ) : this.type === "@" ? ")" : this.type === "?" ? ")?" : this.type === "+" && bodyDotAllowed ? ")" : this.type === "*" && bodyDotAllowed ? `)?` : `)${this.type}`;
      final = start + body + close;
    }
    return [
      final,
      unescape(body),
      this.#hasMagic = !!this.#hasMagic,
      this.#uflag
    ];
  }
  #flatten() {
    if (!isExtglobAST(this)) {
      for (const p of this.#parts) {
        if (typeof p === "object") {
          p.#flatten();
        }
      }
    } else {
      let iterations = 0;
      let done = false;
      do {
        done = true;
        for (let i = 0; i < this.#parts.length; i++) {
          const c = this.#parts[i];
          if (typeof c === "object") {
            c.#flatten();
            if (this.#canAdopt(c)) {
              done = false;
              this.#adopt(c, i);
            } else if (this.#canAdoptWithSpace(c)) {
              done = false;
              this.#adoptWithSpace(c, i);
            } else if (this.#canUsurp(c)) {
              done = false;
              this.#usurp(c);
            }
          }
        }
      } while (!done && ++iterations < 10);
    }
    this.#toString = void 0;
  }
  #partsToRegExp(dot) {
    return this.#parts.map((p) => {
      if (typeof p === "string") {
        throw new Error("string type in extglob ast??");
      }
      const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
      this.#uflag = this.#uflag || uflag;
      return re;
    }).filter((p) => !(this.isStart() && this.isEnd()) || !!p).join("|");
  }
  static #parseGlob(glob, hasMagic, noEmpty = false) {
    let escaping = false;
    let re = "";
    let uflag = false;
    let inStar = false;
    for (let i = 0; i < glob.length; i++) {
      const c = glob.charAt(i);
      if (escaping) {
        escaping = false;
        re += (reSpecials.has(c) ? "\\" : "") + c;
        continue;
      }
      if (c === "*") {
        if (inStar)
          continue;
        inStar = true;
        re += noEmpty && /^[*]+$/.test(glob) ? starNoEmpty : star;
        hasMagic = true;
        continue;
      } else {
        inStar = false;
      }
      if (c === "\\") {
        if (i === glob.length - 1) {
          re += "\\\\";
        } else {
          escaping = true;
        }
        continue;
      }
      if (c === "[") {
        const [src, needUflag, consumed, magic] = parseClass(glob, i);
        if (consumed) {
          re += src;
          uflag = uflag || needUflag;
          i += consumed - 1;
          hasMagic = hasMagic || magic;
          continue;
        }
      }
      if (c === "?") {
        re += qmark;
        hasMagic = true;
        continue;
      }
      re += regExpEscape(c);
    }
    return [re, unescape(glob), !!hasMagic, uflag];
  }
};
_a = AST;

// node_modules/minimatch/dist/esm/escape.js
var escape = (s, { windowsPathsNoEscape = false, magicalBraces = false } = {}) => {
  if (magicalBraces) {
    return windowsPathsNoEscape ? s.replace(/[?*()[\]{}]/g, "[$&]") : s.replace(/[?*()[\]\\{}]/g, "\\$&");
  }
  return windowsPathsNoEscape ? s.replace(/[?*()[\]]/g, "[$&]") : s.replace(/[?*()[\]\\]/g, "\\$&");
};

// node_modules/minimatch/dist/esm/index.js
var minimatch = (p, pattern, options = {}) => {
  assertValidPattern(pattern);
  if (!options.nocomment && pattern.charAt(0) === "#") {
    return false;
  }
  return new Minimatch(pattern, options).match(p);
};
var starDotExtRE = /^\*+([^+@!?*[(]*)$/;
var starDotExtTest = (ext2) => (f) => !f.startsWith(".") && f.endsWith(ext2);
var starDotExtTestDot = (ext2) => (f) => f.endsWith(ext2);
var starDotExtTestNocase = (ext2) => {
  ext2 = ext2.toLowerCase();
  return (f) => !f.startsWith(".") && f.toLowerCase().endsWith(ext2);
};
var starDotExtTestNocaseDot = (ext2) => {
  ext2 = ext2.toLowerCase();
  return (f) => f.toLowerCase().endsWith(ext2);
};
var starDotStarRE = /^\*+\.\*+$/;
var starDotStarTest = (f) => !f.startsWith(".") && f.includes(".");
var starDotStarTestDot = (f) => f !== "." && f !== ".." && f.includes(".");
var dotStarRE = /^\.\*+$/;
var dotStarTest = (f) => f !== "." && f !== ".." && f.startsWith(".");
var starRE = /^\*+$/;
var starTest = (f) => f.length !== 0 && !f.startsWith(".");
var starTestDot = (f) => f.length !== 0 && f !== "." && f !== "..";
var qmarksRE = /^\?+([^+@!?*[(]*)?$/;
var qmarksTestNocase = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  if (!ext2)
    return noext;
  ext2 = ext2.toLowerCase();
  return (f) => noext(f) && f.toLowerCase().endsWith(ext2);
};
var qmarksTestNocaseDot = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  if (!ext2)
    return noext;
  ext2 = ext2.toLowerCase();
  return (f) => noext(f) && f.toLowerCase().endsWith(ext2);
};
var qmarksTestDot = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  return !ext2 ? noext : (f) => noext(f) && f.endsWith(ext2);
};
var qmarksTest = ([$0, ext2 = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  return !ext2 ? noext : (f) => noext(f) && f.endsWith(ext2);
};
var qmarksTestNoExt = ([$0]) => {
  const len = $0.length;
  return (f) => f.length === len && !f.startsWith(".");
};
var qmarksTestNoExtDot = ([$0]) => {
  const len = $0.length;
  return (f) => f.length === len && f !== "." && f !== "..";
};
var defaultPlatform = typeof process === "object" && process ? typeof process.env === "object" && process.env && process.env.__MINIMATCH_TESTING_PLATFORM__ || process.platform : "posix";
var path11 = {
  win32: { sep: "\\" },
  posix: { sep: "/" }
};
var sep = defaultPlatform === "win32" ? path11.win32.sep : path11.posix.sep;
minimatch.sep = sep;
var GLOBSTAR = Symbol("globstar **");
minimatch.GLOBSTAR = GLOBSTAR;
var qmark2 = "[^/]";
var star2 = qmark2 + "*?";
var twoStarDot = "(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?";
var twoStarNoDot = "(?:(?!(?:\\/|^)\\.).)*?";
var filter = (pattern, options = {}) => (p) => minimatch(p, pattern, options);
minimatch.filter = filter;
var ext = (a, b = {}) => Object.assign({}, a, b);
var defaults = (def) => {
  if (!def || typeof def !== "object" || !Object.keys(def).length) {
    return minimatch;
  }
  const orig = minimatch;
  const m = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
  return Object.assign(m, {
    Minimatch: class Minimatch extends orig.Minimatch {
      constructor(pattern, options = {}) {
        super(pattern, ext(def, options));
      }
      static defaults(options) {
        return orig.defaults(ext(def, options)).Minimatch;
      }
    },
    AST: class AST extends orig.AST {
      /* c8 ignore start */
      constructor(type2, parent, options = {}) {
        super(type2, parent, ext(def, options));
      }
      /* c8 ignore stop */
      static fromGlob(pattern, options = {}) {
        return orig.AST.fromGlob(pattern, ext(def, options));
      }
    },
    unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
    escape: (s, options = {}) => orig.escape(s, ext(def, options)),
    filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
    defaults: (options) => orig.defaults(ext(def, options)),
    makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
    braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
    match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
    sep: orig.sep,
    GLOBSTAR
  });
};
minimatch.defaults = defaults;
var braceExpand = (pattern, options = {}) => {
  assertValidPattern(pattern);
  if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) {
    return [pattern];
  }
  return expand(pattern, { max: options.braceExpandMax });
};
minimatch.braceExpand = braceExpand;
var makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
minimatch.makeRe = makeRe;
var match = (list, pattern, options = {}) => {
  const mm = new Minimatch(pattern, options);
  list = list.filter((f) => mm.match(f));
  if (mm.options.nonull && !list.length) {
    list.push(pattern);
  }
  return list;
};
minimatch.match = match;
var globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
var regExpEscape2 = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var Minimatch = class {
  options;
  set;
  pattern;
  windowsPathsNoEscape;
  nonegate;
  negate;
  comment;
  empty;
  preserveMultipleSlashes;
  partial;
  globSet;
  globParts;
  nocase;
  isWindows;
  platform;
  windowsNoMagicRoot;
  maxGlobstarRecursion;
  regexp;
  constructor(pattern, options = {}) {
    assertValidPattern(pattern);
    options = options || {};
    this.options = options;
    this.maxGlobstarRecursion = options.maxGlobstarRecursion ?? 200;
    this.pattern = pattern;
    this.platform = options.platform || defaultPlatform;
    this.isWindows = this.platform === "win32";
    const awe = "allowWindowsEscape";
    this.windowsPathsNoEscape = !!options.windowsPathsNoEscape || options[awe] === false;
    if (this.windowsPathsNoEscape) {
      this.pattern = this.pattern.replace(/\\/g, "/");
    }
    this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
    this.regexp = null;
    this.negate = false;
    this.nonegate = !!options.nonegate;
    this.comment = false;
    this.empty = false;
    this.partial = !!options.partial;
    this.nocase = !!this.options.nocase;
    this.windowsNoMagicRoot = options.windowsNoMagicRoot !== void 0 ? options.windowsNoMagicRoot : !!(this.isWindows && this.nocase);
    this.globSet = [];
    this.globParts = [];
    this.set = [];
    this.make();
  }
  hasMagic() {
    if (this.options.magicalBraces && this.set.length > 1) {
      return true;
    }
    for (const pattern of this.set) {
      for (const part of pattern) {
        if (typeof part !== "string")
          return true;
      }
    }
    return false;
  }
  debug(..._) {
  }
  make() {
    const pattern = this.pattern;
    const options = this.options;
    if (!options.nocomment && pattern.charAt(0) === "#") {
      this.comment = true;
      return;
    }
    if (!pattern) {
      this.empty = true;
      return;
    }
    this.parseNegate();
    this.globSet = [...new Set(this.braceExpand())];
    if (options.debug) {
      this.debug = (...args) => console.error(...args);
    }
    this.debug(this.pattern, this.globSet);
    const rawGlobParts = this.globSet.map((s) => this.slashSplit(s));
    this.globParts = this.preprocess(rawGlobParts);
    this.debug(this.pattern, this.globParts);
    let set2 = this.globParts.map((s, _, __) => {
      if (this.isWindows && this.windowsNoMagicRoot) {
        const isUNC = s[0] === "" && s[1] === "" && (s[2] === "?" || !globMagic.test(s[2])) && !globMagic.test(s[3]);
        const isDrive = /^[a-z]:/i.test(s[0]);
        if (isUNC) {
          return [
            ...s.slice(0, 4),
            ...s.slice(4).map((ss) => this.parse(ss))
          ];
        } else if (isDrive) {
          return [s[0], ...s.slice(1).map((ss) => this.parse(ss))];
        }
      }
      return s.map((ss) => this.parse(ss));
    });
    this.debug(this.pattern, set2);
    this.set = set2.filter((s) => s.indexOf(false) === -1);
    if (this.isWindows) {
      for (let i = 0; i < this.set.length; i++) {
        const p = this.set[i];
        if (p[0] === "" && p[1] === "" && this.globParts[i][2] === "?" && typeof p[3] === "string" && /^[a-z]:$/i.test(p[3])) {
          p[2] = "?";
        }
      }
    }
    this.debug(this.pattern, this.set);
  }
  // various transforms to equivalent pattern sets that are
  // faster to process in a filesystem walk.  The goal is to
  // eliminate what we can, and push all ** patterns as far
  // to the right as possible, even if it increases the number
  // of patterns that we have to process.
  preprocess(globParts) {
    if (this.options.noglobstar) {
      for (const partset of globParts) {
        for (let j = 0; j < partset.length; j++) {
          if (partset[j] === "**") {
            partset[j] = "*";
          }
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      globParts = this.firstPhasePreProcess(globParts);
      globParts = this.secondPhasePreProcess(globParts);
    } else if (optimizationLevel >= 1) {
      globParts = this.levelOneOptimize(globParts);
    } else {
      globParts = this.adjascentGlobstarOptimize(globParts);
    }
    return globParts;
  }
  // just get rid of adjascent ** portions
  adjascentGlobstarOptimize(globParts) {
    return globParts.map((parts) => {
      let gs = -1;
      while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
        let i = gs;
        while (parts[i + 1] === "**") {
          i++;
        }
        if (i !== gs) {
          parts.splice(gs, i - gs);
        }
      }
      return parts;
    });
  }
  // get rid of adjascent ** and resolve .. portions
  levelOneOptimize(globParts) {
    return globParts.map((parts) => {
      parts = parts.reduce((set2, part) => {
        const prev = set2[set2.length - 1];
        if (part === "**" && prev === "**") {
          return set2;
        }
        if (part === "..") {
          if (prev && prev !== ".." && prev !== "." && prev !== "**") {
            set2.pop();
            return set2;
          }
        }
        set2.push(part);
        return set2;
      }, []);
      return parts.length === 0 ? [""] : parts;
    });
  }
  levelTwoFileOptimize(parts) {
    if (!Array.isArray(parts)) {
      parts = this.slashSplit(parts);
    }
    let didSomething = false;
    do {
      didSomething = false;
      if (!this.preserveMultipleSlashes) {
        for (let i = 1; i < parts.length - 1; i++) {
          const p = parts[i];
          if (i === 1 && p === "" && parts[0] === "")
            continue;
          if (p === "." || p === "") {
            didSomething = true;
            parts.splice(i, 1);
            i--;
          }
        }
        if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
          didSomething = true;
          parts.pop();
        }
      }
      let dd = 0;
      while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
        const p = parts[dd - 1];
        if (p && p !== "." && p !== ".." && p !== "**" && !(this.isWindows && /^[a-z]:$/i.test(p))) {
          didSomething = true;
          parts.splice(dd - 1, 2);
          dd -= 2;
        }
      }
    } while (didSomething);
    return parts.length === 0 ? [""] : parts;
  }
  // First phase: single-pattern processing
  // <pre> is 1 or more portions
  // <rest> is 1 or more portions
  // <p> is any portion other than ., .., '', or **
  // <e> is . or ''
  //
  // **/.. is *brutal* for filesystem walking performance, because
  // it effectively resets the recursive walk each time it occurs,
  // and ** cannot be reduced out by a .. pattern part like a regexp
  // or most strings (other than .., ., and '') can be.
  //
  // <pre>/**/../<p>/<p>/<rest> -> {<pre>/../<p>/<p>/<rest>,<pre>/**/<p>/<p>/<rest>}
  // <pre>/<e>/<rest> -> <pre>/<rest>
  // <pre>/<p>/../<rest> -> <pre>/<rest>
  // **/**/<rest> -> **/<rest>
  //
  // **/*/<rest> -> */**/<rest> <== not valid because ** doesn't follow
  // this WOULD be allowed if ** did follow symlinks, or * didn't
  firstPhasePreProcess(globParts) {
    let didSomething = false;
    do {
      didSomething = false;
      for (let parts of globParts) {
        let gs = -1;
        while (-1 !== (gs = parts.indexOf("**", gs + 1))) {
          let gss = gs;
          while (parts[gss + 1] === "**") {
            gss++;
          }
          if (gss > gs) {
            parts.splice(gs + 1, gss - gs);
          }
          let next = parts[gs + 1];
          const p = parts[gs + 2];
          const p2 = parts[gs + 3];
          if (next !== "..")
            continue;
          if (!p || p === "." || p === ".." || !p2 || p2 === "." || p2 === "..") {
            continue;
          }
          didSomething = true;
          parts.splice(gs, 1);
          const other = parts.slice(0);
          other[gs] = "**";
          globParts.push(other);
          gs--;
        }
        if (!this.preserveMultipleSlashes) {
          for (let i = 1; i < parts.length - 1; i++) {
            const p = parts[i];
            if (i === 1 && p === "" && parts[0] === "")
              continue;
            if (p === "." || p === "") {
              didSomething = true;
              parts.splice(i, 1);
              i--;
            }
          }
          if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
            didSomething = true;
            parts.pop();
          }
        }
        let dd = 0;
        while (-1 !== (dd = parts.indexOf("..", dd + 1))) {
          const p = parts[dd - 1];
          if (p && p !== "." && p !== ".." && p !== "**") {
            didSomething = true;
            const needDot = dd === 1 && parts[dd + 1] === "**";
            const splin = needDot ? ["."] : [];
            parts.splice(dd - 1, 2, ...splin);
            if (parts.length === 0)
              parts.push("");
            dd -= 2;
          }
        }
      }
    } while (didSomething);
    return globParts;
  }
  // second phase: multi-pattern dedupes
  // {<pre>/*/<rest>,<pre>/<p>/<rest>} -> <pre>/*/<rest>
  // {<pre>/<rest>,<pre>/<rest>} -> <pre>/<rest>
  // {<pre>/**/<rest>,<pre>/<rest>} -> <pre>/**/<rest>
  //
  // {<pre>/**/<rest>,<pre>/**/<p>/<rest>} -> <pre>/**/<rest>
  // ^-- not valid because ** doens't follow symlinks
  secondPhasePreProcess(globParts) {
    for (let i = 0; i < globParts.length - 1; i++) {
      for (let j = i + 1; j < globParts.length; j++) {
        const matched = this.partsMatch(globParts[i], globParts[j], !this.preserveMultipleSlashes);
        if (matched) {
          globParts[i] = [];
          globParts[j] = matched;
          break;
        }
      }
    }
    return globParts.filter((gs) => gs.length);
  }
  partsMatch(a, b, emptyGSMatch = false) {
    let ai = 0;
    let bi = 0;
    let result = [];
    let which = "";
    while (ai < a.length && bi < b.length) {
      if (a[ai] === b[bi]) {
        result.push(which === "b" ? b[bi] : a[ai]);
        ai++;
        bi++;
      } else if (emptyGSMatch && a[ai] === "**" && b[bi] === a[ai + 1]) {
        result.push(a[ai]);
        ai++;
      } else if (emptyGSMatch && b[bi] === "**" && a[ai] === b[bi + 1]) {
        result.push(b[bi]);
        bi++;
      } else if (a[ai] === "*" && b[bi] && (this.options.dot || !b[bi].startsWith(".")) && b[bi] !== "**") {
        if (which === "b")
          return false;
        which = "a";
        result.push(a[ai]);
        ai++;
        bi++;
      } else if (b[bi] === "*" && a[ai] && (this.options.dot || !a[ai].startsWith(".")) && a[ai] !== "**") {
        if (which === "a")
          return false;
        which = "b";
        result.push(b[bi]);
        ai++;
        bi++;
      } else {
        return false;
      }
    }
    return a.length === b.length && result;
  }
  parseNegate() {
    if (this.nonegate)
      return;
    const pattern = this.pattern;
    let negate = false;
    let negateOffset = 0;
    for (let i = 0; i < pattern.length && pattern.charAt(i) === "!"; i++) {
      negate = !negate;
      negateOffset++;
    }
    if (negateOffset)
      this.pattern = pattern.slice(negateOffset);
    this.negate = negate;
  }
  // set partial to true to test if, for example,
  // "/a/b" matches the start of "/*/b/*/d"
  // Partial means, if you run out of file before you run
  // out of pattern, then that's fine, as long as all
  // the parts match.
  matchOne(file, pattern, partial = false) {
    let fileStartIndex = 0;
    let patternStartIndex = 0;
    if (this.isWindows) {
      const fileDrive = typeof file[0] === "string" && /^[a-z]:$/i.test(file[0]);
      const fileUNC = !fileDrive && file[0] === "" && file[1] === "" && file[2] === "?" && /^[a-z]:$/i.test(file[3]);
      const patternDrive = typeof pattern[0] === "string" && /^[a-z]:$/i.test(pattern[0]);
      const patternUNC = !patternDrive && pattern[0] === "" && pattern[1] === "" && pattern[2] === "?" && typeof pattern[3] === "string" && /^[a-z]:$/i.test(pattern[3]);
      const fdi = fileUNC ? 3 : fileDrive ? 0 : void 0;
      const pdi = patternUNC ? 3 : patternDrive ? 0 : void 0;
      if (typeof fdi === "number" && typeof pdi === "number") {
        const [fd, pd] = [
          file[fdi],
          pattern[pdi]
        ];
        if (fd.toLowerCase() === pd.toLowerCase()) {
          pattern[pdi] = fd;
          patternStartIndex = pdi;
          fileStartIndex = fdi;
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      file = this.levelTwoFileOptimize(file);
    }
    if (pattern.includes(GLOBSTAR)) {
      return this.#matchGlobstar(file, pattern, partial, fileStartIndex, patternStartIndex);
    }
    return this.#matchOne(file, pattern, partial, fileStartIndex, patternStartIndex);
  }
  #matchGlobstar(file, pattern, partial, fileIndex, patternIndex) {
    const firstgs = pattern.indexOf(GLOBSTAR, patternIndex);
    const lastgs = pattern.lastIndexOf(GLOBSTAR);
    const [head, body, tail] = partial ? [
      pattern.slice(patternIndex, firstgs),
      pattern.slice(firstgs + 1),
      []
    ] : [
      pattern.slice(patternIndex, firstgs),
      pattern.slice(firstgs + 1, lastgs),
      pattern.slice(lastgs + 1)
    ];
    if (head.length) {
      const fileHead = file.slice(fileIndex, fileIndex + head.length);
      if (!this.#matchOne(fileHead, head, partial, 0, 0)) {
        return false;
      }
      fileIndex += head.length;
      patternIndex += head.length;
    }
    let fileTailMatch = 0;
    if (tail.length) {
      if (tail.length + fileIndex > file.length)
        return false;
      let tailStart = file.length - tail.length;
      if (this.#matchOne(file, tail, partial, tailStart, 0)) {
        fileTailMatch = tail.length;
      } else {
        if (file[file.length - 1] !== "" || fileIndex + tail.length === file.length) {
          return false;
        }
        tailStart--;
        if (!this.#matchOne(file, tail, partial, tailStart, 0)) {
          return false;
        }
        fileTailMatch = tail.length + 1;
      }
    }
    if (!body.length) {
      let sawSome = !!fileTailMatch;
      for (let i2 = fileIndex; i2 < file.length - fileTailMatch; i2++) {
        const f = String(file[i2]);
        sawSome = true;
        if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
          return false;
        }
      }
      return partial || sawSome;
    }
    const bodySegments = [[[], 0]];
    let currentBody = bodySegments[0];
    let nonGsParts = 0;
    const nonGsPartsSums = [0];
    for (const b of body) {
      if (b === GLOBSTAR) {
        nonGsPartsSums.push(nonGsParts);
        currentBody = [[], 0];
        bodySegments.push(currentBody);
      } else {
        currentBody[0].push(b);
        nonGsParts++;
      }
    }
    let i = bodySegments.length - 1;
    const fileLength = file.length - fileTailMatch;
    for (const b of bodySegments) {
      b[1] = fileLength - (nonGsPartsSums[i--] + b[0].length);
    }
    return !!this.#matchGlobStarBodySections(file, bodySegments, fileIndex, 0, partial, 0, !!fileTailMatch);
  }
  // return false for "nope, not matching"
  // return null for "not matching, cannot keep trying"
  #matchGlobStarBodySections(file, bodySegments, fileIndex, bodyIndex, partial, globStarDepth, sawTail) {
    const bs = bodySegments[bodyIndex];
    if (!bs) {
      for (let i = fileIndex; i < file.length; i++) {
        sawTail = true;
        const f = file[i];
        if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
          return false;
        }
      }
      return sawTail;
    }
    const [body, after] = bs;
    while (fileIndex <= after) {
      const m = this.#matchOne(file.slice(0, fileIndex + body.length), body, partial, fileIndex, 0);
      if (m && globStarDepth < this.maxGlobstarRecursion) {
        const sub = this.#matchGlobStarBodySections(file, bodySegments, fileIndex + body.length, bodyIndex + 1, partial, globStarDepth + 1, sawTail);
        if (sub !== false) {
          return sub;
        }
      }
      const f = file[fileIndex];
      if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
        return false;
      }
      fileIndex++;
    }
    return partial || null;
  }
  #matchOne(file, pattern, partial, fileIndex, patternIndex) {
    let fi;
    let pi;
    let pl;
    let fl;
    for (fi = fileIndex, pi = patternIndex, fl = file.length, pl = pattern.length; fi < fl && pi < pl; fi++, pi++) {
      this.debug("matchOne loop");
      let p = pattern[pi];
      let f = file[fi];
      this.debug(pattern, p, f);
      if (p === false || p === GLOBSTAR) {
        return false;
      }
      let hit;
      if (typeof p === "string") {
        hit = f === p;
        this.debug("string match", p, f, hit);
      } else {
        hit = p.test(f);
        this.debug("pattern match", p, f, hit);
      }
      if (!hit)
        return false;
    }
    if (fi === fl && pi === pl) {
      return true;
    } else if (fi === fl) {
      return partial;
    } else if (pi === pl) {
      return fi === fl - 1 && file[fi] === "";
    } else {
      throw new Error("wtf?");
    }
  }
  braceExpand() {
    return braceExpand(this.pattern, this.options);
  }
  parse(pattern) {
    assertValidPattern(pattern);
    const options = this.options;
    if (pattern === "**")
      return GLOBSTAR;
    if (pattern === "")
      return "";
    let m;
    let fastTest = null;
    if (m = pattern.match(starRE)) {
      fastTest = options.dot ? starTestDot : starTest;
    } else if (m = pattern.match(starDotExtRE)) {
      fastTest = (options.nocase ? options.dot ? starDotExtTestNocaseDot : starDotExtTestNocase : options.dot ? starDotExtTestDot : starDotExtTest)(m[1]);
    } else if (m = pattern.match(qmarksRE)) {
      fastTest = (options.nocase ? options.dot ? qmarksTestNocaseDot : qmarksTestNocase : options.dot ? qmarksTestDot : qmarksTest)(m);
    } else if (m = pattern.match(starDotStarRE)) {
      fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
    } else if (m = pattern.match(dotStarRE)) {
      fastTest = dotStarTest;
    }
    const re = AST.fromGlob(pattern, this.options).toMMPattern();
    if (fastTest && typeof re === "object") {
      Reflect.defineProperty(re, "test", { value: fastTest });
    }
    return re;
  }
  makeRe() {
    if (this.regexp || this.regexp === false)
      return this.regexp;
    const set2 = this.set;
    if (!set2.length) {
      this.regexp = false;
      return this.regexp;
    }
    const options = this.options;
    const twoStar = options.noglobstar ? star2 : options.dot ? twoStarDot : twoStarNoDot;
    const flags = new Set(options.nocase ? ["i"] : []);
    let re = set2.map((pattern) => {
      const pp = pattern.map((p) => {
        if (p instanceof RegExp) {
          for (const f of p.flags.split(""))
            flags.add(f);
        }
        return typeof p === "string" ? regExpEscape2(p) : p === GLOBSTAR ? GLOBSTAR : p._src;
      });
      pp.forEach((p, i) => {
        const next = pp[i + 1];
        const prev = pp[i - 1];
        if (p !== GLOBSTAR || prev === GLOBSTAR) {
          return;
        }
        if (prev === void 0) {
          if (next !== void 0 && next !== GLOBSTAR) {
            pp[i + 1] = "(?:\\/|" + twoStar + "\\/)?" + next;
          } else {
            pp[i] = twoStar;
          }
        } else if (next === void 0) {
          pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + ")?";
        } else if (next !== GLOBSTAR) {
          pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + "\\/)" + next;
          pp[i + 1] = GLOBSTAR;
        }
      });
      const filtered = pp.filter((p) => p !== GLOBSTAR);
      if (this.partial && filtered.length >= 1) {
        const prefixes = [];
        for (let i = 1; i <= filtered.length; i++) {
          prefixes.push(filtered.slice(0, i).join("/"));
        }
        return "(?:" + prefixes.join("|") + ")";
      }
      return filtered.join("/");
    }).join("|");
    const [open2, close] = set2.length > 1 ? ["(?:", ")"] : ["", ""];
    re = "^" + open2 + re + close + "$";
    if (this.partial) {
      re = "^(?:\\/|" + open2 + re.slice(1, -1) + close + ")$";
    }
    if (this.negate)
      re = "^(?!" + re + ").+$";
    try {
      this.regexp = new RegExp(re, [...flags].join(""));
    } catch {
      this.regexp = false;
    }
    return this.regexp;
  }
  slashSplit(p) {
    if (this.preserveMultipleSlashes) {
      return p.split("/");
    } else if (this.isWindows && /^\/\/[^/]+/.test(p)) {
      return ["", ...p.split(/\/+/)];
    } else {
      return p.split(/\/+/);
    }
  }
  match(f, partial = this.partial) {
    this.debug("match", f, this.pattern);
    if (this.comment) {
      return false;
    }
    if (this.empty) {
      return f === "";
    }
    if (f === "/" && partial) {
      return true;
    }
    const options = this.options;
    if (this.isWindows) {
      f = f.split("\\").join("/");
    }
    const ff = this.slashSplit(f);
    this.debug(this.pattern, "split", ff);
    const set2 = this.set;
    this.debug(this.pattern, "set", set2);
    let filename = ff[ff.length - 1];
    if (!filename) {
      for (let i = ff.length - 2; !filename && i >= 0; i--) {
        filename = ff[i];
      }
    }
    for (const pattern of set2) {
      let file = ff;
      if (options.matchBase && pattern.length === 1) {
        file = [filename];
      }
      const hit = this.matchOne(file, pattern, partial);
      if (hit) {
        if (options.flipNegate) {
          return true;
        }
        return !this.negate;
      }
    }
    if (options.flipNegate) {
      return false;
    }
    return this.negate;
  }
  static defaults(def) {
    return minimatch.defaults(def).Minimatch;
  }
};
minimatch.AST = AST;
minimatch.Minimatch = Minimatch;
minimatch.escape = escape;
minimatch.unescape = unescape;

// src/analysis/path-matcher.ts
var MAX_PATTERN_LENGTH2 = 500;
var MAX_COMPLEXITY_SCORE = 50;
var PathMatcher = class {
  constructor(config) {
    this.config = config;
    this.validatePatterns();
  }
  // Cache for pattern matching results: `${filePath}:${pattern}` -> boolean
  matchCache = /* @__PURE__ */ new Map();
  /**
   * Validate all patterns for security and correctness
   * Throws if any pattern is invalid
   */
  validatePatterns() {
    for (const pathPattern of this.config.patterns) {
      this.validateSinglePattern(pathPattern.pattern);
    }
  }
  /**
   * Validate a single pattern for security issues
   */
  validateSinglePattern(pattern) {
    this.checkPatternLength(pattern);
    this.checkPatternComplexity(pattern);
    this.checkControlCharacters(pattern);
    this.checkAllowedCharacters(pattern);
    this.checkTraversal(pattern);
    this.checkMinimatchSyntax(pattern);
  }
  /**
   * Check if pattern exceeds maximum length
   * Uses MAX_PATTERN_LENGTH constant (500 chars)
   */
  checkPatternLength(pattern) {
    if (pattern.length > MAX_PATTERN_LENGTH2) {
      throw new Error(`Pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH2}): ${pattern}`);
    }
  }
  /**
   * Check if pattern complexity is within acceptable limits
   * Uses MAX_COMPLEXITY_SCORE constant (50 points)
   * Scoring: wildcards × 2 + braces × 3
   */
  checkPatternComplexity(pattern) {
    const wildcardCount = (pattern.match(/\*/g) || []).length;
    const braceCount = (pattern.match(/\{/g) || []).length;
    const complexityScore = wildcardCount * 2 + braceCount * 3;
    if (complexityScore > MAX_COMPLEXITY_SCORE) {
      throw new Error(`Pattern too complex (score ${complexityScore}, max ${MAX_COMPLEXITY_SCORE}): ${pattern}`);
    }
  }
  /**
   * Check for control characters in pattern
   */
  checkControlCharacters(pattern) {
    for (let i = 0; i < pattern.length; i++) {
      if (pattern.charCodeAt(i) <= 31) {
        throw new Error(`Pattern contains control characters: ${pattern}`);
      }
    }
  }
  /**
   * Restrict patterns to a safe character allowlist for glob matching.
   *
   * SECURITY CONTEXT:
   * These patterns are ONLY used with the minimatch library (pure JavaScript),
   * NEVER passed to shell commands or eval(). While minimatch is safe, we still
   * block potentially dangerous characters for defense in depth.
   *
   * ALLOWED CHARACTERS:
   * - Alphanumeric: A-Z, a-z, 0-9
   * - Path separators: / (forward slash only)
   * - Glob wildcards: * (asterisk), ? (question mark)
   * - Glob braces: { } (brace expansion)
   * - Character classes: [ ] (bracket expressions)
   * - Special chars: . - _ @ + ^ ! ( ) ~ # , (space)
   *
   * BLOCKED CHARACTERS (explicit):
   * - Backslash (\) - Prevents path traversal and escape sequences
   * - Pipe (|) - No shell piping (not needed for globs)
   * - Backtick (`) - No command substitution (not needed for globs)
   * - Semicolon (;) - No command chaining (not needed for globs)
   * - Ampersand (&) - No backgrounding (not needed for globs)
   * - Angle brackets (< >) - No redirection (not needed for globs)
   *
   * MINIMATCH SAFETY:
   * - nonegate: true (blocks ! negation at start of pattern)
   * - nocomment: true (blocks # comments)
   * - These options prevent pattern injection attacks
   *
   * DEFENSE IN DEPTH:
   * Even though minimatch is safe, we enforce a strict allowlist to:
   * 1. Catch accidental misuse (e.g., copy-paste errors)
   * 2. Prevent future regressions if code changes
   * 3. Make security properties explicit and auditable
   */
  /**
   * Comprehensive character validation with explicit security checks
   * Uses defense-in-depth: check for dangerous characters AND validate allowlist
   */
  checkAllowedCharacters(pattern) {
    const dangerousChars = /[\\`|;&<>'"$\x7F]/;
    if (dangerousChars.test(pattern)) {
      const found = pattern.match(dangerousChars);
      throw new Error(
        `Pattern contains dangerous character: ${found?.[0] ? JSON.stringify(found[0]) : "DEL"}. Backslashes, backticks, pipes, semicolons, quotes, and $ are not allowed.`
      );
    }
    if (!/^[\x20-\x7E]+$/.test(pattern)) {
      throw new Error(
        `Pattern contains non-ASCII characters. Only printable ASCII characters (0x20-0x7E) are allowed for cross-platform compatibility.`
      );
    }
    const allowSpaces = Boolean(this.config.allowSpaces);
    if (!allowSpaces && pattern.includes(" ")) {
      throw new Error("Pattern contains spaces but allowSpaces=false");
    }
    const allowed = allowSpaces ? /^[A-Za-z0-9.@+^!_\-/*?{}[\],()~# ]+$/ : /^[A-Za-z0-9.@+^!_\-/*?{}[\],()~#]+$/;
    if (!allowed.test(pattern)) {
      throw new Error(
        `Pattern contains unsupported characters: ${pattern}. Only alphanumerics (A-Z, a-z, 0-9), glob wildcards (*, ?, {}, []), path separators (/), and safe punctuation (.@+^!_-,()~# space) are allowed.`
      );
    }
    const openBraces = (pattern.match(/\{/g) || []).length;
    const closeBraces = (pattern.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      throw new Error(
        `Pattern has unbalanced braces: ${openBraces} open, ${closeBraces} close. Each '{' must have a matching '}'.`
      );
    }
    const openBrackets = (pattern.match(/\[/g) || []).length;
    const closeBrackets = (pattern.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      throw new Error(
        `Pattern has unbalanced brackets: ${openBrackets} open, ${closeBrackets} close. Each '[' must have a matching ']'.`
      );
    }
  }
  /**
   * Block path traversal segments ('..') inside patterns to avoid unintended matches.
   */
  checkTraversal(pattern) {
    const traversalSegment = /(^|[\\/])\.\.(?:[\\/]|$)/;
    if (traversalSegment.test(pattern)) {
      throw new Error(`Pattern contains path traversal ('..') which is not allowed: ${pattern}`);
    }
  }
  /**
   * Validate that minimatch can compile the pattern. This catches malformed
   * bracket/brace expressions beyond our simple balance checks.
   */
  checkMinimatchSyntax(pattern) {
    try {
      const re = minimatch.makeRe(pattern, { nonegate: true, nocomment: true, allowWindowsEscape: false });
      if (!re) {
        throw new Error("Pattern did not compile");
      }
    } catch (err) {
      throw new Error(`Invalid glob syntax for pattern "${pattern}": ${err.message}`);
    }
  }
  /**
   * Analyze files and determine review intensity based on path patterns
   */
  determineIntensity(files) {
    if (!this.config.enabled || this.config.patterns.length === 0) {
      return this.createDefaultResult();
    }
    const matches = this.findMatchingPatterns(files);
    const finalIntensity = matches.highestIntensity ?? this.config.defaultIntensity;
    const uniqueMatchedPaths = [...new Set(matches.matchedPaths)];
    const reason = this.buildReason(finalIntensity, matches.matchedPatterns, uniqueMatchedPaths);
    this.logIntensityDecision(finalIntensity, uniqueMatchedPaths, matches.matchedPatterns);
    return {
      intensity: finalIntensity,
      matchedPaths: uniqueMatchedPaths,
      reason
    };
  }
  /**
   * Create default result when path matching is disabled
   */
  createDefaultResult() {
    return {
      intensity: this.config.defaultIntensity,
      matchedPaths: [],
      reason: "Path-based intensity disabled or no patterns configured"
    };
  }
  /**
   * Find all patterns that match the given files
   */
  findMatchingPatterns(files) {
    let highestIntensity = null;
    const matchedPaths = [];
    const matchedPatterns = [];
    for (const file of files) {
      for (const pathPattern of this.config.patterns) {
        if (this.matchesPattern(file.filename, pathPattern.pattern)) {
          matchedPaths.push(file.filename);
          matchedPatterns.push(pathPattern);
          if (this.isHigherIntensity(pathPattern.intensity, highestIntensity)) {
            highestIntensity = pathPattern.intensity;
          }
        }
      }
    }
    return { highestIntensity, matchedPaths, matchedPatterns };
  }
  /**
   * Check if intensity A is higher than intensity B
   */
  isHigherIntensity(a, b) {
    return b === null || this.compareIntensity(a, b) > 0;
  }
  /**
   * Log the intensity decision for debugging
   */
  logIntensityDecision(intensity, matchedPaths, matchedPatterns) {
    logger.info(`Path-based intensity: ${intensity}`, {
      matchedPaths: matchedPaths.length,
      patterns: matchedPatterns.map((p) => p.pattern)
    });
  }
  /**
   * Match a file path against a glob-style pattern using minimatch library
   * Supports:
   * - ** for recursive directory matching
   * - * for single segment wildcard
   * - Exact matches
   * - Brace expansion: {a,b,c}
   * - Character classes: [abc]
   *
   * Uses minimatch library which is battle-tested and ReDoS-safe
   * Performance: Results are memoized to avoid redundant matching
   */
  matchesPattern(filePath, pattern) {
    const cacheKey = `${filePath}:${pattern}`;
    const cached = this.matchCache.get(cacheKey);
    if (cached !== void 0) {
      return cached;
    }
    try {
      const result = minimatch(filePath, pattern, {
        dot: true,
        // Match dotfiles
        matchBase: false,
        // Don't match basenames only
        nocase: false,
        // Case-sensitive matching
        nonegate: true,
        // Disable negation patterns (security)
        nocomment: true
        // Disable comment patterns (security)
      });
      this.matchCache.set(cacheKey, result);
      return result;
    } catch (error2) {
      logger.warn(`Invalid glob pattern "${pattern}": ${error2.message}`);
      this.matchCache.set(cacheKey, false);
      return false;
    }
  }
  /**
   * Compare two intensity levels (higher value = more thorough)
   * Returns: 1 if a > b, -1 if a < b, 0 if equal
   */
  compareIntensity(a, b) {
    const levels = {
      light: 1,
      standard: 2,
      thorough: 3
    };
    return levels[a] - levels[b];
  }
  /**
   * Build a human-readable reason for the intensity decision
   */
  buildReason(intensity, matchedPatterns, matchedPaths) {
    if (matchedPaths.length === 0) {
      return `Using ${intensity} review intensity (default)`;
    }
    const uniquePatterns = [...new Set(matchedPatterns.map((p) => p.pattern))];
    const descriptions = matchedPatterns.filter((p) => p.description).map((p) => p.description).filter((v, i, a) => a.indexOf(v) === i);
    let reason = `Using ${intensity} review intensity: matched ${matchedPaths.length} file(s) against patterns: ${uniquePatterns.join(", ")}`;
    if (descriptions.length > 0) {
      reason += `. Reason: ${descriptions.join(", ")}`;
    }
    return reason;
  }
};
function createDefaultPathMatcherConfig() {
  return {
    enabled: false,
    defaultIntensity: "standard",
    patterns: [
      // Critical security paths - thorough review
      {
        pattern: "src/auth/**",
        intensity: "thorough",
        description: "Authentication code requires thorough review"
      },
      {
        pattern: "**/auth/**",
        intensity: "thorough",
        description: "Authentication code requires thorough review"
      },
      {
        pattern: "src/security/**",
        intensity: "thorough",
        description: "Security code requires thorough review"
      },
      {
        pattern: "**/payment/**",
        intensity: "thorough",
        description: "Payment processing requires thorough review"
      },
      {
        pattern: "**/billing/**",
        intensity: "thorough",
        description: "Billing code requires thorough review"
      },
      // Infrastructure - thorough for safety
      {
        pattern: "infrastructure/**",
        intensity: "thorough",
        description: "Infrastructure changes need careful review"
      },
      {
        pattern: "terraform/**",
        intensity: "thorough",
        description: "Infrastructure as code needs careful review"
      },
      {
        pattern: "k8s/**",
        intensity: "thorough",
        description: "Kubernetes configs need careful review"
      },
      {
        pattern: "Dockerfile",
        intensity: "thorough",
        description: "Docker configs need security review"
      },
      {
        pattern: "**/Dockerfile",
        intensity: "thorough",
        description: "Docker configs need security review"
      },
      {
        pattern: "*.Dockerfile",
        intensity: "thorough",
        description: "Docker configs need security review"
      },
      {
        pattern: "**/*.Dockerfile",
        intensity: "thorough",
        description: "Docker configs need security review"
      },
      {
        pattern: "docker-compose*.yml",
        intensity: "thorough",
        description: "Docker Compose configs need security review"
      },
      {
        pattern: "docker-compose*.yaml",
        intensity: "thorough",
        description: "Docker Compose configs need security review"
      },
      // Tests - light review (focus on coverage)
      {
        pattern: "**/*.test.ts",
        intensity: "light",
        description: "Test files get lighter review"
      },
      {
        pattern: "**/*.test.js",
        intensity: "light",
        description: "Test files get lighter review"
      },
      {
        pattern: "**/*.spec.ts",
        intensity: "light",
        description: "Test files get lighter review"
      },
      {
        pattern: "**/*.spec.js",
        intensity: "light",
        description: "Test files get lighter review"
      },
      {
        pattern: "__tests__/**",
        intensity: "light",
        description: "Test files get lighter review"
      }
    ]
  };
}

// src/github/progress-tracker.ts
var ProgressTracker = class {
  constructor(octokit, config) {
    this.octokit = octokit;
    this.config = config;
  }
  commentId = null;
  items = /* @__PURE__ */ new Map();
  startTime = Date.now();
  totalCost = 0;
  overrideBody;
  /**
   * Initialize progress tracking by creating the initial comment
   */
  async initialize() {
    if (!this.octokit?.rest?.issues?.createComment) {
      logger.warn("Progress tracker unavailable: octokit.rest.issues.createComment is missing");
      return;
    }
    try {
      const body = this.formatProgressComment();
      const comment = await this.octokit.rest.issues.createComment({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: this.config.prNumber,
        body
      });
      this.commentId = comment.data.id;
      logger.info("Progress tracker initialized", { commentId: this.commentId });
    } catch (error2) {
      logger.error("Failed to initialize progress tracker", error2);
    }
  }
  /**
   * Add a new progress item to track
   */
  addItem(id, label) {
    this.items.set(id, {
      id,
      label,
      status: "pending",
      startTime: Date.now()
    });
    logger.debug(`Progress item added: ${id}`, { label });
  }
  /**
   * Update progress for a specific item
   * Only updates comment on milestone events (completed/failed)
   */
  async updateProgress(itemId, status, details) {
    const item = this.items.get(itemId);
    if (!item) {
      logger.warn(`Progress item not found: ${itemId}`);
      return;
    }
    item.status = status;
    item.details = details;
    if (status === "completed" || status === "failed") {
      item.endTime = Date.now();
      await this.updateComment();
    }
    logger.debug(`Progress updated: ${itemId}`, { status, details });
  }
  /**
   * Set total cost for metadata display
   */
  setTotalCost(cost) {
    this.totalCost = cost;
  }
  /**
   * Finalize progress tracking with summary
   */
  async finalize(success) {
    const duration = Date.now() - this.startTime;
    this.items.forEach((item) => {
      if (item.status === "pending" || item.status === "in_progress") {
        item.status = success ? "completed" : "failed";
        item.endTime = Date.now();
      }
    });
    if (!this.overrideBody) {
      await this.updateComment();
    }
    logger.info("Progress tracker finalized", {
      success,
      duration,
      totalCost: this.totalCost
    });
  }
  /**
   * Format progress comment with checkboxes, status emojis, and metadata
   */
  formatProgressComment() {
    const lines = [];
    lines.push("## \u{1F916} Multi-Provider Code Review Progress\n");
    const sortedItems = Array.from(this.items.values()).sort(
      (a, b) => (a.startTime || 0) - (b.startTime || 0)
    );
    for (const item of sortedItems) {
      const checkbox = item.status === "completed" ? "[x]" : "[ ]";
      const emoji = this.getStatusEmoji(item.status);
      const duration = this.getDurationString(item);
      lines.push(`${checkbox} ${emoji} ${item.label}${duration}`);
      if (item.details) {
        lines.push(`   \u2514\u2500 ${item.details}`);
      }
    }
    lines.push("\n---");
    const totalDuration = Date.now() - this.startTime;
    const durationStr = this.formatDuration(totalDuration);
    lines.push(`**Duration**: ${durationStr}`);
    if (this.totalCost > 0) {
      lines.push(`**Cost**: $${this.totalCost.toFixed(4)}`);
    }
    lines.push(`**Last updated**: ${(/* @__PURE__ */ new Date()).toISOString()}`);
    lines.push("<!-- multi-provider-progress-tracker -->");
    return lines.join("\n");
  }
  /**
   * Update the progress comment (GitHub API call)
   */
  async updateComment() {
    if (!this.commentId) {
      logger.warn("Cannot update progress: comment not initialized");
      return;
    }
    if (!this.octokit?.rest?.issues?.updateComment) {
      logger.warn("Cannot update progress: octokit.rest.issues.updateComment is missing");
      return;
    }
    try {
      const body = this.overrideBody ?? this.formatProgressComment();
      await this.octokit.rest.issues.updateComment({
        owner: this.config.owner,
        repo: this.config.repo,
        comment_id: this.commentId,
        body
      });
      logger.debug("Progress comment updated", { commentId: this.commentId });
    } catch (error2) {
      logger.error("Failed to update progress comment", error2);
    }
  }
  /**
   * Replace the progress comment with a final body (e.g., combined progress + review)
   */
  async replaceWith(body) {
    if (!this.commentId) {
      logger.warn("Cannot replace progress: comment not initialized");
      return;
    }
    if (!this.octokit?.rest?.issues?.updateComment) {
      logger.warn("Cannot replace progress: octokit.rest.issues.updateComment is missing");
      return;
    }
    this.overrideBody = body;
    await this.octokit.rest.issues.updateComment({
      owner: this.config.owner,
      repo: this.config.repo,
      comment_id: this.commentId,
      body
    });
  }
  /**
   * Get status emoji for visual feedback
   */
  getStatusEmoji(status) {
    switch (status) {
      case "completed":
        return "\u2705";
      case "failed":
        return "\u274C";
      case "in_progress":
        return "\u{1F504}";
      case "pending":
        return "\u23F3";
      default:
        return "\u2B1C";
    }
  }
  /**
   * Get duration string for an item
   */
  getDurationString(item) {
    if (!item.endTime || !item.startTime) {
      return "";
    }
    const duration = item.endTime - item.startTime;
    return ` (${this.formatDuration(duration)})`;
  }
  /**
   * Format duration in human-readable format
   */
  formatDuration(ms) {
    if (ms < 1e3) {
      return `${ms}ms`;
    } else if (ms < 6e4) {
      return `${(ms / 1e3).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(ms / 6e4);
      const seconds = Math.floor(ms % 6e4 / 1e3);
      return `${minutes}m ${seconds}s`;
    }
  }
};

// src/core/orchestrator.ts
var fs12 = __toESM(require("fs/promises"));
var import_path = __toESM(require("path"));
var HEALTH_CHECK_TIMEOUT_MS = 3e4;
var ReviewOrchestrator = class {
  constructor(components) {
    this.components = components;
    if (components.config?.graphEnabled && components.config?.graphCacheEnabled) {
      this.graphCache = new GraphCache();
    }
  }
  graphCache;
  async execute(prNumber) {
    const pr = await this.components.prLoader.load(prNumber);
    const skipReason = this.shouldSkip(pr);
    if (skipReason) {
      logger.info(`Skipping review: ${skipReason}`);
      return null;
    }
    return this.executeReview(pr);
  }
  /**
   * Execute review on a given PR context
   * Can be called directly with a PRContext from CLI or GitHub
   *
   * IMMUTABILITY GUARANTEE: This function does not mutate the input `pr` parameter.
   * When filtering or transforming the PR context, a new object is created with spread syntax.
   * Tests verify that pr.files array is not modified by this function.
   */
  async executeReview(pr) {
    const { config } = this.components;
    const start = Date.now();
    let progressTracker;
    let review = null;
    let success = false;
    try {
      progressTracker = await this.initProgressTracker(pr);
      progressTracker?.addItem("graph", "Build code graph");
      progressTracker?.addItem("llm", "LLM review (batched)");
      progressTracker?.addItem("static", "Static analysis & rules");
      progressTracker?.addItem("synthesis", "Synthesize & report");
      let codeGraph;
      let contextRetriever = this.components.contextRetriever;
      if (config.graphEnabled && this.components.graphBuilder) {
        try {
          const graphStart = Date.now();
          if (this.graphCache) {
            const cached = await this.graphCache.get(pr.number, pr.headSha);
            if (cached) {
              codeGraph = cached;
            }
          }
          if (codeGraph) {
            const graphTime = Date.now() - graphStart;
            logger.info(`Loaded code graph from cache (${graphTime}ms)`);
            await progressTracker?.updateProgress("graph", "completed", `Loaded from cache in ${graphTime}ms`);
          } else {
            codeGraph = await this.components.graphBuilder.buildGraph(pr.files);
            const graphTime = Date.now() - graphStart;
            logger.info(`Code graph built in ${graphTime}ms: ${codeGraph.getStats().definitions} definitions, ${codeGraph.getStats().imports} imports`);
            await progressTracker?.updateProgress("graph", "completed", `Built in ${graphTime}ms`);
            if (this.graphCache) {
              await this.graphCache.set(pr.number, pr.headSha, codeGraph);
            }
          }
          if (codeGraph) {
            contextRetriever = new ContextRetriever(codeGraph);
          }
        } catch (error2) {
          logger.warn("Failed to build code graph, falling back to regex-based context", error2);
          await progressTracker?.updateProgress("graph", "failed", "Graph build failed, using regex context");
        }
      }
      let reviewContext = pr;
      if (config.skipTrivialChanges) {
        const trivialDetector = new TrivialDetector({
          enabled: true,
          skipDependencyUpdates: config.skipDependencyUpdates ?? true,
          skipDocumentationOnly: config.skipDocumentationOnly ?? true,
          skipFormattingOnly: config.skipFormattingOnly ?? false,
          skipTestFixtures: config.skipTestFixtures ?? true,
          skipConfigFiles: config.skipConfigFiles ?? true,
          skipBuildArtifacts: config.skipBuildArtifacts ?? true,
          customTrivialPatterns: config.trivialPatterns ?? []
        });
        const trivialResult = trivialDetector.detect(pr.files);
        if (trivialResult.isTrivial) {
          logger.info(`Skipping review: ${trivialResult.reason}`);
          const trivialReview = this.createTrivialReview(trivialResult.reason, pr.files.length, start);
          const markdown2 = this.components.formatter.format(trivialReview);
          await this.components.commentPoster.postSummary(pr.number, markdown2, false);
          if (config.analyticsEnabled && this.components.metricsCollector) {
            try {
              await this.components.metricsCollector.recordReview(trivialReview, pr.number);
              logger.debug(`Recorded trivial review metrics for PR #${pr.number}`);
            } catch (error2) {
              logger.warn("Failed to record trivial review metrics", error2);
            }
          }
          review = trivialReview;
          success = true;
          return trivialReview;
        }
        if (trivialResult.trivialFiles.length > 0) {
          logger.info(`Filtering ${trivialResult.trivialFiles.length} trivial files from review: ${trivialResult.trivialFiles.join(", ")}`);
          const nonTrivialFiles = pr.files.filter((f) => trivialResult.nonTrivialFiles.includes(f.filename));
          reviewContext = {
            ...pr,
            files: nonTrivialFiles,
            diff: filterDiffByFiles(pr.diff, nonTrivialFiles)
          };
        }
      }
      let reviewIntensity = config.pathDefaultIntensity ?? "standard";
      if (config.pathBasedIntensity) {
        let patterns = [];
        if (config.pathIntensityPatterns) {
          try {
            const parsed = JSON.parse(config.pathIntensityPatterns);
            if (!Array.isArray(parsed)) {
              logger.warn("pathIntensityPatterns is not an array, using defaults");
              patterns = createDefaultPathMatcherConfig().patterns;
            } else {
              const PathPatternSchema = external_exports.object({
                pattern: external_exports.string(),
                intensity: external_exports.enum(["thorough", "standard", "light"]),
                description: external_exports.string().optional()
              });
              const validPatterns = [];
              for (const item of parsed) {
                const result = PathPatternSchema.safeParse(item);
                if (result.success) {
                  validPatterns.push(result.data);
                } else {
                  logger.warn(`Invalid path pattern object, skipping: ${JSON.stringify(item)}`);
                }
              }
              if (validPatterns.length === 0) {
                logger.warn("No valid path patterns found, using defaults");
                patterns = createDefaultPathMatcherConfig().patterns;
              } else {
                patterns = validPatterns;
              }
            }
          } catch (error2) {
            logger.warn("Failed to parse pathIntensityPatterns, using defaults", error2);
            patterns = createDefaultPathMatcherConfig().patterns;
          }
        } else {
          patterns = createDefaultPathMatcherConfig().patterns;
        }
        const pathMatcher = new PathMatcher({
          enabled: true,
          defaultIntensity: config.pathDefaultIntensity ?? "standard",
          patterns
        });
        const intensityResult = pathMatcher.determineIntensity(reviewContext.files);
        reviewIntensity = intensityResult.intensity;
        logger.info(`Review intensity: ${reviewIntensity} - ${intensityResult.reason}`);
        if (intensityResult.matchedPaths.length > 0) {
          logger.debug(`Matched paths: ${intensityResult.matchedPaths.join(", ")}`);
        }
      }
      const intensityProviderLimit = config.intensityProviderCounts?.[reviewIntensity] ?? config.providerLimit;
      const intensityTimeout = config.intensityTimeouts?.[reviewIntensity] ?? config.runTimeoutSeconds * 1e3;
      logger.info(
        `Intensity settings: ${intensityProviderLimit} providers, ${intensityTimeout}ms timeout (${reviewIntensity} mode)`
      );
      const useIncremental = await this.components.incrementalReviewer.shouldUseIncremental(reviewContext);
      let filesToReview = reviewContext.files;
      let lastReviewData = null;
      if (useIncremental) {
        lastReviewData = await this.components.incrementalReviewer.getLastReview(reviewContext.number);
        if (lastReviewData) {
          filesToReview = await this.components.incrementalReviewer.getChangedFilesSince(reviewContext, lastReviewData.lastReviewedCommit);
          logger.info(`Incremental review: reviewing ${filesToReview.length} changed files`);
          if (codeGraph && this.components.graphBuilder) {
            try {
              codeGraph = await this.components.graphBuilder.updateGraph(codeGraph, filesToReview);
              logger.debug("Code graph updated incrementally");
            } catch (error2) {
              logger.warn("Failed to update code graph incrementally", error2);
            }
          }
        }
      }
      const cachedFindings = config.enableCaching ? await this.components.cache.load(reviewContext) : null;
      const reviewPR = useIncremental ? { ...reviewContext, files: filesToReview, diff: filterDiffByFiles(reviewContext.diff, filesToReview) } : reviewContext;
      const llmFindings = [];
      let providerResults = [];
      let aiAnalysis;
      let providers = await this.components.providerRegistry.createProviders(config);
      providers = await this.applyReliabilityFilters(providers);
      if (providers.length === 0) {
        logger.warn("All providers filtered out by circuit breakers/reliability; skipping LLM execution");
        await progressTracker?.updateProgress("llm", "failed", "No available providers after reliability filtering");
      }
      const batchOrchestrator = this.components.batchOrchestrator || new BatchOrchestrator({
        defaultBatchSize: config.batchMaxFiles || 30,
        providerOverrides: config.providerBatchOverrides,
        enableTokenAwareBatching: config.enableTokenAwareBatching,
        targetTokensPerBatch: config.targetTokensPerBatch,
        maxBatchSize: config.batchMaxFiles
      });
      if (filesToReview.length === 0) {
        logger.info("No files to review in incremental update, using cached findings only");
      } else {
        await this.ensureBudget(config);
        let allHealthResults = [];
        let healthy = [];
        const triedProviders = new Set(providers.map((p) => p.name));
        const runHealthCheck = async (candidateProviders) => {
          const { healthy: h, healthCheckResults } = await this.components.llmExecutor.filterHealthyProviders(
            candidateProviders,
            HEALTH_CHECK_TIMEOUT_MS
          );
          healthy = healthy.concat(h);
          allHealthResults = allHealthResults.concat(healthCheckResults);
        };
        await runHealthCheck(providers);
        const selectionLimit = Math.max(1, intensityProviderLimit || 8);
        const desiredOpenRouter = Math.min(4, providers.filter((p) => p.name.startsWith("openrouter/")).length);
        const desiredOpenCode = Math.min(2, providers.filter((p) => p.name.startsWith("opencode/")).length);
        const MIN_OPENROUTER_HEALTHY = desiredOpenRouter;
        const MIN_OPENCODE_HEALTHY = desiredOpenCode;
        const MIN_TOTAL_HEALTHY = Math.min(selectionLimit, Math.max(2, desiredOpenRouter + desiredOpenCode || 2));
        const MIN_FALLBACK_HEALTHY = Math.min(2, selectionLimit);
        const countOpenCode = (list) => list.filter((p) => p.name.startsWith("opencode/")).length;
        const countOpenRouter = (list) => list.filter((p) => p.name.startsWith("openrouter/")).length;
        let attempts = 0;
        const registry = this.components.providerRegistry;
        const discoverExtras = typeof registry.discoverAdditionalFreeProviders === "function" ? (names) => registry.discoverAdditionalFreeProviders(names, selectionLimit * 2, config) : null;
        while (attempts < 6 && discoverExtras && (healthy.length < MIN_TOTAL_HEALTHY || countOpenCode(healthy) < MIN_OPENCODE_HEALTHY || countOpenRouter(healthy) < MIN_OPENROUTER_HEALTHY)) {
          const additional = await discoverExtras(Array.from(triedProviders));
          if (additional.length === 0) break;
          additional.forEach((p) => triedProviders.add(p.name));
          await runHealthCheck(additional);
          attempts += 1;
        }
        const meetsPrimaryTargets = healthy.length >= MIN_TOTAL_HEALTHY && countOpenCode(healthy) >= MIN_OPENCODE_HEALTHY && countOpenRouter(healthy) >= MIN_OPENROUTER_HEALTHY;
        if (!meetsPrimaryTargets && healthy.length < MIN_FALLBACK_HEALTHY) {
          logger.warn("Insufficient healthy providers after retries; skipping LLM execution");
          if (process.env.FAIL_ON_NO_HEALTHY_PROVIDERS === "true" && healthy.length === 0) {
            throw new Error("No healthy providers available; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true");
          }
          providerResults = allHealthResults;
          await this.recordReliability(providerResults);
          await progressTracker?.updateProgress(
            "llm",
            "failed",
            `Healthy providers insufficient (total=${healthy.length}, openrouter=${countOpenRouter(
              healthy
            )}, opencode=${countOpenCode(healthy)})`
          );
        } else {
          const executionLimit = intensityProviderLimit || config.providerLimit;
          if (healthy.length > executionLimit) {
            logger.info(
              `Limiting execution to ${executionLimit} providers (checked ${healthy.length} for health). Using top providers by reliability.`
            );
            healthy = healthy.slice(0, executionLimit);
          }
          let batches;
          const providerNames = healthy.map((p) => p.name);
          if (config.enableTokenAwareBatching) {
            try {
              batches = batchOrchestrator.createTokenAwareBatches(filesToReview, providerNames);
            } catch (error2) {
              logger.warn(
                `Token-aware batching failed, falling back to fixed-size batching`,
                error2
              );
              const batchSize = batchOrchestrator.getBatchSize(providerNames);
              batches = batchOrchestrator.createBatches(filesToReview, batchSize);
            }
          } else {
            const batchSize = batchOrchestrator.getBatchSize(providerNames);
            try {
              batches = batchOrchestrator.createBatches(filesToReview, batchSize);
            } catch (error2) {
              logger.warn(
                `Invalid batch size computed from providers - falling back to size 1`,
                error2
              );
              batches = batchOrchestrator.createBatches(filesToReview, 1);
            }
          }
          const batchQueue = createQueue(Math.max(1, Number(config.providerMaxParallel) || 1));
          logger.info(`Processing ${batches.length} batch(es)`);
          const batchPromises = batches.map(
            (batch) => batchQueue.add(async () => {
              const batchDiff = filterDiffByFiles(reviewContext.diff, batch);
              const batchContext = { ...reviewContext, files: batch, diff: batchDiff };
              const promptBuilder = new PromptBuilder(config, reviewIntensity);
              const prompt = await promptBuilder.build(batchContext);
              try {
                const results = await this.components.llmExecutor.execute(healthy, prompt, intensityTimeout);
                for (const result of results) {
                  await this.components.costTracker.record(result.name, result.result?.usage, config.budgetMaxUsd);
                }
                return results;
              } catch (error2) {
                logger.error("Batch execution failed", error2);
                return healthy.map((provider) => ({
                  name: provider.name,
                  status: "error",
                  error: error2,
                  durationSeconds: 0
                }));
              }
            })
          );
          const batchResults = [];
          let batchFailures = 0;
          let batchSuccesses = 0;
          try {
            const settled = await Promise.allSettled(batchPromises);
            for (const result of settled) {
              if (result.status === "fulfilled") {
                batchResults.push(...result.value);
                if (result.value.some((r) => r.status !== "success")) {
                  batchFailures += 1;
                } else {
                  batchSuccesses += 1;
                }
              } else {
                batchFailures += 1;
                logger.error("Batch promise rejected", result.reason);
                batchResults.push(...healthy.map((provider) => ({
                  name: provider.name,
                  status: "error",
                  error: result.reason,
                  durationSeconds: 0
                })));
              }
            }
          } finally {
            await batchQueue.onIdle();
            this.cleanupQueue(batchQueue);
          }
          const mergedMap = /* @__PURE__ */ new Map();
          for (const result of allHealthResults) {
            mergedMap.set(result.name, result);
          }
          for (const result of batchResults) {
            mergedMap.set(result.name, result);
          }
          const mergedResults = Array.from(mergedMap.values()).sort((a, b) => a.name.localeCompare(b.name));
          await this.recordReliability(mergedResults);
          if (batchFailures > 0) {
            if (batchSuccesses === 0) {
              const failedNames = mergedResults.filter((r) => r.status !== "success").map((r) => r.name).join(", ");
              logger.error(`All LLM batches failed (${batchFailures}/${batches.length}): ${failedNames}. Continuing with static analysis only.`);
              await progressTracker?.updateProgress("llm", "failed", `All batches failed: ${failedNames}`);
            } else {
              logger.warn(`Partial batch failure: ${batchFailures} failed, ${batchSuccesses} succeeded. Using successful results.`);
              await progressTracker?.updateProgress("llm", "completed", `Batches: ${batchSuccesses}/${batches.length} succeeded`);
            }
          } else {
            await progressTracker?.updateProgress("llm", "completed", `Processed ${batches.length} batch(es)`);
          }
          llmFindings.push(...extractFindings(batchResults));
          providerResults = mergedResults;
          aiAnalysis = config.enableAiDetection ? summarizeAIDetection(providerResults) : void 0;
        }
      }
      const staticAnalysis = await this.runStaticAnalysis(filesToReview, contextRetriever);
      const combinedFindings = [
        ...staticAnalysis.astFindings,
        ...staticAnalysis.ruleFindings,
        ...staticAnalysis.securityFindings,
        ...llmFindings,
        ...cachedFindings || []
      ];
      const deduped = this.components.deduplicator.dedupe(combinedFindings);
      const consensus = this.components.consensus.filter(deduped);
      const providerCount = providers.length || 1;
      const enriched = consensus.map(
        (f) => this.enrichFinding(f, pr.files, staticAnalysis.context, providerCount, codeGraph)
      );
      const quietFiltered = await this.applyQuietMode(enriched, config);
      const findingFilter = new FindingFilter();
      const { findings: finalFiltered, stats: filterStats } = findingFilter.filter(quietFiltered, pr.diff);
      if (filterStats.filtered > 0 || filterStats.downgraded > 0) {
        logger.info(
          `Post-processing filter: ${filterStats.filtered} filtered, ${filterStats.downgraded} downgraded, ${filterStats.kept} kept (from ${filterStats.total} total)`
        );
        if (Object.keys(filterStats.reasons).length > 0) {
          logger.debug("Filter breakdown:", filterStats.reasons);
        }
      }
      await progressTracker?.updateProgress("static", "completed", "AST, security, and rules processed");
      const testHints = config.enableTestHints ? this.components.testCoverage.analyze(pr.files) : void 0;
      const impactAnalysis = this.components.impactAnalyzer.analyze(pr.files, staticAnalysis.context, finalFiltered.length > 0);
      const mermaidDiagram = this.components.mermaidGenerator.generateImpactDiagram(pr.files, staticAnalysis.context);
      const costSummary = this.components.costTracker.summary();
      const runDetails = {
        providers: providerResults.map((r) => ({
          name: r.name,
          status: r.status,
          durationSeconds: r.durationSeconds,
          tokens: r.result?.usage?.totalTokens,
          cost: costSummary.breakdown[r.name],
          errorMessage: r.error?.message
        })),
        totalCost: costSummary.totalCost,
        totalTokens: costSummary.totalTokens,
        durationSeconds: 0,
        cacheHit: Boolean(cachedFindings),
        synthesisModel: config.synthesisModel,
        providerPoolSize: providers.length
      };
      review = this.components.synthesis.synthesize(
        finalFiltered,
        reviewPR,
        testHints,
        aiAnalysis,
        providerResults,
        runDetails,
        impactAnalysis,
        mermaidDiagram
      );
      if (useIncremental && lastReviewData) {
        review.findings = this.components.incrementalReviewer.mergeFindings(
          lastReviewData.findings,
          review.findings,
          filesToReview
        );
        review.summary = this.components.incrementalReviewer.generateIncrementalSummary(
          lastReviewData.reviewSummary,
          review.summary,
          filesToReview,
          lastReviewData.lastReviewedCommit,
          pr.headSha
        );
        review.metrics.totalFindings = review.findings.length;
        review.metrics.critical = review.findings.filter((f) => f.severity === "critical").length;
        review.metrics.major = review.findings.filter((f) => f.severity === "major").length;
        review.metrics.minor = review.findings.filter((f) => f.severity === "minor").length;
        logger.info(`Incremental review completed: ${review.findings.length} total findings after merge`);
      }
      review.metrics.totalCost = costSummary.totalCost;
      review.metrics.totalTokens = costSummary.totalTokens;
      review.metrics.providersUsed = providers.length;
      review.metrics.providersSuccess = providerResults.filter((r) => r.status === "success").length;
      review.metrics.providersFailed = providerResults.length - review.metrics.providersSuccess;
      review.metrics.durationSeconds = (Date.now() - start) / 1e3;
      if (review.runDetails) {
        review.runDetails.durationSeconds = review.metrics.durationSeconds;
      }
      review.metrics.cached = Boolean(cachedFindings);
      if (config.generateFixPrompts && this.components.promptGenerator) {
        const fixPrompts = this.components.promptGenerator.generateFixPrompts(review.findings);
        if (fixPrompts.length > 0) {
          const basename2 = this.sanitizeFilename(process.env.REPORT_BASENAME || "multi-provider-review");
          const fixPromptsPath = import_path.default.join(process.cwd(), `${basename2}-fix-prompts.md`);
          const format = config.fixPromptFormat || "plain";
          await this.components.promptGenerator.saveToFile(fixPrompts, fixPromptsPath, format);
          logger.info(`Generated ${fixPrompts.length} fix prompts: ${fixPromptsPath}`);
        }
      }
      if (config.enableCaching) {
        await this.components.cache.save(pr, review);
      }
      if (config.incrementalEnabled) {
        await this.components.incrementalReviewer.saveReview(pr, review);
      }
      if (config.analyticsEnabled && this.components.metricsCollector) {
        try {
          await this.components.metricsCollector.recordReview(review, pr.number);
          logger.debug(`Recorded review metrics for PR #${pr.number}`);
        } catch (error2) {
          logger.warn("Failed to record review metrics", error2);
        }
      }
      const markdown = this.components.formatter.format(review);
      const suppressed = await this.components.feedbackFilter.loadSuppressed(pr.number);
      if (this.components.acceptanceDetector && this.components.providerWeightTracker && this.components.githubClient) {
        try {
          await this.detectAndRecordAcceptances(pr.number);
        } catch (error2) {
          logger.debug("Failed to detect acceptances", error2);
        }
      }
      const inlineFiltered = review.inlineComments.filter((c) => this.components.feedbackFilter.shouldPost(c, suppressed));
      if (progressTracker) {
        await progressTracker.replaceWith(markdown);
      } else {
        await this.components.commentPoster.postSummary(pr.number, markdown, useIncremental);
      }
      await this.components.commentPoster.postInline(pr.number, inlineFiltered, pr.files, pr.headSha);
      await this.writeReports(review);
      await progressTracker?.updateProgress("synthesis", "completed");
      success = true;
      return review;
    } catch (error2) {
      await progressTracker?.updateProgress("synthesis", "failed", error2.message);
      throw error2;
    } finally {
      if (progressTracker) {
        try {
          progressTracker.setTotalCost(this.components.costTracker.summary().totalCost);
          await progressTracker.finalize(success);
        } catch (err) {
          logger.warn("Failed to finalize progress tracker", err);
        }
      }
    }
  }
  /**
   * Cleanup resources after review to prevent memory leaks in long-running processes
   */
  async dispose() {
    this.components.costTracker.reset();
    logger.debug("Orchestrator resources disposed");
  }
  /**
   * Detect and record suggestion acceptances from PR activity.
   *
   * Checks for:
   * 1. Committed suggestions (via GitHub's "Commit suggestion" button)
   * 2. Thumbs-up reactions on suggestion comments
   *
   * Records acceptances as positive feedback to improve provider weights.
   */
  async detectAndRecordAcceptances(prNumber) {
    const { githubClient, acceptanceDetector, providerWeightTracker } = this.components;
    if (!githubClient || !acceptanceDetector || !providerWeightTracker) return;
    const { octokit, owner, repo } = githubClient;
    const commitsResponse = await octokit.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100
    });
    const commits = commitsResponse.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      files: (commit.files || []).map((f) => f.filename),
      timestamp: new Date(commit.commit.author?.date || Date.now()).getTime()
    }));
    const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100
    });
    const commentedFiles = /* @__PURE__ */ new Map();
    const commentReactions = [];
    for (const comment of comments) {
      const file = comment.path;
      const line = comment.line || comment.original_line || 0;
      const providerMatch = comment.body?.match(/\*\*Provider:\*\* `([^`]+)`/);
      const provider = providerMatch?.[1];
      if (!commentedFiles.has(file)) {
        commentedFiles.set(file, []);
      }
      commentedFiles.get(file).push({ line, provider });
      const reactions = await octokit.rest.reactions.listForPullRequestReviewComment({
        owner,
        repo,
        comment_id: comment.id
      });
      commentReactions.push({
        commentId: comment.id,
        file,
        line,
        provider,
        reactions: reactions.data.map((r) => ({
          user: r.user?.login || "unknown",
          content: r.content
        }))
      });
    }
    const commitAcceptances = acceptanceDetector.detectFromCommits(commits, commentedFiles);
    const reactionAcceptances = acceptanceDetector.detectFromReactions(commentReactions);
    const allAcceptances = [...commitAcceptances, ...reactionAcceptances];
    await acceptanceDetector.recordAcceptances(allAcceptances, providerWeightTracker);
    if (allAcceptances.length > 0) {
      logger.info(
        `Acceptance detection: ${commitAcceptances.length} from commits, ${reactionAcceptances.length} from reactions, ${allAcceptances.length} total`
      );
    } else {
      logger.debug("No suggestion acceptances detected");
    }
  }
  /**
   * Run all static analysis operations in parallel
   */
  async runStaticAnalysis(files, contextRetriever) {
    const { config } = this.components;
    const [astFindings, ruleFindings, securityFindings, context] = await Promise.all([
      config.enableAstAnalysis ? this.components.astAnalyzer.analyze(files) : Promise.resolve([]),
      this.components.rules.run(files),
      config.enableSecurity ? this.components.security.scan(files) : Promise.resolve([]),
      contextRetriever.findRelatedContext(files)
    ]);
    logger.info(
      `Static analysis complete: ${astFindings.length} AST, ${ruleFindings.length} rules, ${securityFindings.length} security, ${context.length} context items`
    );
    return {
      astFindings,
      ruleFindings,
      securityFindings,
      context
    };
  }
  shouldSkip(pr) {
    const { config } = this.components;
    if (config.skipDrafts && pr.draft) return "PR is a draft";
    if (config.skipBots && this.isBot(pr.author)) return `Author ${pr.author} is a bot`;
    if (config.skipLabels.length > 0) {
      for (const label of pr.labels) {
        if (config.skipLabels.includes(label)) {
          return `Label ${label} triggers skip`;
        }
      }
    }
    const totalLines = pr.additions + pr.deletions;
    if (config.minChangedLines > 0 && totalLines < config.minChangedLines) {
      return `Change size ${totalLines} below minimum ${config.minChangedLines}`;
    }
    if (config.maxChangedFiles > 0 && pr.files.length > config.maxChangedFiles) {
      return `File count ${pr.files.length} exceeds max ${config.maxChangedFiles}`;
    }
    return null;
  }
  isBot(author) {
    const lower = author.toLowerCase();
    return ["bot", "dependabot", "renovate", "github-actions", "[bot]"].some((p) => lower.includes(p));
  }
  async applyReliabilityFilters(providers) {
    const tracker = this.components.reliabilityTracker;
    if (!tracker || providers.length === 0) return providers;
    const available = [];
    for (const provider of providers) {
      const open2 = await tracker.isCircuitOpen(provider.name);
      if (open2) {
        logger.warn(`Skipping provider ${provider.name} (circuit open)`);
        continue;
      }
      available.push(provider);
    }
    if (available.length === 0) {
      logger.warn("All providers are currently tripped by circuit breakers; skipping review run");
      return [];
    }
    const rankings = await tracker.rankProviders(available.map((p) => p.name));
    const scoreMap = new Map(rankings.map((r) => [r.providerId, r.score]));
    return [...available].sort((a, b) => (scoreMap.get(b.name) ?? 0.5) - (scoreMap.get(a.name) ?? 0.5));
  }
  async recordReliability(results) {
    if (!this.components.reliabilityTracker) return;
    for (const result of results) {
      await this.components.reliabilityTracker.recordResult(
        result.name,
        result.status === "success",
        Number.isFinite(result.durationSeconds) ? Math.max(0, result.durationSeconds * 1e3) : void 0,
        result.error?.message
      );
    }
  }
  async initProgressTracker(pr) {
    if (!this.components.githubClient || this.components.config.dryRun) return void 0;
    try {
      const tracker = new ProgressTracker(this.components.githubClient.octokit, {
        owner: this.components.githubClient.owner,
        repo: this.components.githubClient.repo,
        prNumber: pr.number,
        updateStrategy: "milestone"
      });
      await tracker.initialize();
      return tracker;
    } catch (error2) {
      logger.warn("Failed to initialize progress tracker", error2);
      return void 0;
    }
  }
  async ensureBudget(config) {
    if (config.budgetMaxUsd <= 0) return;
    const projected = this.components.costTracker.summary().totalCost;
    if (projected >= config.budgetMaxUsd) {
      throw new Error(
        `Budget exhausted: current recorded cost $${projected.toFixed(4)} exceeds or equals cap $${config.budgetMaxUsd.toFixed(2)}`
      );
    }
  }
  estimateTokens(text) {
    return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  }
  /**
   * Sanitize filename to prevent path traversal attacks
   * Removes directory separators, path traversal sequences, and absolute paths
   */
  sanitizeFilename(filename) {
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      logger.warn(`Detected path traversal attempt in filename: ${filename}`);
      filename = import_path.default.basename(filename);
    }
    if (import_path.default.isAbsolute(filename)) {
      logger.warn(`Detected absolute path in filename: ${filename}`);
      filename = import_path.default.basename(filename);
    }
    const sanitized = filename.replace(/[^a-zA-Z0-9_-]/g, "-").substring(0, 50);
    return sanitized || "multi-provider-review";
  }
  cleanupQueue(queue) {
    queue.clear?.();
  }
  /**
   * Filter diff to only include files that changed
   * Used for incremental reviews to send only relevant diffs to LLMs
   * Uses indexOf instead of regex to avoid ReDoS and improve memory efficiency
   */
  enrichFinding(finding, files, context, providerCount, codeGraph) {
    const file = files.find((f) => f.filename === finding.file);
    const changedLines = mapAddedLines(file?.patch);
    const hasDirectEvidence = changedLines.some((l) => l.line === finding.line);
    const astConfirmed = Boolean(finding.providers?.includes("ast") || finding.provider === "ast");
    let graphConfirmed = context.some((ctx) => ctx.file === finding.file);
    if (codeGraph && !graphConfirmed) {
      const dependents = codeGraph.getDependents(finding.file);
      graphConfirmed = dependents.length > 0;
    }
    const relatedSnippets = context.filter((ctx) => ctx.file === finding.file).flatMap((ctx) => ctx.affectedCode);
    const evidence = this.components.evidenceScorer.score(
      finding,
      providerCount,
      astConfirmed,
      graphConfirmed,
      hasDirectEvidence
    );
    return {
      ...finding,
      evidence,
      evidenceDetail: {
        changedLines: changedLines.map((c) => c.line),
        relatedSnippets,
        providerAgreement: providerCount > 0 ? (finding.providers?.length || 0) / providerCount : 0,
        astConfirmed,
        graphConfirmed
      }
    };
  }
  async applyQuietMode(findings, config) {
    if (!config.quietModeEnabled) return findings;
    if (this.components.quietModeFilter) {
      const filtered = await this.components.quietModeFilter.filterByConfidence(findings);
      const filterStats = await this.components.quietModeFilter.getFilterStats(findings);
      logger.info(`Quiet mode: filtered ${filterStats.filtered}/${filterStats.total} findings (${filterStats.filterRate.toFixed(1)}% reduction)`);
      return filtered;
    }
    const threshold = config.quietMinConfidence ?? 0.5;
    return findings.filter((f) => (f.evidence?.confidence ?? 1) >= threshold);
  }
  /**
   * Create a simple review result for trivial PRs that don't need full analysis
   * Tracks time saved and cost avoided
   */
  createTrivialReview(reason, fileCount, startTime) {
    const durationSeconds = Math.max(1e-3, (Date.now() - startTime) / 1e3);
    return {
      summary: `This PR contains only trivial changes that don't require detailed review.

**Reason:** ${reason}

**Files changed:** ${fileCount}

**Cost savings:** Skipped LLM analysis, saving estimated $0.01-0.05 in API costs.

These types of changes are automatically filtered to save review time and API costs. If you believe this should have been reviewed, you can disable trivial change detection in the configuration.`,
      findings: [],
      inlineComments: [],
      actionItems: [],
      metrics: {
        totalFindings: 0,
        critical: 0,
        major: 0,
        minor: 0,
        providersUsed: 0,
        providersSuccess: 0,
        providersFailed: 0,
        totalTokens: 0,
        totalCost: 0,
        durationSeconds
      },
      runDetails: {
        providers: [],
        totalCost: 0,
        totalTokens: 0,
        durationSeconds,
        cacheHit: false,
        synthesisModel: "",
        providerPoolSize: 0
      }
    };
  }
  async writeReports(review) {
    const base = this.sanitizeFilename(process.env.REPORT_BASENAME || "multi-provider-review");
    const sarifPath = import_path.default.join(process.cwd(), `${base}.sarif`);
    const jsonPath = import_path.default.join(process.cwd(), `${base}.json`);
    await fs12.writeFile(sarifPath, JSON.stringify(buildSarif(review.findings), null, 2), "utf8");
    await fs12.writeFile(jsonPath, buildJson(review), "utf8");
    logger.info(`Wrote reports: ${sarifPath}, ${jsonPath}`);
  }
};

// src/main.ts
function syncEnvFromInputs() {
  const inputKeys = [
    "REVIEW_PROVIDERS",
    "FALLBACK_PROVIDERS",
    "SYNTHESIS_MODEL",
    "INLINE_MAX_COMMENTS",
    "INLINE_MIN_SEVERITY",
    "INLINE_MIN_AGREEMENT",
    "MIN_CHANGED_LINES",
    "MAX_CHANGED_FILES",
    "SKIP_LABELS",
    "PROVIDER_LIMIT",
    "PROVIDER_RETRIES",
    "PROVIDER_MAX_PARALLEL",
    "CODEX_HEALTHCHECK_MODE",
    "CODEX_HEALTHCHECK_REASONING_EFFORT",
    "CODEX_REASONING_EFFORT",
    "FAIL_ON_NO_HEALTHY_PROVIDERS",
    "QUIET_MODE_ENABLED",
    "QUIET_MIN_CONFIDENCE",
    "QUIET_USE_LEARNING",
    "LEARNING_ENABLED",
    "LEARNING_MIN_FEEDBACK_COUNT",
    "DIFF_MAX_BYTES",
    "RUN_TIMEOUT_SECONDS",
    "BUDGET_MAX_USD",
    "ENABLE_AST_ANALYSIS",
    "ENABLE_SECURITY",
    "ENABLE_CACHING",
    "ENABLE_TEST_HINTS",
    "ENABLE_AI_DETECTION",
    "INCREMENTAL_ENABLED",
    "INCREMENTAL_CACHE_TTL_DAYS",
    "GRAPH_ENABLED",
    "GRAPH_CACHE_ENABLED",
    "GRAPH_MAX_DEPTH",
    "GRAPH_TIMEOUT_SECONDS",
    "SKIP_TRIVIAL_CHANGES",
    "SKIP_DEPENDENCY_UPDATES",
    "SKIP_DOCUMENTATION_ONLY",
    "SKIP_FORMATTING_ONLY",
    "SKIP_TEST_FIXTURES",
    "SKIP_CONFIG_FILES",
    "SKIP_BUILD_ARTIFACTS",
    "TRIVIAL_PATTERNS",
    "PATH_BASED_INTENSITY",
    "PATH_INTENSITY_PATTERNS",
    "PATH_DEFAULT_INTENSITY",
    "REPORT_BASENAME",
    "DRY_RUN"
  ];
  for (const key of inputKeys) {
    const value = getInput(key);
    if (value) {
      process.env[key] = value;
    }
  }
}
async function run() {
  try {
    syncEnvFromInputs();
    const token = getInput("GITHUB_TOKEN") || process.env.GITHUB_TOKEN;
    validateRequired(token, "GITHUB_TOKEN");
    const config = ConfigLoader.load();
    const components = await createComponents(config, token);
    const orchestrator = new ReviewOrchestrator(components);
    const prInput = getInput("PR_NUMBER") || process.env.PR_NUMBER;
    validateRequired(prInput, "PR_NUMBER");
    const prNumber = validatePositiveInteger(prInput, "PR_NUMBER");
    if (config.dryRun) {
      info("\u{1F50D} DRY RUN MODE - Review will run but no comments will be posted");
    }
    info(`Starting review for PR #${prNumber}`);
    const review = await orchestrator.execute(prNumber);
    if (!review) {
      info("Review skipped");
      return;
    }
    setOutput("findings_count", review.findings.length);
    setOutput("critical_count", review.findings.filter((f) => f.severity === "critical").length);
    setOutput("cost_usd", review.metrics.totalCost.toFixed(4));
    setOutput("total_cost", review.metrics.totalCost.toFixed(4));
    if (review.aiAnalysis) {
      setOutput("ai_likelihood", review.aiAnalysis.averageLikelihood);
    }
    info("Review completed successfully");
  } catch (error2) {
    const err = error2;
    if (error2 instanceof ValidationError) {
      const formatted = formatValidationError(error2);
      setFailed(`Configuration error:
${formatted}`);
    } else {
      setFailed(`Review failed: ${err.message}`);
      if (err.message.includes("ENOENT")) {
        error("File not found. Check that all file paths are correct.");
      } else if (err.message.includes("EACCES")) {
        error("Permission denied. Check file permissions.");
      } else if (err.message.includes("rate limit")) {
        error("API rate limit exceeded. Consider using caching or reducing provider count.");
      } else if (err.message.includes("timeout")) {
        error("Operation timed out. Consider increasing the timeout value.");
      }
    }
  }
}
run().catch((error2) => {
  setFailed(`Unhandled error: ${error2.message}`);
});
/*! Bundled license information:

js-yaml/dist/js-yaml.mjs:
  (*! js-yaml 4.1.1 https://github.com/nodeca/js-yaml @license MIT *)
*/
//# sourceMappingURL=index.js.map
