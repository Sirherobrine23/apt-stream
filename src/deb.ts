import tar from "tar";
import { createExtract } from "./ar.js";
import { Decompressor } from "lzma-native";
import { Readable } from "stream";
import { extendsCrypto } from "@sirherobrine23/coreutils";

export type packageControl = {
  Package: string
  Version: string,
  /** endpoint folder file */
  Filename: string,
  "Installed-Size": number,
  Maintainer: string,
  Architecture: string,
  Depends?: string,
  Homepage?: string,
  Section?: string,
  Priority?: string,
  Size: number,
  MD5sum: string,
  SHA256: string,
  Description?: string,
};

export function parseControl(rawControlFile: string) {
  const controlObject = {};
  for (const line of rawControlFile.split(/\r?\n/)) {
    if (/^[\w\S]+:/.test(line)) {
      const [, key, value] = line.match(/^([\w\S]+):(.*)$/);
      controlObject[key.trim()] = value.trim();
    } else {
      const latestKey = Object.keys(controlObject).at(-1);
      controlObject[latestKey] += "\n";
      controlObject[latestKey] += line;
    }
  }
  return controlObject as packageControl;
}

export type debReturn = Awaited<ReturnType<typeof extractDebControl>>;

export async function extractDebControl(debStream: Readable, endPromise: Promise<void> = new Promise(done => debStream.once("end", done))) {
  return new Promise<{size: number, control: packageControl}>((done, reject) => {
    let fileSize = 0;
    debStream.on("data", (chunk) => fileSize += chunk.length);
    const signs = extendsCrypto.createSHA256_MD5(debStream, "both", new Promise(done => debStream.once("end", done)));
    return debStream.pipe(createExtract((info, stream) => {
      if (!(info.name.endsWith("control.tar.gz")||info.name.endsWith("control.tar.xz"))) return;
      (info.name.endsWith("tar.gz")?stream:stream.pipe(Decompressor())).pipe(tar.list({
        onentry(controlEntry) {
          if (!controlEntry.path.endsWith("control")) return null;
          let controlFile: Buffer;
          controlEntry.on("data", chunck => controlFile = (!controlFile)?chunck:Buffer.concat([controlFile, chunck])).once("end", async () => {
            const sign = await signs;
            const control = parseControl(controlFile.toString());
            endPromise.then(() => {
              control.MD5sum = sign.md5;
              control.SHA256 = sign.sha256;
              control.Size = fileSize;
              return done({
                control,
                size: fileSize
              });
            });
          }).on("error", reject);
        },
      // @ts-ignore
      })).on("error", reject);
    })).on("error", reject);
  });
}