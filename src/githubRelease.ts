import { httpRequestGithub } from "@sirherobrine23/coreutils";

export type baseOptions<T extends {} = {}> = {
  repo: string,
  owner: string,
  githubToken?: string
} & T;

export async function listFiles(options: baseOptions<{releaseTag?: string}>) {
  const releases = await httpRequestGithub.GithubRelease(options.owner, options.repo);
  return releases.filter(data => data.assets.some(file => file.name.endsWith(".deb"))).map(data => {
    return {
      tag: data.tag_name,
      assets: data.assets.filter(data => data.name.endsWith(".deb"))
    };
  });
}
