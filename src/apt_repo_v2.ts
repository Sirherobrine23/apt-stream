import { packageControl } from "./deb.js";
import { extendsCrypto } from "@sirherobrine23/coreutils";
import { PassThrough, Readable } from "node:stream";
import { format } from "node:util";
import { Compressor as lzmaCompress } from "lzma-native";
import { backendConfig } from "./repoConfig.js";
import express from "express";
import zlib from "node:zlib";

type registerOobject = {
  [packageName: string]: {
    getStream: () => Promise<Readable>,
    control: packageControl,
    from?: string,
  }[]
};

export function packageManeger(RootOptions?: backendConfig) {
  const localRegister: registerOobject = {};
  function pushPackage(control: packageControl, getStream: () => Promise<Readable>, from?: string) {
    if (!localRegister[control.Package]) localRegister[control.Package] = [];
    console.log("Register %s/%s-5s", control.Package, control.Version, control.Architecture);
    localRegister[control.Package].push({
      getStream,
      control,
      from,
    });
  }

  function getPackages() {
    return localRegister;
  }

  function createPackages(options?: {packageName?: string, Arch?: string}) {
    if (options?.packageName === "all") options.packageName = undefined;
    const raw = new PassThrough();
    const gz = raw.pipe(zlib.createGzip());
    const xz = raw.pipe(lzmaCompress());

    const writeObject = async (packageData: (typeof localRegister)[string][number]) => {
      const control = packageData.control;
      control.Filename = format("pool/%s/%s/%s.deb", control.Package, control.Architecture, control.Version);
      const desc = control.Description;
      delete control.Description;
      control.Description = (desc?.split("\n") ?? [])[0];
      if (!control.Description) control.Description = "No description";
      let line = "";
      Object.keys(control).forEach(key => line += (`${key}: ${control[key]}\n`));
      raw.push(Buffer.from(line+"\n", "utf8"));
    }

    async function getStart() {
      if (!!options?.packageName) {
        const packageVersions = localRegister[options?.packageName];
        if (!packageVersions) {
          raw.push(null);
          raw.destroy();
          throw new Error("Package not found");
        }
        for (const packageData of packageVersions) {
          if (options?.Arch && packageData.control.Architecture !== options?.Arch) continue;
          await writeObject(packageData);
        }
      } else {
        for (const packageName in localRegister) {
          for (const packageData of localRegister[packageName]) {
            if (options?.Arch && packageData.control.Architecture !== options?.Arch) continue;
            await writeObject(packageData);
          }
        }
      }
      raw.push(null);
      raw.end();
    }
    return {
      getStart,
      raw,
      gz,
      xz,
    };
  }

  async function packageHASH(options?: {packageName?: string, Arch?: string}) {
    return new Promise<{raw: {md5: string, sha256: string, size: number}, gz: {md5: string, sha256: string, size: number}, xz: {md5: string, sha256: string, size: number}}>(async (resolve, reject) => {
      const strems = createPackages(options);
      const size = {
        raw: 0,
        gz: 0,
        xz: 0,
      };
      const raw = extendsCrypto.createSHA256_MD5(strems.raw, "both");
      const gz = extendsCrypto.createSHA256_MD5(strems.gz, "both", new Promise((resolve) => {
        strems.gz.on("end", resolve);
      }));
      const xz = extendsCrypto.createSHA256_MD5(strems.xz, "both", new Promise((resolve) => {
        strems.xz.on("end", resolve).on("error", reject);
      }))
      strems.raw.on("data", (data) => size.raw += data.length);
      strems.gz.on("data", (data) => size.gz += data.length);
      strems.xz.on("data", (data) => size.xz += data.length);
      strems.getStart().catch(reject);
      const rawHash = await raw;
      const gzHash = await gz;
      const xzHash = await xz;
      resolve({
        raw: {
          md5: rawHash.md5,
          sha256: rawHash.sha256,
          size: size.raw,
        },
        gz: {
          md5: gzHash.md5,
          sha256: gzHash.sha256,
          size: size.gz,
        },
        xz: {
          md5: xzHash.md5,
          sha256: xzHash.sha256,
          size: size.xz,
        },
      });
    });
  }

  async function createRelease(options?: {packageName?: string, Arch?: string, includesHashs?: boolean, component?: string[], archive?: string}) {
    const textLines = [];
    if (RootOptions?.aptConfig?.origin) textLines.push(`Origin: ${RootOptions.aptConfig.origin}`);
    if (options?.archive) textLines.push(`Archive: ${options?.archive}`);
    else textLines.push(`Lebel: ${RootOptions?.aptConfig?.label||"node-apt"}`, `Date: ${new Date().toUTCString()}`);
    const components = options?.component ?? ["main"];
    const archs: string[] = [];

    if (options?.packageName) {
      const packageData = localRegister[options?.packageName];
      if (!packageData) throw new Error("Package not found");
      textLines.push(`Suite: ${options?.packageName}`);
      archs.push(...([...(new Set(localRegister[options?.packageName].map((p) => p.control.Architecture)))]).filter(arch => (options?.Arch === "all"||!options?.Arch) ? true : arch === options.Arch));
    } else {
      // For all packages
      archs.push(...(([...(new Set(Object.values(localRegister).flat().map((p) => p.control.Architecture)))]).filter(arch => (options?.Arch === "all"||!options?.Arch) ? true : arch === options.Arch)));
      textLines.push("Suite: all");
    }

    textLines.push(`Components: ${options?.archive ? components[0] : components.join(" ")}`, `Architectures: ${archs.join(" ")}`);
    if (options?.includesHashs && !options?.archive) {
      const arrayComponents = [];
      for (const component of components) {
        for (const arch of archs) {
          arrayComponents.push({
            component,
            arch,
          });
        }
      }
      const DataHashs = await Promise.all(arrayComponents.map(async (data) => {
        return {
          ...data,
          hash: await packageHASH({
            packageName: options?.packageName,
          })
        };
      }));
      textLines.push(`MD5Sum:`);
      DataHashs.forEach(data => {
        textLines.push(`  ${data.hash.raw.md5}  ${data.hash.raw.size}  ${data.component}/binary-${data.arch}/Packages`);
        textLines.push(`  ${data.hash.gz.md5}  ${data.hash.gz.size}  ${data.component}/binary-${data.arch}/Packages.gz`);
        textLines.push(`  ${data.hash.xz.md5}  ${data.hash.xz.size}  ${data.component}/binary-${data.arch}/Packages.xz`);
      });
      textLines.push(`SHA256:`);
      DataHashs.forEach(data => {
        textLines.push(`  ${data.hash.raw.sha256}  ${data.hash.raw.size}  ${data.component}/binary-${data.arch}/Packages`);
        textLines.push(`  ${data.hash.gz.sha256}  ${data.hash.gz.size}  ${data.component}/binary-${data.arch}/Packages.gz`);
        textLines.push(`  ${data.hash.xz.sha256}  ${data.hash.xz.size}  ${data.component}/binary-${data.arch}/Packages.xz`);
      });
    }
    textLines.push("");
    // convert to string
    return textLines.join("\n");
  }

  return {
    getPackages,
    pushPackage,
    createRelease,
    createPackages,
  };
}

export default async function repo(aptConfig?: backendConfig) {
  const app = express();
  const registry = packageManeger();
  app.disable("x-powered-by").disable("etag").use(express.json()).use(express.urlencoded({extended: true})).use((_req, res, next) => {
    res.json = (data) => res.setHeader("Content-Type", "application/json").send(JSON.stringify(data, null, 2));
    next();
  }).use((req, _res, next) => {
    next();
    return console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  });

  app.get("/", (_req, res) => res.json(registry.getPackages()));
  app.get("/pool/:package/:arch/:version.deb", async (req, res) => {
    const { package: packageName, arch, version } = req.params;
    const packageData = registry.getPackages()[packageName];
    if (!packageData) return res.status(404).json({error: "Package not found"});
    const packageArch = packageData.filter((p) => p.control.Architecture === arch);
    if (packageArch.length === 0) return res.status(404).json({error: "Package not found with the arch"});
    const versionData = packageArch.find((p) => p.control.Version === version);
    if (!versionData) return res.status(404).json({error: "Package not found with the version"});
    if (!req.path.endsWith(".deb")) return res.json(versionData);
    const stream = await versionData.getStream();
    return stream.pipe(res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": versionData.control.Size,
    }));
  });

  app.get("/sources.list", (req, res) => {
    const host = (req.socket.localPort && req.hostname) ? req.hostname+":"+req.socket.localPort : req.query.host||req.headers["x-forwarded-host"]||req.headers.host;
    let Targets = ((req.query.t||req.query.targets) ?? ["all"]) as string[]|string;
    if (typeof Targets === "string") Targets = Targets.split(",");
    if (Targets?.length === 0) Targets = ["all"];
    if (Targets?.includes("all")||Targets.some(a => a.toLowerCase().trim() === "all")) Targets = ["all"];
    if (!Targets) Targets = ["all"];
    res.setHeader("Content-type", "text/plain");
    let config = "";
    for (const target of Targets) config += format(aptConfig?.aptConfig?.sourcesList ?? "deb [trusted=yes] %s://%s %s main\n", req.protocol, host, target);
    res.send(config+"\n");
  });

  // apt /dists
  // release
  app.get("/dists/:suite/InRelease", (_req, res) => res.status(400).json({error: "Not implemented, required pgp to auth"}));
  app.get("/dists/:suite/Release", (req, res, next) => {
    const { suite } = req.params;
    res.setHeader("Content-Type", "text/plain");
    return registry.createRelease({
      includesHashs: true,
      packageName: suite === "all"?undefined:suite,
    }).then((release) => res.send(release)).catch(next);
  });

  // Components
  app.get("/dists/:suite/:component/binary-:arch/Release", (req, res, next) => {
    const { suite, arch } = req.params;
    res.setHeader("Content-Type", "text/plain");
    return registry.createRelease({
      includesHashs: aptConfig?.aptConfig?.enableHash ?? true,
      Arch: arch,
      packageName: suite === "all" ? undefined : suite,
      component: [req.params.component],
      archive: req.params.component,
    }).then((release) => res.send(release)).catch(next);
  });
  app.get("/dists/:suite/:component/binary-:arch/Packages(.(gz|xz)|)", (req, res, next) => {
    const {suite, arch} = req.params;
    const streams = registry.createPackages({packageName: suite, Arch: arch});
    if (req.path.endsWith(".gz")) {
      streams.gz.pipe(res.writeHead(200, {
        "Content-Type": "application/x-gzip",
      }));
    } else if (req.path.endsWith(".xz")) {
      streams.xz.pipe(res.writeHead(200, {
        "Content-Type": "application/x-xz",
      }));
    } else {
      streams.raw.pipe(res.writeHead(200, {
        "Content-Type": "text/plain",
      }));
    }
    return streams.getStart();
  });

  // No Page
  app.use((err, _req, res, _next) => {
    console.log("Error: %s, req path: %s", err?.message||err, _req.path);
    return res.status(500).json({
      error: err?.message||err
    });
  });

  return {
    app,
    registry,
  };
}