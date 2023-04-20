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
  default: "yaml",
  alias: "o",
  choices: [
    "yaml", "yml", "yaml64", "yml64", "yamlhex", "ymlhex",
    "json", "json64", "jsonhex",
  ],
}), async (options) => console.log(((new aptStreamConfig(options.config)).toString(options.outputType.endsWith("64") ? "base64": options.outputType.endsWith("hex") ? "hex" : "utf8", options.outputType.startsWith("json") ? "json" : "yaml")))).command(["$0"], "Maneger config", async options => {
  if (!process.stdin.isTTY) throw new Error("Run with TTY to maneger config!");
  return configManeger(options.parseSync().config);
})).command(["sync", "synchronize"], "Sync packges directly from CLI", yargs => yargs.option("config", {
  string: true,
  alias: "c",
  type: "string",
  description: "Config file path",
  default: "aptStream.yml",
}), async options => {
  console.log("Starting...");
  const pkg = await packageManeger(options.config);
  await pkg.syncRepositorys((err, db) => err?console.error(err?.message || err):console.log("Added %s: %s/%s (%s)", db.repositoryID, db.controlFile.Package, db.controlFile.Architecture, db.controlFile.Version));
  console.log("End!");
  return pkg.close();
}).command(["pack", "pack-deb", "create", "c"], "Create package", yargs => yargs.option("package-path", {
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
  console.log("File saved %O", options.output);
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
}).option("tag", {
  type: "string",
  string: true,
  description: "Docker/Github release tag name",
  alias: ["dockerTAG", "ociTAG", "oci_tag", "release_tag"]
}), async options => {
  const files = options._.slice(1).map((file: string) => path.resolve(process.cwd(), file));
  if (!files.length) throw new Error("Required one file to Upload");
  const config = new aptStreamConfig(options.config);
  if (!(config.getRepository(options.repositoryID).get(options.repositoryID)).enableUpload) throw new Error("Repository not support upload file!");
  const up = await config.getRepository(options.repositoryID).uploadFile(options.repositoryID);
  if (up.githubUpload) {
    for (const filePath of files) {
      if (!(await extendsFS.exists(filePath))) {console.error("%O not exsists!"); continue;}
      const stats = await fs.lstat(filePath);
      const filename = path.basename(filePath);
      await finished(createReadStream(filePath).pipe(await up.githubUpload(filename, stats.size, options.tag)));
    }
  } else if (up.gdriveUpload) {
    for (const filePath of files) {
      if (!(await extendsFS.exists(filePath))) {console.error("%O not exsists!"); continue;}
      const filename = path.basename(filePath);
      await finished(createReadStream(filePath).pipe(await up.gdriveUpload(filename)));
    }
  } else if (up.ociUpload) {
    for (const filePath of files) {
      if (!(await extendsFS.exists(filePath))) {console.error("%O not exsists!"); continue;}
      const filename = path.basename(filePath);
      await finished(createReadStream(filePath).pipe(await up.ociUpload(filename)));
    }
  } else if (up.dockerUpload) {
    for (const filePath of files) {
      if (!(await extendsFS.exists(filePath))) {console.error("%O not exsists!"); continue;}
      const { controlFile } = await dpkg.parsePackage(createReadStream(filePath));
      const filename = path.basename(filePath);
      const tr = await up.dockerUpload(dockerRegistry.debianControlToDockerPlatform(controlFile.Architecture));
      tr.annotations.set("org.opencontainers.image.description", controlFile.Description);
      tr.annotations.set("org.opencontainers.image.version", controlFile.Version);
      tr.annotations.set("org.sirherobrine23.aptstream.control", JSON.stringify(controlFile));
      tr.annotations.set("com.github.package.type", "aptstream_package");
      await finished(createReadStream(filePath).pipe(tr.addEntry({
        name: filename,
        type: "file",
        size: (await fs.lstat(filePath)).size
      })));
      const img_info = await tr.finalize(options.tag||controlFile.Version);
      console.log("Image digest: %O", img_info.digest);
    }

  }

  await config.saveConfig().catch(() => {});
}).parseAsync().catch(err => {
  console.error(err);
  process.exit(-1);
});