import { formatWithOptions, InspectOptions } from "node:util";
import cluster from "node:cluster";
import expressLayer from "express/lib/router/layer.js";

// Patch promise handler to express 4.x
expressLayer.prototype.handle_request = async function handle_request_promised(...args) {
  var fn = this.handle;
  if (fn.length > 3) return args.at(-1)();
  await Promise.resolve().then(() => fn.call(this, ...args)).catch(args.at(-1));
}

// Set default custom log to Cluster workers
if (cluster.isWorker) {
  const { log, error, debug, info, warn } = console;
  const { id } = cluster.worker ?? {};
  const defaultOptions: InspectOptions = {
    colors: true,
    showHidden: false,
    depth: null
  };

  console.clear = console.clear ?? function () {console.warn("cannot clear tty");}

  console.log = function(...args) {
    log("[LOG%s]: %s", id ? ` Cluster ${id}` : "", formatWithOptions(defaultOptions, ...args));
  }

  console.error = function(...args) {
    error("[ERROR%s]: %s", id ? ` Cluster ${id}` : "", formatWithOptions(defaultOptions, ...args));
  }

  console.debug = function(...args) {
    debug("[DEBUG%s]: %s", id ? ` Cluster ${id}` : "", formatWithOptions(defaultOptions, ...args));
  }

  console.info = function(...args) {
    info("[INFO%s]: %s", id ? ` Cluster ${id}` : "", formatWithOptions(defaultOptions, ...args));
  }

  console.warn = function(...args) {
    warn("[WARNING%s]: %s", id ? ` Cluster ${id}` : "", formatWithOptions(defaultOptions, ...args));
  }
}
