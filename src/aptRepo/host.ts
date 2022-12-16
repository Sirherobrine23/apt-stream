import { format } from "node:util";
import express from "express";
import * as utils from "./utils.js";
import mainConfig from "./main.js";

export async function createAPI(configPath: string, portListen: number, callback = () => console.log("Listen on %f", portListen)) {
  const mainRegister = await mainConfig(configPath);
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

  // source.list
  app.get("/sources.list", (req, res) => {
    res.setHeader("Content-type", "text/plain");
    let config = "";
    Object.keys(mainRegister.packageRegister).forEach(packageName => config += format("deb [trusted=yes] %s://%s %s main\n", req.protocol, req.headers.host, packageName));
    res.send(config+"\n");
  });

  // Pool
  app.get(["/", "/pool"], (_req, res) => res.json(mainRegister.packageRegister));
  app.get("/pool/:package_name", (req, res) => {
    const {package_name} = req.params;
    const info = mainRegister.packageRegister[package_name];
    if (!info) return res.status(404).json({error: "Package not registred"});
    return res.json(info);
  });
  app.get("/pool/:package_name/:version", (req, res) => {
    const {package_name, version} = req.params;
    const info = mainRegister.packageRegister[package_name]?.[version];
    if (!info) return res.status(404).json({error: "Package not registred"});
    return res.json(info);
  });
  app.get("/pool/:package_name/:version/:arch", (req, res) => {
    const {package_name, arch, version} = req.params;
    const info = mainRegister.packageRegister[package_name]?.[version]?.[arch];
    if (!info) return res.status(404).json({error: "Package not registred"});
    return res.json(info.config||info);
  });
  app.get("/pool/:package_name/:version/:arch.deb", (req, res) => {
    const {package_name, arch, version} = req.params;
    const stream = mainRegister.packageRegister[package_name]?.[version]?.[arch]?.getStream;
    if (!stream) return res.status(404).json({error: "Package not registred"});
    res.writeHead(200, {"Content-Type": "application/x-debian-package"});
    return Promise.resolve(stream()).then(stream => stream.pipe(res));
  });

  // dist
  // Signed Release with gpg
  // app.get("/dists/:suite/InRelease", (req, res) => {});
  app.get("/dists/:package/Release", (req, res) => {
    if (!mainRegister.packageRegister[req.params.package]) return res.status(404).json({error: "Package not registred"});
    const Archs: string[] = [];
    Object.keys(mainRegister.packageRegister[req.params.package]).forEach(version => Object.keys(mainRegister.packageRegister[req.params.package][version]).forEach(arch => (!Archs.includes(arch.toLowerCase()))?Archs.push(arch.toLowerCase()):null));
    const data = utils.mountRelease({
      Origin: "node_apt",
      Suite: req.params.package,
      Components: ["main"],
      Architectures: Archs
    });
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Length", data.length);
    return res.send(data);
  });
  app.get("/dists/:package/main/binary-:arch/Release", (req, res) => {
    const Archs: string[] = [];
    Object.keys(mainRegister.packageRegister[req.params.package]).forEach(version => Object.keys(mainRegister.packageRegister[req.params.package][version]).forEach(arch => (!Archs.includes(arch.toLowerCase()))?Archs.push(arch.toLowerCase()):null));
    if (!Archs.includes(req.params.arch.toLowerCase())) return res.status(404).json({error: "Package arch registred"});
    res.setHeader("Content-Type", "text/plain");
    return res.send(utils.mountRelease({
      Origin: "node_apt",
      Archive: req.params.package,
      Components: ["main"],
      Architectures: [req.params.arch.toLowerCase()],
    }));
  });

  app.get("/dists/:package/main/binary-:arch/Packages.gz", async (req, res) => {
    const packagesConfig: utils.packageGzObject[] = [];
    Object.keys(mainRegister.packageRegister[req.params.package]).forEach(version => Object.keys(mainRegister.packageRegister[req.params.package][version]).forEach(arch => {
      const data = mainRegister.packageRegister[req.params.package][version][arch];
      if (!data) return;
      packagesConfig.push({
        ...data.config as any as utils.packageGzObject,
        Filename: format("pool/%s/%s/%s.deb", data.config.Package, data.config.Version, data.config.Architecture),
        SHA256: data.signature.sha256,
        MD5sum: data.signature.md5,
        InstalledSize: data.size,
      });
    }));
    res.writeHead(200, {
      "Content-Type": "application/x-gzip"
    });
    await utils.createPackagegz(res, packagesConfig);
  });


  app.get("/dists/:package/main/binary-:arch/Packages", async (req, res) => {
    const packagesConfig: utils.packageGzObject[] = [];
    Object.keys(mainRegister.packageRegister[req.params.package]).forEach(version => Object.keys(mainRegister.packageRegister[req.params.package][version]).forEach(arch => {
      const data = mainRegister.packageRegister[req.params.package][version][arch];
      if (!data) return;
      packagesConfig.push({
        ...data.config as any as utils.packageGzObject,
        Filename: format("pool/%s/%s/%s.deb", data.config.Package, data.config.Version, data.config.Architecture),
        SHA256: data.signature.sha256,
        MD5sum: data.signature.md5,
        InstalledSize: data.size,
      });
    }));
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });
    for (const packageInfo of packagesConfig) {
      let packageData = ["package: "+packageInfo.Package];
      packageData.push("Version: "+packageInfo.Version);
      packageData.push("Filename: "+packageInfo.Filename);
      packageData.push("Maintainer: "+packageInfo.Maintainer);
      packageData.push("Architecture: "+packageInfo.Architecture);
      if (packageInfo.InstalledSize) packageData.push("Installed-Size: "+packageInfo.InstalledSize);
      if (packageInfo.Depends) packageData.push("Depends: "+packageInfo.Depends);
      packageData.push("MD5sum: "+packageInfo.MD5sum);
      packageData.push("SHA256: "+packageInfo.SHA256);

      res.write(packageData.join("\n")+"\n\n");
    }
    res.end();
  });

  app.listen(3000, callback);
  return app;
}

createAPI(process.cwd()+"/repoconfig.yml", 3000).catch(console.error);
