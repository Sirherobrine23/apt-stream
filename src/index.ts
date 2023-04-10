#!/usr/bin/env node
import "./log.js";
import yargs from "yargs";
import cluster from "node:cluster";
import aptServer from "./aptServer.js";
import configManeger from "./configManeger.js";
import packageManeger from "./packages.js";

yargs(process.argv.slice(2)).version(false).help(true).strictCommands().demandCommand().alias("h", "help").command(["server", "serve", "s"], "Run http Server", yargs => yargs.option("config", {
    string: true,
    alias: "c",
    type: "string",
    description: "Config file path",
    default: "aptStream.yml"
  }).option("port", {
    number: true,
    alias: "p",
    type: "number",
    description: "Alternative port to Run http server"
  }).option("cluster", {
    number: true,
    type: "number",
    description: "Enable cluster mode for perfomace",
    alias: "t"
  }).option("data", {
    string: true,
    alias: "C",
    type: "string",
    description: "data files"
  }).option("db", {
    string: true,
    type: "string",
    alias: "d",
    description: "database url"
  }).option("debug", {
    boolean: true,
    type: "boolean",
    default: false
  }), async options => {
  const pkg = await packageManeger(options.config);
  if (!!options.cluster && options.cluster > 0) pkg.setClusterForks(options.cluster);
  if (!!options.data) pkg.setDataStorage(options.data);
  if (!!options.port) pkg.setPortListen(options.port);
  if (!!options.db) pkg.setDatabse(options.db);
  let forks = pkg.getClusterForks();
  if (cluster.isPrimary && (forks > 0)) {
    const forkProcess = async (count = 0): Promise<number> => new Promise((done, reject) => {
      const fk = cluster.fork();
      return fk.on("error", err => {
        console.error(err);
        return reject(err);
      }).on("online", () => done(fk.id)).once("exit", (code, signal) => {
        count++;
        if (!signal && code === 0) return console.info("Cluster %s: exited and not restarting", fk.id);
        else if (count > 5) return console.warn("Cluster get max count retrys!");
        console.info("Cluster %s: Catch %O, and restating with this is restating count %f", fk.id, code||signal, count);
        return forkProcess(count);
      });
    });
    for (let i = 0; i < forks; i++) await forkProcess().then(id => console.info("Cluster %s is online", id));
    return;
  }
  return aptServer(pkg);
}).command(["maneger", "m", "$0"], "maneger packages in database", yargs => {
  return yargs.option("config", {
    string: true,
    alias: "c",
    type: "string",
    description: "Config file path",
    default: "aptStream.yml",
  }).command(["$0"], "Maneger config", async options => configManeger(await packageManeger(options.parseSync().config))).command(["print", "p"], "Print config to target default is json", yargs => yargs.option("outputType", {
    alias: "o",
    choices: ["yaml", "yml", "json", "json64", "yaml64", "yml64"],
    description: "target output file, targets ended with '64' is base64 string",
    default: "json"
  }), async (options) => console.log(((await packageManeger(options.config)).toString(options.outputType.startsWith("64") ? "base64" : "utf8", options.outputType.startsWith("json") ? "json" : "yaml"))));
}).parseAsync();