import coreUtils from "@sirherobrine23/coreutils";
export type baseOptions<T extends {} = {}> = {
  repo: string,
  owner: string
} & T;

export async function list(config: string|baseOptions<{releaseTag?: string}>, githubToken?: string) {
  if (typeof config === "string") {
    const [owner, repo] = config.split("/");
    config = {
      owner,
      repo
    };
  }

  const options: baseOptions<{releaseTag?: string}> = config;
  const releases = (await coreUtils.httpRequestGithub.GithubRelease(options.owner, options.repo)).slice(0, 10).filter(data => data.assets.some(file => file.name.endsWith(".deb"))).map(data => {
    console.log("listen release to tag name %s", data.tag_name);
    return {
      tag: data.tag_name,
      assets: data.assets.filter(data => data.name.endsWith(".deb")).map(({name, browser_download_url}) => ({name, download: browser_download_url}))
    };
  });

  return releases.filter(({assets}) => assets?.length > 0);
}
