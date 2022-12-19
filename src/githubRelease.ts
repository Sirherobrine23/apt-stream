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

  return Promise.all(releases.map(async (rel) => Promise.all(rel.assets.map(async (asset) => {
    console.log(`Downloading ${asset.name} from ${rel.tag}`);
    const getStream = async () => coreUtils.httpRequest.pipeFetch(asset.download)
    const control = await getStream().then(Stream => extractDebControl(Stream, new Promise(done => Stream.once("end", done))));
    fn({
      ...control,
      getStream,
    });
    return {asset, getStream, control};
  })))).then(data => data.flat());
}
