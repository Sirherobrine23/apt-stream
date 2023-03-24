import { formatWithOptions, InspectOptions } from "node:util";
import cluster from "node:cluster";

if (cluster.isWorker) {
  const { log, error, debug, info, warn } = console;
  const { id } = cluster.worker ?? {};
  const defaultOptions: InspectOptions = {
    colors: true,
    showHidden: false,
    depth: null
  };

  console.clear = console.clear ?? function () {console.warn("Not tty")}

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
