#!/usr/bin/env node
import "./log.js";
import path from "node:path";
import yargs from "yargs";
import cluster from "node:cluster";
import aptServer from "./aptServer.js";
import configManeger from "./configManeger.js";
import packageManeger from "./packages.js";
import oldFs, { promises as fs } from "node:fs";
import { aptStreamConfig } from "./config.js";
import { extendsFS } from "@sirherobrine23/extends";
import { pipeline } from "node:stream/promises";
import { dpkg } from "@sirherobrine23/debian";

yargs(process.argv.slice(2)).wrap(process.stdout.getWindowSize?.().at?.(0)||null).version(false).help(true).strictCommands().demandCommand().alias("h", "help").command(["server", "serve", "s"], "Run http Server", yargs => yargs.option("config", {
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
  }).option("auto-sync", {
    type: "boolean",
    boolean: true,
    alias: "z",
    default: false,
    description: "Enable backgroud sync packages"
  }), async options => {
  const pkg = await packageManeger(options.config);
  if (!!options.cluster && options.cluster > 0) pkg.setClusterForks(options.cluster);
  if (!!options.data) pkg.setDataStorage(options.data);
  if (!!options.port) pkg.setPortListen(options.port);
  if (!!options.db) pkg.setDatabse(options.db);
  let forks = pkg.getClusterForks();
  if (cluster.isPrimary) {
    if (!!(options.autoSync ?? options["auto-sync"])) (async () => {
      while (true) {
        console.info("Initing package sync!");
        await pkg.syncRepositorys((err, {repositoryID, controlFile: { Package, Architecture, Version }}) => err ? null : console.log("Sync/Add: %s -> %s %s/%s (%s)", repositoryID, Package, Architecture, Version));
        console.log("Next sync after 30 Minutes");
        await new Promise(done => setTimeout(done, 1800000));
      }
    })().catch(err => {
      console.info("Auto sync packages disabled!");
      console.error(err);
    });
    if (forks > 0) {
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
      return
    }
  }
  return aptServer(pkg);
}).command(["maneger", "m", "$0"], "maneger packages in database", yargs => yargs.option("config", {
  string: true,
  alias: "c",
  type: "string",
  description: "Config file path",
  default: "aptStream.yml",
}).command(["print", "p"], "Print config to target default is json", yargs => yargs.option("outputType", {
  description: "target output file, targets ended with '64' is base64 string or 'hex' to hexadecimal",
  default: "json",
  alias: "o",
  choices: [
    "yaml", "yml", "yaml64", "yml64", "yamlhex", "ymlhex",
    "json", "json64", "jsonhex",
  ],
}), async (options) => console.log(((new aptStreamConfig(options.config)).toString(options.outputType.endsWith("64") ? "base64": options.outputType.endsWith("hex") ? "hex" : "utf8", options.outputType.startsWith("json") ? "json" : "yaml")))).command(["$0"], "Maneger config", async options => {
  if (!process.stdin.isTTY) throw new Error("Run with TTY to maneger config!");
  return configManeger(options.parseSync().config);
})).command(["pack", "pack-deb", "create", "c"], "Create package", yargs => yargs.option("config", {
  string: true,
  alias: "c",
  type: "string",
  description: "Config file path",
  default: "aptStream.yml",
}).option("package-path", {
  type: "string",
  string: true,
  alias: "s",
  default: process.cwd(),
  description: "Debian package source",
}).option("output", {
  type: "string",
  string: true,
  alias: "o",
}).option("compress", {
  type: "string",
  string: true,
  description: "Data compress file",
  default: "gzip",
  choices: [
    "gzip",
    "passThrough",
    "xz"
  ]
}), async options => {
  let debianConfig: string;
  if (!(await extendsFS.exists(debianConfig = path.resolve(process.cwd(), options.packagePath, "DEBIAN"))||await extendsFS.exists(debianConfig = path.resolve(process.cwd(), options.packagePath, "debian")))) throw new Error("Create valid package Structure!");
  if (!(await extendsFS.exists(path.join(debianConfig, "control")))) throw new Error("Require control file");
  const control = dpkg.parseControl(await fs.readFile(path.join(debianConfig, "control")));
  if (!options.output) options.output = path.join(process.cwd(), `${control.Package}_${control.Architecture}_${control.Version}.deb`); else options.output = path.resolve(process.cwd(), options.output);
  console.log("Creating debian package");
  await pipeline(dpkg.createPackage({
    control,
    dataFolder: path.resolve(debianConfig, ".."),
    compress: {
      data: options.compress as any||"gzip"
    }
  }), oldFs.createWriteStream(options.output));
  console.log("Saved in %O", options.output);
}).parseAsync();