#!/usr/bin/env node
import "./log.js";
import path from "node:path";
import yargs from "yargs";
import cluster from "node:cluster";
import aptServer from "./aptServer.js";
import configManeger from "./configManeger.js";
import packageManeger from "./packages.js";
import oldFs, { createReadStream, promises as fs } from "node:fs";
import { aptStreamConfig } from "./config.js";
import { extendsFS } from "@sirherobrine23/extends";
import { finished } from "node:stream/promises";
import { dpkg } from "@sirherobrine23/dpkg";
import { dockerRegistry } from "@sirherobrine23/docker-registry";

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
})).command(["pack", "pack-deb", "create", "c"], "Create package", yargs => yargs.option("package-path", {
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
  alias: [
    "data-compress",
  ],
  description: "data.tar compress file",
  default: "gzip",
  choices: [
    "gzip",
    "passThrough",
    "xz"
  ]
}).option("control-compress", {
  type: "string",
  string: true,
  description: "control.tar compress file",
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
  const scriptsFile = (await fs.readdir(debianConfig)).filter(file => (["preinst", "prerm", "postinst", "postrm"]).includes(file));

  console.log("Creating debian package");
  await finished(dpkg.createPackage({
    control,
    dataFolder: path.resolve(debianConfig, ".."),
    compress: {
      data: options.compress as any||"gzip",
      control: options.controlCompress as any||"gzip",
    },
    scripts: scriptsFile.reduce<dpkg.packageConfig["scripts"]>((acc, file) => {acc[file] = path.join(debianConfig, file); return acc;}, {})
  }).pipe(oldFs.createWriteStream(options.output)));
}).command(["upload", "u"], "Upload package to repoitory allow uploads", yargs => yargs.strictCommands(false).option("config", {
  string: true,
  alias: "c",
  type: "string",
  description: "Config file path",
  default: "aptStream.yml",
}).option("repositoryID", {
  type: "string",
  string: true,
  alias: ["repoID", "id", "i"],
  demandOption: true,
  description: "Repository to upload files"
}), async options => {
  const files = options._.slice(1).map((file: string) => path.resolve(process.cwd(), file));
  if (!files.length) throw new Error("Required one file to Upload");
  const config = new aptStreamConfig(options.config);
  if (!(config.getRepository(options.repositoryID).get(options.repositoryID)).enableUpload) throw new Error("Repository not support upload file!");
  for (const filePath of files) {
    if (!(await extendsFS.exists(filePath))) {
      console.error("%O not exsists!");
      continue;
    }
    try {
      const stats = await fs.lstat(filePath);
      const up = await config.getRepository(options.repositoryID).uploadFile(options.repositoryID);
      const filename = path.basename(filePath);
      if (up.githubUpload) {
        await finished(createReadStream(filePath).pipe(await up.githubUpload(filename, stats.size)));
      } else if (up.gdriveUpload) {
        await finished(createReadStream(filePath).pipe(await up.gdriveUpload(filename)));
      } else if (up.ociUpload) {
        await finished(createReadStream(filePath).pipe(await up.ociUpload(filename)));
      } else if (up.dockerUpload) {
        const { Architecture } = await dpkg.parsePackage(createReadStream(filePath), true);
        const platform: dockerRegistry.dockerPlatform = {os: "linux", architecture: dockerRegistry.nodeToGO("arch", process.arch) as dockerRegistry.goArch}
        if (Architecture === "all") platform.architecture = "amd64";
        else if (Architecture === "amd64") platform.architecture = "amd64";
        else if (Architecture === "arm64") {platform.architecture = "arm64"; platform.variant = "v8"}
        else if (Architecture === "armhf") {platform.architecture = "arm"; platform.variant = "v7"}
        else if (Architecture === "armeb"||Architecture === "arm") {platform.architecture = "arm"; platform.variant = "v6"}
        else if (Architecture === "i386") platform.architecture = "ia32";
        else if (Architecture === "s390") platform.architecture = "s390";
        else if (Architecture === "s390x") platform.architecture = "s390x";
        else if (Architecture === "ppc64"||Architecture === "ppc64el") platform.architecture = "ppc64";
        else if (Architecture === "mipsel") platform.architecture = "mipsel";
        else if (Architecture === "mips") platform.architecture = "mips";
        else throw new Error("Package arch not supported");
        await new Promise<void>(async (done, reject) => {
          const tr = await up.dockerUpload(platform, err => {
            if (err) return reject(err);
            done()
          });
          await finished(createReadStream(filePath).pipe(tr.entry({name: filename, type: "file", size: stats.size})));
          tr.finalize();
        });
      }
    } catch (err) {
      console.dir(err, {
        colors: true,
        depth: null,
      });
    }
  }
}).parseAsync();