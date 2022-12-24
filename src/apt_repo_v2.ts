import { DebianPackage, httpRequestGithub, extendsCrypto, httpRequest } from "@sirherobrine23/coreutils";
import { Compressor as lzmaCompressor } from "lzma-native";
import { getConfig, repository } from "./repoConfig.js";
import { Readable, Writable } from "node:stream";
import { createGzip } from "node:zlib";
import { CronJob } from "cron";
import { watchFile } from "node:fs";
import express from "express";
import openpgp from "openpgp";
import { format } from "node:util";

type packageRegistry = {
  [packageName: string]: {
    repositoryConfig: repository,
    arch: {
      [arch: string]: {
        [version: string]: {
          getStream: () => Promise<Readable>,
          control: DebianPackage.debianControl,
          suite?: string,
        }
      }
    }
  }
};

export default async function main(configPath: string) {
  let repositoryConfig = await getConfig(configPath);
  // watch config file changes
  watchFile(configPath, async () => repositoryConfig = await getConfig(configPath));
  const app = express();
  app.disable("x-powered-by").disable("etag").use(express.json()).use(express.urlencoded({ extended: true })).use((req, _res, next) => {
    next();
    return console.log("%s %s %s", req.method, req.ip, req.path);
  });

  // Public key
  app.get("/public_key", async ({res}) => {
    const Key = repositoryConfig["apt-config"]?.pgpKey;
    if (!Key) return res.status(400).json({error: "This repository no sign Packages files"});
    const pubKey = (await openpgp.readKey({ armoredKey: Key.public })).armor();
    return res.setHeader("Content-Type", "application/pgp-keys").send(pubKey);
  });

  // Sources list
  app.get("/source_list", (req, res) => {
    let source = "";
    const host = repositoryConfig["apt-config"]?.sourcesHost ?? `${req.protocol}://${req.hostname}:${req.socket.localPort}`;
    for (const repo in packInfos) {
      if (source) source += "\n";
      const suites = packInfos[repo].repositoryConfig?.["apt-config"]?.suite ?? ["main"];
      if (suites.length === 0) suites.push("main");
      let extraConfig = "";
      if (!repositoryConfig["apt-config"]?.pgpKey) extraConfig += " [trusted=yes]";
      source += format("deb%s %s %s", extraConfig ? " "+extraConfig:"", host, repo, suites.join(""));
    }
    source += "\n";
    return res.setHeader("Content-Type", "text/plain").send(source);
  });

  // Packages info
  const packInfos: packageRegistry = {};
  app.get("/", (_req, res) => res.json(packInfos));

  // Download
  app.get("/pool/:packageName/:arch/:version/download.deb", async (req, res) => {
    const packageobject = packInfos[req.params.packageName];
    if (!packageobject) throw new Error("Package not found");
    const arch = packageobject.arch[req.params.arch];
    if (!arch) throw new Error("Arch not found");
    const version = arch[req.params.version];
    if (!version) throw new Error("Version not found");
    const {getStream} = version;
    if (!getStream) throw new Error("Stream not found");
    return getStream().then(stream => stream.pipe(res.writeHead(200, {
      "Content-Type": "application/vnd.debian.binary-package",
      "Content-Length": version.control.Size,
      "Content-MD5": version.control.MD5sum,
      "Content-SHA1": version.control.SHA1,
      "Content-SHA256": version.control.SHA256,
    })));
  });
  app.get("/pool/:packageName/:arch/:version", async (req, res) => {});
  app.get("/pool/:packageName/:arch", async (req, res) => {});
  app.get("/pool/:packageName", async (req, res) => {});

  async function createPackages(compress?: "gzip" | "xz", options?: {writeStream?: Writable, package?: string, arch?: string, suite?: string}) {
    const rawWrite = new Readable({read(){}});
    let size = 0;
    let hash: ReturnType<typeof extendsCrypto.createHashAsync>|undefined;
    if (compress === "gzip") {
      const gzip = rawWrite.pipe(createGzip({level: 9}));
      if (options?.writeStream) gzip.pipe(options.writeStream);
      hash = extendsCrypto.createHashAsync("all", gzip);
      gzip.on("data", (chunk) => size += chunk.length);
    } else if (compress === "xz") {
      const lzma = rawWrite.pipe(lzmaCompressor());
      if (options?.writeStream) lzma.pipe(options.writeStream);
      hash = extendsCrypto.createHashAsync("all", lzma);
      lzma.on("data", (chunk) => size += chunk.length);
    } else {
      if (options?.writeStream) rawWrite.pipe(options.writeStream);
      hash = extendsCrypto.createHashAsync("all", rawWrite);
      rawWrite.on("data", (chunk) => size += chunk.length);
    }

    let addbreak = false;
    for (const packageName in packInfos) {
      if (options?.package && packageName !== options.package) continue;
      const packageobject = packInfos[packageName];
      for (const arch in packageobject.arch) {
        if (options?.arch && arch !== options.arch) continue;
        for (const version in packageobject.arch[arch]) {
          if (addbreak) rawWrite.push("\n\n");
          addbreak = true;
          const {control} = packageobject.arch[arch][version];
          /*
          Package: hello-world
          Version: 0.0.1
          Architecture: amd64
          Maintainer: example <example@example.com>
          Depends: libc6
          Filename: pool/main/hello-world_0.0.1-1_amd64.deb
          Size: 2832
          MD5sum: 3eba602abba5d6ea2a924854d014f4a7
          SHA1: e300cabc138ac16b64884c9c832da4f811ea40fb
          SHA256: 6e314acd7e1e97e11865c11593362c65db9616345e1e34e309314528c5ef19a6
          Homepage: http://example.com
          Description: A program that prints hello
          */
          const Data = [
            `Package: ${packageName}`,
            `Version: ${version}`,
            `Architecture: ${arch}`,
            `Maintainer: ${control.Maintainer}`,
            `Depends: ${control.Depends}`,
            `Size: ${control.Size}`,
            `MD5sum: ${control.MD5sum}`,
            `SHA1: ${control.SHA1}`,
            `SHA256: ${control.SHA256}`,
          ];

          Data.push(`Filename: pool/${packageName}/${arch}/${version}/download.deb`);
          if (control.Homepage) Data.push(`Homepage: ${control.Homepage}`);
          if (control.Description) Data.push(`Description: ${control.Description}`);

          // Register
          rawWrite.push(Data.join("\n"));
        }
      }
    }

    rawWrite.push(null);
    if (hash) return hash.then(hash => ({...hash, size}));
    return null;
  }

  app.get("/dists/:dist/:suite/binary-:arch/Packages(.(xz|gz)|)", (req, res) => {
    if (req.path.endsWith(".gz")) {
      createPackages("gzip", {
        package: req.params.dist,
        arch: req.params.arch,
        suite: req.params.suite,
        writeStream: res.writeHead(200, {
          "Content-Encoding": "gzip",
          "Content-Type": "application/x-gzip"
        }),
      });
    } else if (req.path.endsWith(".xz")) {
      createPackages("xz", {
        package: req.params.dist,
        arch: req.params.arch,
        suite: req.params.suite,
        writeStream: res.writeHead(200, {
          "Content-Encoding": "xz",
          "Content-Type": "application/x-xz"
        }),
      });
    } else {
      createPackages(undefined, {
        package: req.params.dist,
        arch: req.params.arch,
        suite: req.params.suite,
        writeStream: res.writeHead(200, {
          "Content-Type": "text/plain"
        }),
      });
    }
  });

  // Release
  async function createReleaseV1(dist: string) {
    const packageobject = packInfos[dist];
    if (!packageobject) throw new Error("Dist not found");
    const ReleaseLines = [];

    // Origin
    const Origin = packageobject.repositoryConfig["apt-config"]?.origin || repositoryConfig["apt-config"]?.origin || "apt-stream";
    ReleaseLines.push(`Origin: ${Origin}`);

    // Lebel
    const Label = packageobject.repositoryConfig["apt-config"]?.label || repositoryConfig["apt-config"]?.label || "apt-stream";
    ReleaseLines.push(`Label: ${Label}`);

    // Suite
    const Suites = packageobject.repositoryConfig["apt-config"]?.suite || repositoryConfig["apt-config"]?.suite || ["main"];
    if (Suites.length === 0) Suites.push("main");

    // Codename if exists
    const codename = packageobject.repositoryConfig["apt-config"]?.codename || repositoryConfig["apt-config"]?.codename;
    if (codename) ReleaseLines.push(`Codename: ${codename}`);

    // Date
    ReleaseLines.push(`Date: ${new Date().toUTCString()}`);

    // Architectures
    const archs = Object.keys(packageobject.arch);
    ReleaseLines.push(`Architectures: ${archs.join(" ")}`);

    const createPackagesHash = packageobject.repositoryConfig["apt-config"]?.enableHash ?? repositoryConfig["apt-config"]?.enableHash ?? true;
    if (createPackagesHash) {
      const sha256: {file: string, size: number, hash: string}[] = [];
      const sha1: {file: string, size: number, hash: string}[] = [];
      const md5: {file: string, size: number, hash: string}[] = [];

      for (const arch of archs) {
        for (const Suite of Suites) {
          const gzip = await createPackages("gzip", {package: dist, arch, suite: Suite});
          if (gzip) {
            sha256.push({file: `${Suite}/binary-${arch}/Packages.gz`, size: gzip.size, hash: gzip.sha256});
            sha1.push({file: `${Suite}/binary-${arch}/Packages.gz`, size: gzip.size, hash: gzip.sha1});
            md5.push({file: `${Suite}/binary-${arch}/Packages.gz`, size: gzip.size, hash: gzip.md5});
          }
          const xz = await createPackages("xz", {package: dist, arch, suite: Suite});
          if (xz) {
            sha256.push({file: `${Suite}/binary-${arch}/Packages.xz`, size: xz.size, hash: xz.sha256});
            sha1.push({file: `${Suite}/binary-${arch}/Packages.xz`, size: xz.size, hash: xz.sha1});
            md5.push({file: `${Suite}/binary-${arch}/Packages.xz`, size: xz.size, hash: xz.md5});
          }
          const raw = await createPackages(undefined, {package: dist, arch, suite: Suite});
          if (raw) {
            sha256.push({file: `${Suite}/binary-${arch}/Packages`, size: raw.size, hash: raw.sha256});
            sha1.push({file: `${Suite}/binary-${arch}/Packages`, size: raw.size, hash: raw.sha1});
            md5.push({file: `${Suite}/binary-${arch}/Packages`, size: raw.size, hash: raw.md5});
          }
        }
      }

      if (sha256.length > 0) ReleaseLines.push(`SHA256:${sha256.map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);
      if (sha1.length > 0) ReleaseLines.push(`SHA1:${sha1.map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);
      if (md5.length > 0) ReleaseLines.push(`MD5Sum:${md5.map((hash) => `\n  ${hash.hash} ${hash.size} ${hash.file}`).join("")}`);
    }

    return ReleaseLines.join("\n");
  }
  app.get("/dists/:dist/Release", (req, res, next) => createReleaseV1(req.params.dist).then((data) => res.setHeader("Content-Type", "text/plain").send(data)).catch(next));
  app.get("/dists/:dist/InRelease", async (req, res) => {
    const Key = repositoryConfig["apt-config"]?.pgpKey;
    if (!Key) return res.status(404).json({error: "No PGP key found"});
    // const publicKey = await openpgp.readKey({ armoredKey: Key.public });
    const privateKey = Key.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: Key.private }), passphrase: Key.passphrase}) : await openpgp.readPrivateKey({ armoredKey: Key.private });
    const Release = await createReleaseV1(req.params.dist);
    return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
      signingKeys: privateKey,
      format: "armored",
      message: await openpgp.createCleartextMessage({text: Release}),
    }));
  });
  app.get("/dists/:dist/Release.gpg", async (req, res) => {
    const Key = repositoryConfig["apt-config"]?.pgpKey;
    if (!Key) return res.status(404).json({error: "No PGP key found"});
    // const publicKey = await openpgp.readKey({ armoredKey: Key.public });
    const privateKey = Key.passphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: Key.private }), passphrase: Key.passphrase}) : await openpgp.readPrivateKey({ armoredKey: Key.private });
    const Release = await createReleaseV1(req.params.dist);
    return res.setHeader("Content-Type", "text/plain").send(await openpgp.sign({
      signingKeys: privateKey,
      message: await openpgp.createMessage({text: Release}),
    }));
  });

  // Error handler
  app.use((err, _req, res, _next) => {
    res.status(500).json({error: err?.message||err});
  });

  // Listen HTTP server
  app.listen(repositoryConfig["apt-config"].portListen, function () {return console.log(`apt-repo listening at http://localhost:${this.address().port}`);});

  // Loading and update packages
  for (const repository of repositoryConfig.repositories) {
    try {
      if (repository.from === "github_release") {
        const update = async () => {
          const relData = repository.tags ? await Promise.all(repository.tags.map(async (tag) => httpRequestGithub.GithubRelease({repository: repository.repository, owner: repository.owner, token: repository.token, releaseTag: tag}))) : await httpRequestGithub.GithubRelease({repository: repository.repository, owner: repository.owner, token: repository.token});
          const assets = relData.flat().map((rel) => rel.assets).flat().filter((asset) => asset.name.endsWith(".deb")).flat();

          for (const asset of assets) {
            const getStream = () => httpRequest.pipeFetch(asset.browser_download_url);
            const control = await DebianPackage.extractControl(await getStream());
            if (!packInfos[control.Package]) packInfos[control.Package] = {repositoryConfig: repository, arch: {}};
            if (!packInfos[control.Package].arch[control.Architecture]) packInfos[control.Package].arch[control.Architecture] = {}
            packInfos[control.Package].arch[control.Architecture][control.Version] = {control, getStream};
          }
        }
        await update();
        (repository.cronRefresh ?? []).map((cron) => {
          const job = new CronJob(cron, update);
          job.start();
          return job;
        });
      } else if (repository.from === "oci") {

      }
    } catch (e) {
      console.error(e);
    }
  }
}