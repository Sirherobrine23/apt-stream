import cluster from "node:cluster";
import utils from "node:util";

if (cluster.isWorker && cluster.worker?.id) {
  const workerId = cluster.worker.id;
  const inspectOptions: utils.InspectOptions = {
    colors: true,
    depth: null,
    showHidden: false,
    maxArrayLength: null,
    maxStringLength: null,
    compact: false,
  };

  const originalLog = console.log;
  console.log = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[LOG ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => originalLog(`${Base} ${line}`));
  }

  const originalWarn = console.warn;
  console.warn = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[WARN ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => originalWarn(`${Base} ${line}`));
  }

  const originalError = console.error;
  console.error = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[ERROR ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => originalError(`${Base} ${line}`));
  }

  const originalInfo = console.info;
  console.info = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[INFO ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => originalInfo(`${Base} ${line}`));
  }

  const originalDebug = console.debug;
  console.debug = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[DEBUG ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => originalDebug(`${Base} ${line}`));
  }
}