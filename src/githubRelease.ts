import { parseDebControl } from "./aptRepo/index.js";
import { createExtract } from "./ar.js";
import coreUtils from "@sirherobrine23/coreutils";
import tar from "tar";
import { localRegistryManeger } from "./aptRepo/index.js";

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
  for (const {assets} of releases ?? []) for (const {download} of assets ?? []) {
    await new Promise<void>(async done => {
      let size = 0;
      const request = (await coreUtils.httpRequest.pipeFetch(download)).on("data", (chunk) => size += chunk.length);
      const signs = Promise.all([coreUtils.extendsCrypto.createSHA256_MD5(request, "sha256", new Promise(done => request.once("end", done))), coreUtils.extendsCrypto.createSHA256_MD5(request, "md5", new Promise(done => request.once("end", done)))]).then(([sha256, md5]) => ({sha256, md5}));
      request.pipe(createExtract()).on("entry", (info, stream) => {
        if (!info.name.endsWith("control.tar.gz")) return null;
        return stream.pipe(tar.list({
          onentry: (tarEntry) => {
            if (!tarEntry.path.endsWith("control")) return;
            let controlBuffer: Buffer;
            tarEntry.on("data", (chunk) => {
              if (!controlBuffer) controlBuffer = chunk;
              else controlBuffer = Buffer.concat([controlBuffer, chunk]);
            }).on("error", console.log);
            request.on("end", async () => {
              done();
              const config = parseDebControl(controlBuffer);
              if (!(config.Package && config.Version && config.Architecture)) return;
              const sigs = await signs;
              packageManeger.registerPackage({
                name: config.Package,
                version: config.Version,
                arch: config.Architecture,
                packageConfig: config,
                signature: sigs,
                size,
                getStrem: async () => coreUtils.httpRequest.pipeFetch(download),
              });
            }).on("error", console.log);
          }
        }, ["./control"]));
      }).on("error", console.log);
    });
  }
}
