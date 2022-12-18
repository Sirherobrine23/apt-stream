import { localRegistryManeger, parseDebControl } from "./aptRepo/index.js";
import { DockerRegistry, extendsCrypto } from "@sirherobrine23/coreutils";
import { createExtract } from "./ar.js";
import { Readable } from "stream";
import tar from "tar";
import { Decompressor } from "lzma-native";

export async function fullConfig(imageInfo: {image: string, targetInfo?: DockerRegistry.Manifest.platfomTarget}, packageManeger: localRegistryManeger) {
  const registry = await DockerRegistry.Manifest.Manifest(imageInfo.image, imageInfo.targetInfo);
  await registry.layersStream((data) => {
    if (!(["gzip", "gz", "tar"]).some(ends => data.layer.mediaType.endsWith(ends))) {
      console.log(data.layer.mediaType);
      return null;
    }
    return data.stream.pipe(tar.list({
      onentry(entry) {
        if (!entry.path.endsWith(".deb")) return null;
        let fileSize = 0;
        entry.on("data", (chunk) => fileSize += chunk.length);
        const signs = Promise.all([extendsCrypto.createSHA256_MD5(entry as any, "sha256", new Promise(done => entry.once("end", done))), extendsCrypto.createSHA256_MD5(entry as any, "md5", new Promise(done => entry.once("end", done)))]).then(([sha256, md5]) => ({sha256, md5}));
        return entry.pipe(createExtract((info, stream) => {
          if (!(info.name.endsWith("control.tar.gz")||info.name.endsWith("control.tar.xz"))) return;
          (info.name.endsWith("tar.gz")?stream:stream.pipe(Decompressor())).pipe(tar.list({
            onentry(controlEntry) {
              if (!controlEntry.path.endsWith("control")) return null;
              let controlFile: Buffer;
              controlEntry.on("data", chunck => controlFile = (!controlFile)?chunck:Buffer.concat([controlFile, chunck])).once("end", async () => {
                const sign = await signs;
                const control = parseDebControl(controlFile);
                entry.on("end", () => {
                  packageManeger.registerPackage({
                    name: control.Package,
                    version: control.Version,
                    arch: control.Architecture,
                    packageConfig: control,
                    size: fileSize,
                    signature: sign,
                    getStrem: () => new Promise<Readable>(done => {
                      registry.blobLayerStream(data.layer.digest).then((stream) => stream.pipe(tar.list({
                        onentry(getEntry) {
                          if (getEntry.path !== entry.path) return;
                          done(getEntry as any);
                        }
                      })));
                    }),
                  });
                });
              }).on("error", console.error);
            },
          }))
        })).on("error", console.log);
      },
    }));
  });
}