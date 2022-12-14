import coreUtils from "@sirherobrine23/coreutils";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
const tmpStorage = path.join(process.env.TMPSTORAGE ? path.resolve(process.env.TMPSTORAGE.trim()) : os.tmpdir(), ".ghRelease");

export type baseOptions<T extends {} = {}> = {
  repo: string,
  owner: string,
  githubToken?: string
} & T;

export async function localRepo(config: string|baseOptions<{releaseTag?: string}>) {
  if (typeof config === "string") {
    const [owner, repo] = config.split("/");
    config = {
      owner,
      repo
    };
  }

  const options: baseOptions<{releaseTag?: string}> = config;
  const releases = (await coreUtils.httpRequestGithub.GithubRelease(options.owner, options.repo)).slice(0, 10).filter(data => data.assets.some(file => file.name.endsWith(".deb"))).map(data => {
    return {
      tag: data.tag_name,
      assets: data.assets.filter(data => data.name.endsWith(".deb")).map(({name, browser_download_url}) => ({name, download: browser_download_url}))
    };
  });

  for (const release of releases) {
    const root = path.join(tmpStorage, options.owner, options.repo, release.tag);
    if (!await coreUtils.extendFs.exists(root)) await fs.mkdir(root, {recursive: true});
    await Promise.all(release.assets.map(async file => {
      if (await coreUtils.extendFs.exists(path.join(root, file.name))) return path.join(root, file.name);
      console.log("Downloading %s from repo %s/%s@%s", file.name, options.owner, options.repo, release.tag);
      return coreUtils.httpRequestLarge.saveFile({
        url: file.download,
        filePath: path.join(root, file.name)
      });
    }))
  };
}
