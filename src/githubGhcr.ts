import type { manifestOptions } from "@sirherobrine23/coreutils/src/DockerRegistry/manifests.js";
import { createExtract } from "./ar.js";
import { Readable } from "node:stream";
import coreUtils, { DockerRegistry } from "@sirherobrine23/coreutils";
import tar from "tar";
import { localRegistryManeger, parseDebControl } from "./aptRepo/index.js";

export async function list(repo: string|manifestOptions, config?: DockerRegistry.Manifest.optionsManifests) {
  console.log("testing %o", repo);
  const dockerRegistry = await coreUtils.DockerRegistry.Manifest.Manifest(repo, config);
  const layers = await dockerRegistry.imageManifest(dockerRegistry.repoConfig.tagDigest);
  for (const layer of layers.layers) {
    console.log("Docker image %s/%s/%s testing %s", dockerRegistry.repoConfig.registryBase, dockerRegistry.repoConfig.owner, dockerRegistry.repoConfig.repository, layer.digest);
  }
}

export async function fullConfig(listReturn: Awaited<ReturnType<typeof list>>, packageManeger: localRegistryManeger) {
  if (listReturn.files?.length !> 0) return;
  for (const file of listReturn.files ?? []) {
    await new Promise<void>(async done => {
      let size = 0;
      const request = (await listReturn.stream(file.path)).on("data", (chunk) => size += chunk.length);
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
                getStrem: async () => listReturn.stream(file.path)
              });
            });
          }
        }, ["./control"]));
      }).on("error", console.log);
    });
  }
}