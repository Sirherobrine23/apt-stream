import { format } from "node:util";
import { WriteStream } from "node:fs";
import { PassThrough, Readable, Writable } from "node:stream";
import { getConfig } from "../repoConfig.js";
import * as ghcr from "../githubGhcr.js";
import * as release from "../githubRelease.js";
import zlib from "node:zlib";
import express from "express";
import coreUtils from "@sirherobrine23/coreutils";

export type packagesObject = {
  Package: string
  Version: string,
  /** endpoint folder file */
  Filename: string,
  "Installed-Size": number,
  Maintainer: string,
  Architecture: string,
  Depends?: string,
  Homepage?: string,
  Section?: string,
  Priority?: string,
  Size: number,
  MD5sum: string,
  SHA256: string,
  Description?: string,
};

export type ReleaseOptions = {
  Origin?: string,
  Suite?: string,
  Archive?: string,
  lebel?: string,
  Codename?: string,
  Architectures: string[],
  Components: string[],
  Description?: string,
  sha256?: {sha256: string, size: number, file: string}[]
};

export function parseDebControl(control: string|Buffer) {
  if (Buffer.isBuffer(control)) control = control.toString();
  const controlObject: {[key: string]: string} = {};
  for (const line of control.split(/\r?\n/)) {
    if (/^[\w\S]+:/.test(line)) {
      const [, key, value] = line.match(/^([\w\S]+):(.*)$/);
      controlObject[key.trim()] = value.trim();
    } else {
      controlObject[Object.keys(controlObject).at(-1)] += line;
    }
  }
  return controlObject;
}

export function mountRelease(repo: ReleaseOptions) {
  let data = [`Lebel: ${repo.lebel||repo.Origin}`];
  data.push(`Date: ${(new Date()).toUTCString()}`);
  if (repo.Origin) data.push(`Origin: ${repo.Origin}`);
  if (repo.Suite) data.push(`Suite: ${repo.Suite}`);
  else if (repo.Archive) data.push(`Archive: ${repo.Archive}`);
  if (repo.Codename) data.push(`Codename: ${repo.Codename}`);
  data.push(`Architectures: ${repo.Architectures.join(" ")}\nComponents: ${repo.Components.join(" ")}`);
  if (repo.Description) data.push(`Description: ${repo.Description}`);
  if (repo.sha256 && repo.sha256?.length > 0) {
    data.push("SHA256:");
    for (const file of repo.sha256) {
      data.push(` ${file.sha256} ${file.size} ${file.file}`);
    }
  }
  return data.join("\n")+"\n";
}

export type registryPackageData = {
  name: string,
  getStrem: () => Promise<Readable>,
  version: string,
  arch: string,
  size?: number,
  signature?: {
    sha256: string,
    md5: string,
  },
  packageConfig?: {
    [key: string]: string;
  }
};

type localRegister = {
  [name: string]: {
    [version: string]: {
      [arch: string]: {
        getStream: registryPackageData["getStrem"],
        config?: registryPackageData["packageConfig"],
        signature?: registryPackageData["signature"],
        size?: registryPackageData["size"],
      }
    }
  }
};

export class localRegistryManeger {
  public packageRegister: localRegister = {};
  prettyPackages() {
    const packagePretty = {};
    for (const name in this.packageRegister) {
      if (!packagePretty[name]) packagePretty[name] = [];
      for (const version in this.packageRegister[name]) {
        for (const arch in this.packageRegister[name][version]) {
          packagePretty[name].push({
            version,
            arch,
            config: this.packageRegister[name][version][arch].config,
          });
        }
      }
    }
    return packagePretty;
  }

  public registerPackage(packageConfig: registryPackageData) {
    packageConfig.name = packageConfig.name?.toLowerCase()?.trim();
    packageConfig.version = packageConfig?.version?.trim();
    if (!this.packageRegister) this.packageRegister = {};
    if (!this.packageRegister[packageConfig.name]) this.packageRegister[packageConfig.name] = {};
    if (!this.packageRegister[packageConfig.name][packageConfig.version]) this.packageRegister[packageConfig.name][packageConfig.version] = {};
    console.log("[Internal package maneger]: Registry %s with version %s and arch %s", packageConfig.name, packageConfig.version, packageConfig.arch);
    this.packageRegister[packageConfig.name][packageConfig.version][packageConfig.arch] = {
      getStream: packageConfig.getStrem,
      config: packageConfig.packageConfig,
      signature: packageConfig.signature,
      size: packageConfig.size,
    };
  }

  public async createPackage(compress: boolean, name: string, arch: string, res: WriteStream|Writable|PassThrough = new PassThrough({read(){}, write(){}})) {
    const sign: {sha256?: {hash: string, size: number}, md5?: {hash: string, size: number}, size: number} = {size: 0};
    const Packages: packagesObject[] = [];
    if (!this.packageRegister[name]) throw new Error("Package not found");
    for (const version in this.packageRegister[name]) {
      const packageData = this.packageRegister[name][version][arch];
      if (!packageData) continue;
      Packages.push({
        Package: name,
        Version: version,
        Filename: format("pool/%s/%s/%s.deb", name, version, arch),
        "Installed-Size": parseInt(packageData.config?.["Installed-Size"]||"0"),
        Maintainer: packageData.config?.Maintainer||"node-apt",
        Architecture: packageData.config?.Architecture||"all",
        Depends: packageData.config?.Depends,
        Homepage: packageData.config?.Homepage,
        Section: packageData.config?.Section,
        Priority: packageData.config?.Priority,
        Size: packageData.size||0,
        MD5sum: packageData.signature?.md5,
        SHA256: packageData.signature?.sha256,
        Description: packageData.config?.Description,
      });
    }
    let vsize = 0;
    let waitPromises: Promise<any>[] = [];
    const rawStream = new PassThrough({read(){}, write(){}});
    if (compress) {
      const ReadStream = new PassThrough({read(){}, write(){}});
      const gzip = ReadStream.pipe(zlib.createGzip());
      gzip.pipe(res);
      gzip.pipe(rawStream);
      res = ReadStream;
    }
    rawStream.on("data", (chunk) => vsize += chunk.length);
    waitPromises.push(coreUtils.extendsCrypto.createSHA256_MD5(rawStream, "sha256", new Promise(done => rawStream.once("close", done))).then(sha256 => sign.sha256 = {hash: sha256, size: vsize}));
    waitPromises.push(coreUtils.extendsCrypto.createSHA256_MD5(rawStream, "md5", new Promise(done => rawStream.once("close", done))).then(md5 => sign.md5 = {hash: md5, size: vsize}));
    for (const packageInfo of Packages) {
      let packageData = [];
      for (let i in packageInfo) packageData.push(`${i}: ${packageInfo[i]||""}`);
      const configLine = packageData.join("\n")+"\n\n";
      sign.size += configLine.length;
      rawStream.push(Buffer.from(configLine, "utf8"));
      rawStream.write(Buffer.from(configLine, "utf8"));
      if (res instanceof PassThrough) res.push(configLine);
      else res.write(configLine);
    }
    res.end();
    res.destroy();
    rawStream.end();
    rawStream.destroy();
    await Promise.all(waitPromises);
    return sign;
  }
}

async function mainConfig(configPath: string) {
  const config = await getConfig(configPath);
  const packageReg = new localRegistryManeger();
  Promise.all(config.repos.map(async repo => {
    if (repo.from === "release") return release.fullConfig({config: repo.repo, githubToken: repo?.auth?.password}, packageReg).catch(console.error);
    if (repo.from === "oci") return ghcr.list(typeof repo.repo === "string" ? repo.repo : coreUtils.DockerRegistry.Utils.toManifestOptions(format("%s/%s", repo.repo.owner, repo.repo.repo)), repo.ociConfig).then(data => {
      return ghcr.fullConfig(data, packageReg).catch(console.error);
    }).catch(console.error);
  })).catch(console.error);
  return packageReg;
}

export type apiConfig = {
  configPath: string,
  portListen?: number,
  callback?: (port: number) => void,
  repositoryOptions?: {
    Origin?: string,
    lebel?: string,
  }
};
export async function createAPI(apiConfig: apiConfig) {
  const mainRegister = await mainConfig(apiConfig.configPath);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({extended: true}));
  app.use((_req, res, next) => {
    res.json = (data) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(data, null, 2));
    next();
  });

  // Request log
  app.use((req, _res, next) => {
    next();
    console.log("[%s]: From: %s, path: %s", req.protocol, req.ip, req.path);
  });

  // /dists
  // Signed Release with gpg
  // app.get("/dists/:suite/InRelease", (req, res) => {});
  // app.get("/dists/:package/Release.gpg", (req, res) => {});

  // Root release
  app.get("/dists/:package/Release", async (req, res) => {
    if (!mainRegister.packageRegister[req.params.package]) return res.status(404).json({error: "Package not registred"});
    const Archs: string[] = [];
    Object.keys(mainRegister.packageRegister[req.params.package]).forEach(version => Object.keys(mainRegister.packageRegister[req.params.package][version]).forEach(arch => (!Archs.includes(arch.toLowerCase()))?Archs.push(arch.toLowerCase()):null));
    const shas: ReleaseOptions["sha256"] = [];
    // for (const arch of Archs) {
    //   const Packagegz = await mainRegister.createPackage(true, req.params.package, arch);
    //   const Package = await mainRegister.createPackage(false, req.params.package, arch);
    //   if (Packagegz?.sha256?.hash) shas.push({file: format("main/binary-%s/Packages.gz", arch), sha256: Packagegz.sha256.hash, size: Packagegz.sha256.size});
    //   if (Package?.sha256?.hash) shas.push({file: format("main/binary-%s/Packages", arch), sha256: Package.sha256.hash, size: Package.sha256.size});
    // }
    const data = mountRelease({
      Origin: apiConfig.repositoryOptions?.Origin||"node-apt",
      lebel: apiConfig.repositoryOptions?.lebel,
      Suite: req.params.package,
      Components: ["main"],
      Architectures: Archs,
      sha256: shas
    });
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Length", data.length);
    return res.send(data);
  });

  // Binary release
  app.get("/dists/:package/main/binary-:arch/Release", (req, res) => {
    const Archs: string[] = [];
    Object.keys(mainRegister.packageRegister[req.params.package]).forEach(version => Object.keys(mainRegister.packageRegister[req.params.package][version]).forEach(arch => (!Archs.includes(arch.toLowerCase()))?Archs.push(arch.toLowerCase()):null));
    if (!Archs.includes(req.params.arch.toLowerCase())) return res.status(404).json({error: "Package arch registred"});
    res.setHeader("Content-Type", "text/plain");
    return res.send(mountRelease({
      Origin: apiConfig.repositoryOptions?.Origin||"node-apt",
      lebel: apiConfig.repositoryOptions?.lebel,
      Archive: req.params.package,
      Components: ["main"],
      Architectures: [req.params.arch.toLowerCase()]
    }));
  });

  // binary packages
  app.get("/dists/:package/main/binary-:arch/Packages(.gz|)", async (req, res) => mainRegister.createPackage(req.path.endsWith(".gz"), req.params.package, req.params.arch, res.writeHead(200, {"Content-Type": req.path.endsWith(".gz") ? "application/x-gzip" : "text/plain"})));

  // source.list
  app.get("/*.list", (req, res) => {
    res.setHeader("Content-type", "text/plain");
    let config = "";
    Object.keys(mainRegister.packageRegister).forEach(packageName => config += format("deb [trusted=yes] %s://%s %s main\n", req.protocol, req.headers.host, packageName));
    res.send(config+"\n");
  });

  // Pool
  app.get(["/", "/pool"], (_req, res) => res.json(mainRegister.prettyPackages()));
  app.get("/pool/:package_name", (req, res) => {
    const {package_name} = req.params;
    const info = mainRegister.packageRegister[package_name];
    if (!info) return res.status(404).json({error: "Package not registred"});
    return res.json(info);
  });
  app.get("/pool/:package_name/:version", (req, res) => {
    const {package_name, version} = req.params;
    const info = mainRegister.packageRegister[package_name];
    if (!info) return res.status(404).json({error: "Package not registred"});
    const ver = info?.[version];
    if (!ver) return res.status(404).json({error: "version not registred"});
    return res.json(ver);
  });

  app.get("/pool/:package_name/:version/:arch.deb", (req, res) => {
    const {package_name, arch, version} = req.params;
    const info = mainRegister.packageRegister[package_name];
    if (!info) return res.status(404).json({error: "Package not registred"});
    const ver = info?.[version];
    if (!ver) return res.status(404).json({error: "version not registred"});
    const archInfo = ver?.[arch];
    if (!archInfo) return res.status(404).json({error: "arch not registred"});
    const stream = archInfo?.getStream;
    if (!stream) return res.status(404).json({error: "Package not registred"});
    res.writeHead(200, {"Content-Type": "application/x-debian-package"});
    return Promise.resolve(stream()).then(stream => stream.pipe(res));
  });

  app.get("/pool/:package_name/:version/:arch", (req, res) => {
    const {package_name, arch, version} = req.params;
    const info = mainRegister.packageRegister[package_name];
    if (!info) return res.status(404).json({error: "Package not registred"});
    const ver = info?.[version];
    if (!ver) return res.status(404).json({error: "version not registred"});
    const archInfo = ver?.[arch];
    if (!archInfo) return res.status(404).json({error: "arch not registred"});
    return res.json(archInfo);
  });

  app.listen(apiConfig.portListen||0, function listen() {
    if (typeof apiConfig.callback !== "function") apiConfig.callback = (port) => console.log("API listen on port %s", port);
    apiConfig.callback(this.address().port);
  });
  return app;
}