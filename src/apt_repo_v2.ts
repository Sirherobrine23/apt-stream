import { Readable } from "node:stream";
import { extendsCrypto } from "@sirherobrine23/coreutils";
import { format } from "node:util";
import * as lzma from "lzma-native";
import express from "express";
import zlib from "node:zlib";
import { packageControl } from "./deb.js";

type registerOobject = {
  [packageName: string]: {
    getStream: () => Promise<Readable>,
    control: packageControl,
    from?: string,
  }[]
};

export function packageManeger(RootOptions?: {origin?: string, lebel?: string}) {
  const localRegister: registerOobject = {};
  function pushPackage(control: packageControl, getStream: () => Promise<Readable>, from?: string) {
    if (!localRegister[control.Package]) localRegister[control.Package] = [];
    localRegister[control.Package].push({
      getStream,
      control,
      from,
    });
  }

  function getPackages() {
    return localRegister;
  }

  async function createPackages(options?: {packageName?: string, Arch?: string}, streams?: (data: {gz: zlib.Gzip, xz: lzma.JSLzmaStream, raw: Readable}) => void) {
    if (options?.packageName === "all") options.packageName = undefined;
    const sizes = {gz: 0, xz: 0, raw: 0};
    const raw = new Readable();
    const rawHASH = extendsCrypto.createSHA256_MD5(raw, "both", new Promise(resolve => raw.on("end", resolve)));
    raw.on("data", chunck => sizes.raw += chunck.length);
    const gz = raw.pipe(zlib.createGzip());
    const gzHASH = extendsCrypto.createSHA256_MD5(gz, "both", new Promise(resolve => gz.on("end", resolve)));
    gz.on("data", chunck => sizes.gz += chunck.length);
    const xz = raw.pipe(lzma.createCompressor());
    const xzHASH = extendsCrypto.createSHA256_MD5(xz, "both", new Promise(resolve => xz.on("end", resolve)));
    xz.on("data", chunck => sizes.xz += chunck.length);
    if (streams) streams({gz, xz, raw});

    const writeObject = (packageData: (typeof localRegister)[string][number]) => {
      const control = packageData.control;
      control.Filename = format("pool/%s/%s/%s.deb", control.Package, control.Architecture, control.Version);
      const desc = control.Description;
      delete control.Description;
      control.Description = desc;
      const data = Buffer.from(Object.keys(control).map(key => `${key}: ${control[key]}`).join("\n") + "\n\n", "utf8");
      raw.push(data);
    }

    if (!!options?.packageName) {
      const packageVersions = localRegister[options?.packageName];
      if (!packageVersions) {
        raw.push(null);
        raw.destroy();
        throw new Error("Package not found");
      }
      for (const packageData of packageVersions) {
        if (options?.Arch && packageData.control.Architecture !== options?.Arch) continue;
        writeObject(packageData);
      }
    } else {
      for (const packageName in localRegister) {
        for (const packageData of localRegister[packageName]) {
          if (options?.Arch && packageData.control.Architecture !== options?.Arch) continue;
          writeObject(packageData);
        }
      }
    }

    raw.push(null);
    // raw.end();
    // raw.destroy();

    return {
      raw: {
        ...(await rawHASH),
        size: sizes.raw,
      },
      gz: {
        ...(await gzHASH),
        size: sizes.gz,
      },
      xz: {
        ...(await xzHASH),
        size: sizes.xz,
      }
    };
  }

  async function createRelease(options?: {packageName?: string, Arch?: string, includesHashs?: boolean}) {

    const textLines = [
      `Lebel: ${RootOptions?.lebel||"node-apt"}`,
      `Date: ${new Date().toUTCString()}`
    ];

    if (options?.packageName) {
      const packageData = localRegister[options?.packageName];
      if (!packageData) throw new Error("Package not found");
      const archs = [...(new Set(localRegister[options?.packageName].map((p) => p.control.Architecture)))];
      const components = [...(new Set(localRegister[options?.packageName].map((p) => p.control.Section||"main")))];
      textLines.push(`Suite: ${options?.packageName}`);
      textLines.push(`Architectures: ${archs.filter(arch => !options?.Arch ? true : arch === options?.Arch).join(" ")}`);
      textLines.push(`Components: ${components.join(" ")}`);
      if (options?.includesHashs) {
        const Hashs = await createPackages({packageName: options?.packageName});
        textLines.push(`MD5Sum:`);
        textLines.push(`  ${Hashs.raw.md5}  ${Hashs.raw.size}  main/binary-${options?.Arch||"all"}/Packages`);
        textLines.push(`  ${Hashs.xz.md5}  ${Hashs.xz.size}  main/binary-${options?.Arch||"all"}/Packages.xz`);
        textLines.push(`  ${Hashs.gz.md5}  ${Hashs.gz.size}  main/binary-${options?.Arch||"all"}/Packages.gz`);
        textLines.push(`SHA256:`);
        textLines.push(`  ${Hashs.raw.sha256}  ${Hashs.raw.size}  main/binary-${options?.Arch||"all"}/Packages`);
        textLines.push(`  ${Hashs.xz.sha256}  ${Hashs.xz.size}  main/binary-${options?.Arch||"all"}/Packages.xz`);
        textLines.push(`  ${Hashs.gz.sha256}  ${Hashs.gz.size}  main/binary-${options?.Arch||"all"}/Packages.gz`);
      }
    } else {
      // For all packages
      // const archs = [...(new Set(Object.values(localRegister).flat().map((p) => p.control.Architecture)))];
      // textLines.push(`Suite: ${options?.packageName}`);
      // textLines.push(`Architectures: ${archs.filter(arch => !options?.Arch ? true : arch === options?.Arch).join(" ")}`);
      // textLines.push("Components: main");
      // if (options?.includesHashs) {
      //   const Hashs = await createPackages();
      //   textLines.push(`MD5Sum:`);
      //   textLines.push(`  ${Hashs.raw.md5}  ${Hashs.raw.size}  main/binary-${options?.Arch||"all"}/Packages`);
      //   textLines.push(`  ${Hashs.xz.md5}  ${Hashs.xz.size}  main/binary-${options?.Arch||"all"}/Packages.xz`);
      //   textLines.push(`  ${Hashs.gz.md5}  ${Hashs.gz.size}  main/binary-${options?.Arch||"all"}/Packages.gz`);
      //   textLines.push(`SHA256:`);
      //   textLines.push(`  ${Hashs.raw.sha256}  ${Hashs.raw.size}  main/binary-${options?.Arch||"all"}/Packages`);
      //   textLines.push(`  ${Hashs.xz.sha256}  ${Hashs.xz.size}  main/binary-${options?.Arch||"all"}/Packages.xz`);
      //   textLines.push(`  ${Hashs.gz.sha256}  ${Hashs.gz.size}  main/binary-${options?.Arch||"all"}/Packages.gz`);
      // }
      throw new Error("Not implemented");
    }
    textLines.push("\n");
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

export default async function repo(aptConfig: {}) {
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

  app.get("/sources.list", (req, res) => {
    res.setHeader("Content-type", "text/plain");
    let config = "";
    if (req.query.all) config += format("deb [trusted=yes] %s://%s %s main\n", req.protocol, req.headers.host, "all");
    else {
      for (const suite of Object.keys(registry.getPackages())) {
        config += format("deb [trusted=yes] %s://%s %s main\n", req.protocol, req.headers.host, suite);
      }
    }
    res.send(config+"\n");
  });

  // apt /dists
  // release
  app.get("/dists/:suite/InRelease", (_req, res) => res.status(400).json({error: "Not implemented, required pgp to auth"}));
  app.get("/dists/:suite/Release", (req, res, next) => {
    const { suite } = req.params;
    res.setHeader("Content-Type", "text/plain");
    return registry.createRelease({packageName: suite === "all"?undefined:suite, includesHashs: true}).then((release) => res.send(release)).catch(next);
  });

  // Components
  app.get("/dists/:suite/:component/binary-:arch/Packages(.(gz|xz)|)", (req, res, next) => {
    const {suite, arch} = req.params;
    registry.createPackages({packageName: suite, Arch: arch}, (streamers) => {
      if (req.path.endsWith(".gz")) {
        streamers.gz.pipe(res.writeHead(200, {"Content-Encoding": "application/x-gzip"}));
      } else if (req.path.endsWith(".xz")) {
        streamers.xz.pipe(res.writeHead(200, {"Content-Encoding": "application/x-xz"}));
      } else {
        streamers.raw.pipe(res.writeHead(200, {"Content-Encoding": "text/plain"}));
      }
    }).catch(next);
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