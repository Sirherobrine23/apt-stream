import { parseDebControl } from "./aptRepo.js";
import { createExtract } from "./ar.js";
import coreUtils, { extendsCrypto } from "@sirherobrine23/coreutils";
import tar from "tar";
import { localRegistryManeger } from "./aptRepo.js";
import { format } from "util";
import { Decompressor } from "lzma-native";

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
    return {
      tag: data.tag_name,
      assets: data.assets.filter(data => data.name.endsWith(".deb")).map(({name, browser_download_url}) => ({name, download: browser_download_url}))
    };
  });

  return releases.filter(({assets}) => assets?.length > 0);
}

export async function fullConfig(config: {config: string|baseOptions<{releaseTag?: string}>, githubToken?: string}, packageManeger: localRegistryManeger) {
  const releases = await list(config.config, config.githubToken);
  for (const {assets, tag} of releases ?? []) for (const {download} of assets ?? []) {
    let size = 0;
      const request = (await coreUtils.httpRequest.pipeFetch(download)).on("data", (chunk) => size += chunk.length);
      const signs = extendsCrypto.createSHA256_MD5(request, "both", new Promise(done => request.on("end", done)));
      request.pipe(createExtract((info, stream) => {
        if (!(info.name.endsWith("control.tar.gz")||info.name.endsWith("control.tar.xz"))) return;
        (info.name.endsWith("tar.gz")?stream:stream.pipe(Decompressor())).pipe(tar.list({
          onentry: (tarEntry) => {
            if (!tarEntry.path.endsWith("control")) return;
            let controlBuffer: Buffer;
            tarEntry.on("data", (chunk) => {
              if (!controlBuffer) controlBuffer = chunk;
              else controlBuffer = Buffer.concat([controlBuffer, chunk]);
            }).on("error", console.log);
            request.on("end", async () => {
              const debConfig = parseDebControl(controlBuffer);
              if (!(debConfig.Package && debConfig.Version && debConfig.Architecture)) return;
              const sigs = await signs;
              packageManeger.registerPackage({
                name: debConfig.Package,
                version: debConfig.Version,
                arch: debConfig.Architecture,
                packageConfig: debConfig,
                signature: sigs,
                size,
                from: format("github release, tag: %s, repo: %s", tag, config.config),
                getStrem: async () => coreUtils.httpRequest.pipeFetch(download),
              });
            }).on("error", console.log);
          }
        }));
      })).on("error", console.log);
  }
}
