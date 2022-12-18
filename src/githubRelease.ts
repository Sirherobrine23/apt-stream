import coreUtils from "@sirherobrine23/coreutils";
import { Readable } from "stream";
import { extractDebControl, debReturn } from "./deb.js";
export type baseOptions<T extends {} = {}> = {repo: string, owner: string} & T;

export default fullConfig;
export async function fullConfig(config: {config: string|baseOptions<{releaseTag?: string}>, githubToken?: string}, fn: (data: debReturn & {getStream: () => Promise<Readable>}) => void) {
  if (typeof config.config === "string") {
    const [owner, repo] = config.config.split("/");
    config.config = {owner, repo};
  }

  const options: baseOptions<{releaseTag?: string}> = config.config;
  const releases = (await coreUtils.httpRequestGithub.GithubRelease(options.owner, options.repo)).slice(0, 10).filter(data => data.assets.some(file => file.name.endsWith(".deb"))).map(data => {
    return {
      tag: data.tag_name,
      assets: data.assets.filter(data => data.name.endsWith(".deb")).map(({name, browser_download_url}) => ({name, download: browser_download_url}))
    };
  }).filter(({assets}) => assets?.length > 0);

  for (const rel of releases) {
    for (const asset of rel.assets) {
      const getStream = async () => coreUtils.httpRequest.pipeFetch(asset.download)
      const control = await extractDebControl(await getStream());
      fn({
        ...control,
        getStream,
      });
    }
  }
}
