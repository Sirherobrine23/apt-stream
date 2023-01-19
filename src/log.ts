import cluster from "node:cluster";
import utils from "node:util";

if (!cluster.isPrimary && cluster.worker?.id) {
  const Console = new console.Console(process.stdout, process.stderr);
  const workerId = cluster.worker.id;
  const inspectOptions: utils.InspectOptions = {
    colors: true,
    depth: null,
    showHidden: false,
    maxArrayLength: null,
    maxStringLength: null,
    compact: false,
  };
  console.log = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[Log ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => Console.log(`${Base} ${line}`));
  }
  console.warn = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[WARN ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => Console.warn(`${Base} ${line}`));
  }
  console.error = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[ERROR ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => Console.error(`${Base} ${line}`));
  }
  console.info = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[INFO ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => Console.info(`${Base} ${line}`));
  }
  console.debug = function (msg, ...args) {
    const currentDate = (new Date()).toLocaleString();
    const Base = `[DEBUG ${currentDate} Worker ${workerId}]:`;
    utils.formatWithOptions(inspectOptions, msg, ...args).split("\n").forEach(line => Console.debug(`${Base} ${line}`));
  }
}