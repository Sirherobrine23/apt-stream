import { packageRegister, parseDebControl } from "./aptRepo/repoConfig.js";
import { createExtract } from "./ar.js";
import coreUtils from "@sirherobrine23/coreutils";
import tar from "tar";

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

export async function fullConfig(config: {config: string|baseOptions<{releaseTag?: string}>, githubToken?: string}, packageManeger: packageRegister) {
  const releases = await list(config.config, config.githubToken);
  for (const {assets} of releases ?? []) for (const {download} of assets ?? []) {
    await new Promise<void>(async done => {
      const request = await coreUtils.httpRequest.pipeFetch(download);
      const ar = request.pipe(createExtract());
      const signs = Promise.all([coreUtils.extendsCrypto.createSHA256_MD5(request, "sha256", new Promise(done => request.once("end", done))), coreUtils.extendsCrypto.createSHA256_MD5(request, "md5", new Promise(done => request.once("end", done)))]).then(([sha256, md5]) => ({sha256, md5}));
      ar.on("entry", (info, stream) => {
        if (info.name !== "control.tar.gz") return;
        stream.pipe(tar.list({
          onentry: (tarEntry) => {
            if (tarEntry.path !== "./control") return;
            let controlBuffer: Buffer;
            tarEntry.on("data", (chunk) => {
              if (!controlBuffer) controlBuffer = chunk;
              else controlBuffer = Buffer.concat([controlBuffer, chunk]);
            });
            tarEntry.on("finish", async () => {
              done();
              const config = parseDebControl(controlBuffer.toString());
              if (!(config.Package && config.Version && config.Architecture)) return;
              const sigs = await signs;
              packageManeger.registerPackage({
                name: config.Package,
                version: config.Version,
                arch: config.Architecture,
                packageConfig: config,
                signature: sigs,
                getStrem: async () => coreUtils.httpRequest.pipeFetch(download),
              });
            });
          }
        }, ["./control"]));
      }).on("error", console.log);
    });
  }
}