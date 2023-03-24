import * as Debian from "@sirherobrine23/debian";
import { packageData, packageManeger } from "./database.js";
import { googleDriver, oracleBucket } from "@sirherobrine23/cloud";
import { aptStreamConfig } from "./config.js";
import { extendsCrypto } from "@sirherobrine23/extends";
import coreHttp, { Github } from "@sirherobrine23/http";
import stream from "stream";

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
  }

  throw new Error("Check package type");
}

async function genericParse(stream: stream.Readable) {
  const hashs = extendsCrypto.createHashAsync(stream);
  return Debian.parsePackage(stream).then(({control}) => hashs.then(hash => ({hash, control})));
}

export async function loadRepository(packageManeger: packageManeger, config: aptStreamConfig, repository = Object.keys(config.repository)) {
  const massaReturn: (Awaited<ReturnType<typeof packageManeger.addPackage>>)[] = []
  for (const repo of repository || Object.keys(config.repository)) {
    const source = config.repository[repo]?.source;
    if (!source) continue;
    for (const target of source) {
      const { id } = target;
      try {
        if (target.type === "http") {
          const { control, hash: { byteLength, hash } } = await genericParse(await coreHttp.streamRequest(target.url, {headers: target.auth?.header, query: target.auth?.query}));
          control.Size = byteLength;
          control.SHA512 = hash.sha512;
          control.SHA256 = hash.sha256;
          control.SHA1 = hash.sha1;
          control.MD5sum = hash.md5;
          massaReturn.push(await packageManeger.addPackage(repo, target.componentName || "main", id, {}, control));
        } else if (target.type === "oracle_bucket") {
          const { authConfig, path = [] } = target;
          const bucket = await oracleBucket.oracleBucket(authConfig);
          if (path.length === 0) path.push(...((await bucket.listFiles()).filter(k => k.name.endsWith(".dev")).map(({name}) => name)));
          await Promise.all(path.map(async file => {
            const { control, hash: { byteLength, hash } } = await genericParse(await bucket.getFileStream(file));
            control.Size = byteLength;
            control.SHA512 = hash.sha512;
            control.SHA256 = hash.sha256;
            control.SHA1 = hash.sha1;
            control.MD5sum = hash.md5;
            return packageManeger.addPackage(repo, target.componentName || "main", id, {}, control);
          })).then(d => massaReturn.push(...d));
        } else if (target.type === "google_driver") {
          const { clientId, clientSecret, clientToken, gIds = [] } = target;
          const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
          if (gIds.length === 0) gIds.push(...((await gdrive.listFiles()).filter(rel => rel.name.endsWith(".deb")).map(({id}) => id)));
          await Promise.all(gIds.map(async file => {
            const { control, hash: { byteLength, hash } } = await genericParse(await gdrive.getFileStream(file));
            control.Size = byteLength;
            control.SHA512 = hash.sha512;
            control.SHA256 = hash.sha256;
            control.SHA1 = hash.sha1;
            control.MD5sum = hash.md5;
            return packageManeger.addPackage(repo, target.componentName || "main", id, {}, control);
          })).then(d => massaReturn.push(...d));
        } else if (target.type === "github") {
          const { owner, repository, token } = target;
          const gh = await Github.GithubManeger(owner, repository, token);
          if (target.subType === "branch") {
            const { branch = (await gh.branchList()).at(0).name } = target;
            console.warn("Cannot load packages from %s/%s tree %O", owner, repository, branch);
            // (await gh.trees(branch));
          } else {
            const { tag = [] } = target;
            await Promise.all(tag.map(async tagName => {
              const assets = (await gh.getRelease(tagName)).assets.filter(({name}) => name.endsWith(".deb"));
              for (const asset of assets) {
                const { control, hash: { byteLength, hash } } = await genericParse(await coreHttp.streamRequest(asset.browser_download_url, {headers: token ? {Authorization: `token ${token}`} : {}}));
                control.Size = byteLength;
                control.SHA512 = hash.sha512;
                control.SHA256 = hash.sha256;
                control.SHA1 = hash.sha1;
                control.MD5sum = hash.md5;
                massaReturn.push(await packageManeger.addPackage(repo, target.componentName || "main", id, {}, control));
              }
            }));
          }
        } else if (target.type === "docker") {
          console.warn("Current docker image is disabled!");
        }
      } catch (err) {
        console.error(err);
      }
    }
  }

  return massaReturn;
}