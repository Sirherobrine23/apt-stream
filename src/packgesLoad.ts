import { packageStorge, packagesFunctions } from "./packageStorage.js";
import { EventEmitter } from "node:events";
import { aptSConfig } from "./configManeger.js";
import coreUtils, { Debian } from "@sirherobrine23/coreutils";
import openpgp from "openpgp";
import path from "node:path";
import zlib from "node:zlib";
import lzma from "lzma-native";

export async function getFileStream(packageInfo: packageStorge): Promise<any> {
  const { repository, restore } = packageInfo;

  if (restore.from === "http") {
    const { url, headers, query } = restore;
    return coreUtils.http.streamRequest(url, {
      headers,
      query,
    });
  } else if (restore.from === "cloud") {
    const { info } = restore;
    if (repository.type === "google_driver") {
      const { app } = repository;
      const gDrive = await coreUtils.Cloud.GoogleDriver({
        clientID: app.id,
        clientSecret: app.secret,
        token: app.token,
        callback(err) {
          if (err) throw err;
          throw new Error("Invalid token");
        },
      });
      return gDrive.getFileStream(info);
    } else if (repository.type === "oracle_bucket") {
      const { authConfig } = repository;
      const oracleBucket = await coreUtils.Cloud.oracleBucket(authConfig);
      return oracleBucket.getFileStream(info);
    }
  }

  throw new TypeError("Invalid restore type");
}

export declare interface packagesLoad extends EventEmitter {
  on(event: "add", fn: (data: packageStorge) => void): this;
  once(event: "add", fn: (data: packageStorge) => void): this;

  on(event: "done", fn: () => void): this;
  once(event: "done", fn: () => void): this;
}

export function loadPackages(serverConfig: aptSConfig, packageStorage: packagesFunctions): packagesLoad {
  const event = new EventEmitter({captureRejections: true});
  (async function() {
    for (const reponame in serverConfig.repositorys) {
      const { aptConfig = {}, from: repositoryFrom = [] } = serverConfig.repositorys[reponame];
      for (const fromIndex in repositoryFrom) {
        const from = repositoryFrom[fromIndex];
        console.log(reponame, from, aptConfig);
        if (from.type === "http") {
          const { auth } = from;
          const data = await Debian.parsePackage(await coreUtils.http.streamRequest(from.url, {headers: auth.header, query: auth.query}));
          await packageStorage.addPackage(reponame, data.control, from, {
            from: "http",
            url: from.url,
            headers: auth.header,
            query: auth.query,
          }).then(data => event.emit("add", data)).catch(err => event.emit("error", err));
        } else if (from.type === "oracle_bucket") {
          let { path: cloudPath = [] } = from;
          const oracleBucket = await coreUtils.Cloud.oracleBucket(from.authConfig);
          if (!cloudPath.length) cloudPath = (await oracleBucket.listFiles()).map(file => file.path).filter(path => path.endsWith(".deb"));
          for (const remotePath of cloudPath) {
            const data = await Debian.parsePackage(await oracleBucket.getFileStream(remotePath));
            await packageStorage.addPackage(reponame, data.control, from, {
              from: "cloud",
              info: remotePath,
            }).then(data => event.emit("add", data)).catch(err => event.emit("error", err));
          }
        } else if (from.type === "google_driver") {
          let { id: fileIDs = [] } = from;
          const gDrive = await coreUtils.Cloud.GoogleDriver({
            clientID: from.app.id,
            clientSecret: from.app.secret,
            token: from.app.token,
            async callback(err, data) {
              if (err) event.emit("error", err);
              else if (data.authUrl) console.log("Open %O to auth google driver", data.authUrl);
              else if (data.token) {
                from.app.token = data.token;
                serverConfig.repositorys[reponame].from[fromIndex] = from;
                if (serverConfig.saveConfig) await serverConfig.saveConfig();
              }
            }
          });
          if (!fileIDs.length) fileIDs = (await gDrive.listFiles()).filter(file => file.name.endsWith(".deb")).map(file => file.id);
          for (const fileID of fileIDs) {
            const data = await Debian.parsePackage(await gDrive.getFileStream(fileID));
            await packageStorage.addPackage(reponame, data.control, from, {
              from: "cloud",
              info: fileID,
            }).then(data => event.emit("add", data)).catch(err => event.emit("error", err));
          }
        } else if (from.type === "github") {
          const { owner, repository, token, subType } = from;
          const github = await coreUtils.http.Github.GithubManeger(owner, repository, token);
          if (subType === "release") {
            const { tag } = from;
            const releases = await (tag?.length > 0 ? Promise.all(tag.map(async tag => github.getRelease(tag))).then(res => res.flat()) : github.getRelease());
            for (const release of releases) {
              for (const asset of release.assets) {
                const data = await Debian.parsePackage(await coreUtils.http.streamRequest(asset.browser_download_url));
                await packageStorage.addPackage(reponame, data.control, from, {
                  from: "http",
                  url: asset.browser_download_url,
                }).then(data => event.emit("add", data)).catch(err => event.emit("error", err));
              }
            }
          } else if (subType === "branch") {
            const { branch = (await github.branchList()).at(-1).name } = from;
            const tree = (await github.trees(branch)).tree.filter(file => file.path.endsWith(".deb"));
            for (const file of tree) {
              const raw = new URL("https://raw.githubusercontent.com");
              raw.pathname = path.posix.resolve("/", owner, repository, branch, file.path);
              const data = await Debian.parsePackage(await coreUtils.http.streamRequest(raw, {headers: token ? {Authorization: `token ${token}`} : {}}));
              await packageStorage.addPackage(reponame, data.control, from, {
                from: "http",
                url: raw.toString()
              }).then(data => event.emit("add", data)).catch(err => event.emit("error", err));
            }
          }
        } else if (from.type === "mirror") {
          const { url, dists } = from;
          for (const dist in dists) {
            const mirrorDists = dists[dist];
            const base = new URL(url);
            base.pathname = path.posix.resolve(base.pathname, "dists", dist, "Release");
            const Release = base.toString();
            base.pathname = path.posix.resolve(base.pathname, "../InRelease");
            const InRelease = base.toString();
            const data = await coreUtils.http.bufferRequest(Release).then(res => res.body).catch(() => coreUtils.http.bufferRequest(InRelease).then(async release => Buffer.from(((await openpgp.readCleartextMessage({cleartextMessage: release.body.toString()})).getText()), "utf8")));
            const Relase = Debian.apt.parseRelease(data);
            if (!Relase.Architectures) {
              const archs = Relase.Architectures as string[];
              if (!mirrorDists.archs?.length) mirrorDists.archs = archs;
              else mirrorDists.archs = mirrorDists.archs.filter((arch) => archs.includes(arch));
            }
            if (!Relase.Components) {
              const components = Relase.Components as string[];
              if (!mirrorDists.components?.length) mirrorDists.components = components;
              else mirrorDists.components = mirrorDists.components.filter((component) => components.includes(component));
            }

            for (const component of mirrorDists.components) {
              for (const arch of mirrorDists.archs) {
                const base = new URL(url);
                base.pathname = path.posix.resolve(base.pathname, "dists", dist, component, "binary-" + arch, "Packages");
                const Packages = base.toString();
                const packagesStream = await coreUtils.http.streamRequest(Packages).catch(() => coreUtils.http.streamRequest(Packages+".gz").then(res => res.pipe(zlib.createGunzip()))).catch(() => coreUtils.http.streamRequest(Packages+".xz").then(res => res.pipe(lzma.Decompressor())));
                const packages = await Debian.apt.parsePackages(packagesStream);
                for (const control of packages) {
                  const urlBase = new URL(url);
                  urlBase.pathname = path.posix.resolve(urlBase.pathname, control.Filename);
                  await packageStorage.addPackage(reponame, control, from, {
                    from: "http",
                    url: urlBase.toString(),
                  }).then(data => event.emit("add", data)).catch(err => event.emit("error", err));
                }
              }
            }
          }
        }
      }
    }
  })().catch(err => event.emit("error", err)).then(() => event.emit("done"));
  return event;
}