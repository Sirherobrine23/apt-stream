import * as Debian from "@sirherobrine23/debian";
import { v2 as dockerRegistry, Auth as dockerAuth, Utils as dockerUtils } from "@sirherobrine23/docker-registry";
import { packageData, packageManeger } from "./database.js";
import { googleDriver, oracleBucket } from "@sirherobrine23/cloud";
import { aptStreamConfig } from "./config.js";
import coreHttp, { Github } from "@sirherobrine23/http";
import stream from "stream";
import path from "node:path/posix";
import EventEmitter from "events";

export async function fileRestore(packageDb: packageData, repoConfig: aptStreamConfig): Promise<stream.Readable> {
  const repo = repoConfig.repository[packageDb.packageDistribuition];
  if (!repo) throw new Error("Sync repository package distribuition not more avaible in config!");
  const source = repo.source.find(s => s.id === packageDb.id);
  if (!source) throw new Error("Package Source no more avaible please sync packages!");

  if (source.type === "http") {
    const { url, auth: { header, query } } = source;
    return coreHttp.streamRequest(url, {headers: header, query});
  } else if (source.type === "github") {
    const { token } = source, { url } = packageDb.fileRestore;
    return coreHttp.streamRequest(url, {headers: token ? {"Authorization": "token "+token} : {}});
  } else if (source.type === "oracle_bucket") {
    const { authConfig } = source, { fileRestore: { path } } = packageDb;
    const bucket = await oracleBucket.oracleBucket(authConfig);
    return bucket.getFileStream(path);
  } else if (source.type === "google_driver") {
    const { clientId, clientSecret, clientToken } = source, { fileRestore: { id } } = packageDb;
    const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
    return gdrive.getFileStream(id);
  } else if (source.type === "docker") {
    const { image, auth } = source, { ref, path: debPath } = packageDb.fileRestore;
    const registry = new dockerRegistry(image, auth);
    return new Promise<stream.Readable>((done, reject) => registry.extractLayer(ref).then(tar => tar.on("error", reject).on("File", entry => entry.path === debPath ? done(entry as any) : null)));
  }
  throw new Error("Check package type");
}

export class syncRepository extends EventEmitter {
  constructor() {
    super({captureRejections: true});
  }

  on(event: "error", fn: (err: any) => void): this;
  on(event: "addPackage", fn: (data: Awaited<ReturnType<typeof packageManeger["prototype"]["addPackage"]>>) => void): this;
  on(event: string, fn: (...args: any[]) => void) {
    super.on(event, fn);
    return this;
  }

  async sync(packageManeger: packageManeger, config: aptStreamConfig, repository = Object.keys(config.repository)) {
    for (const repo of repository || Object.keys(config.repository)) {
      const source = config.repository[repo]?.source;
      if (!source) continue;
      for (const target of source) {
        const { id } = target;
        try {
          if (target.type === "http") {
            const { control } = await Debian.parsePackage(await coreHttp.streamRequest(target.url, {headers: target.auth?.header, query: target.auth?.query}));
            this.emit("addPackage", await packageManeger.addPackage(repo, target.componentName || "main", id, {}, control));
          } else if (target.type === "oracle_bucket") {
            const { authConfig, path = [] } = target;
            const bucket = await oracleBucket.oracleBucket(authConfig);
            if (path.length === 0) path.push(...((await bucket.listFiles()).filter(k => k.name.endsWith(".deb")).map(({name}) => name)));
            await Promise.all(path.map(async file => {
              const { control } = await Debian.parsePackage(await bucket.getFileStream(file));
              this.emit("addPackage", await packageManeger.addPackage(repo, target.componentName || "main", id, {}, control));
            }));
          } else if (target.type === "google_driver") {
            const { clientId, clientSecret, clientToken, gIds = [] } = target;
            const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
            if (gIds.length === 0) gIds.push(...((await gdrive.listFiles()).filter(rel => rel.name.endsWith(".deb")).map(({id}) => id)));
            await Promise.all(gIds.map(async file => {
              const { control } = await Debian.parsePackage(await gdrive.getFileStream(file));
              this.emit("addPackage", await packageManeger.addPackage(repo, target.componentName || "main", id, {}, control));
            }));
          } else if (target.type === "github") {
            const { owner, repository, token } = target;
            const gh = await Github.GithubManeger(owner, repository, token);
            if (target.subType === "branch") {
              const { branch = (await gh.branchList()).at(0)?.name ?? "main" } = target;
              for (const { path: filePath } of (await gh.trees(branch)).tree.filter(file => file.type === "tree" ? false : file["path"])) {
                const rawURL = new URL(path.join(owner, repository, branch, filePath), "https://raw.githubusercontent.com");
                const { control } = await Debian.parsePackage(await coreHttp.streamRequest(rawURL, {headers: token ? {Authorization: `token ${token}`} : {}}));
                this.emit("addPackage", (await packageManeger.addPackage(repo, target.componentName || "main", id, {url: rawURL.toString()}, control)));
              }
            } else {
              const { tag = [] } = target;
              for (const tagName of tag) {
                const assets = (await gh.getRelease(tagName)).assets.filter(({name}) => name.endsWith(".deb"));
                for (const asset of assets) {
                  const { control } = await Debian.parsePackage(await coreHttp.streamRequest(asset.browser_download_url, {headers: token ? {Authorization: `token ${token}`} : {}}));
                  this.emit("addPackage", (await packageManeger.addPackage(repo, target.componentName || "main", id, {url: asset.browser_download_url}, control)));
                }
              }
            }
          } else if (target.type === "docker") {
            const { image, auth, tags = [] } = target;
            const registry = new dockerRegistry(image, auth);
            if (tags.length === 0) {
              const { sha256, tag } = registry.image;
              if (sha256) tags.push(sha256);
              else if (tag) tags.push(tag);
              else tags.push(...((await registry.getTags()).reverse().slice(0, 6)));
            }
            const userAuth = new dockerAuth(registry.image, "pull", auth);
            await userAuth.setup();
            for (const tag of tags) {
              const manifestManeger = new dockerUtils.Manifest(await registry.getManifets(tag, userAuth), registry);
              const addPckage = async () => {
                for (const layer of manifestManeger.getLayers()) {
                  const blob = await registry.extractLayer(layer.digest, layer.mediaType, userAuth);
                  blob.on("File", async entry => {
                    if (!(entry.path.endsWith(".deb"))) return null;
                    console.log(entry.path);
                    try {
                      const { control } = await Debian.parsePackage(entry as any);
                      this.emit("addPackage", await packageManeger.addPackage(repo, target.componentName || "main", id, {
                        ref: layer.digest,
                        path: entry.path,
                      }, control));
                    } catch (err) {this.emit("error", err);}
                  });
                  await new Promise<void>((done, reject) => blob.on("close", done).on("error", reject));
                }
              }
              if (manifestManeger.multiArch) {
                for (const platform of manifestManeger.platforms) {
                  await manifestManeger.setPlatform(platform as any);
                  await addPckage();
                }
              } else await addPckage();
            }
          }
        } catch (err) {
          this.emit("error", err);
        }
      }
    }
  }
}