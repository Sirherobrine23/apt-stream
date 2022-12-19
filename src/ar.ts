import { Readable, Writable } from "node:stream";

type fileInfo = {
  name: string,
  time: Date,
  owner: number,
  group: number,
  mode: number,
  size: number
};

export function createExtract(fn: (info: fileInfo, stream: Readable) => void) {
  const __writed = new Writable();
  let __locked = false;
  let entryStream: Readable;
  let size = 0;
  function check_new_file(chunk: Buffer) {
    return !!(chunk.subarray(0, 60).toString().replace(/\s+\`(\n)?$/, "").trim().match(/^([\w\s\S]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/));
  }
  function _final(callback: (error?: Error) => void): void {
    if (entryStream) {
      entryStream.push(null);
      entryStream = undefined;
    }
    return callback();
  }
  function _destroy(error: Error, callback: (error?: Error) => void): void {
    if (entryStream) {
      entryStream.push(null);
      entryStream = undefined;
    }
    return callback(error);
  }
  async function __push(chunk: Buffer, callback?: (error?: Error | null) => void) {
    if (0 < size) {
      if (check_new_file(chunk.subarray(size))) {
        // console.log("[Ar]: Nextfile");
        const silpChuck = chunk.subarray(0, size);
        chunk = chunk.subarray(size);
        // console.log("[Ar]: Nextfile: %f", chunk.length);
        entryStream.push(silpChuck, "binary");
        entryStream.push(null);
        entryStream = undefined;
        size = 0;
        return __writed._write(chunk, "binary", callback);
      }
    }
    size -= chunk.length;
    if (entryStream) entryStream.push(chunk, "binary");
    return callback();
  }
  let waitMore: Buffer;
  __writed._write = (chunkRemote, encoding, callback) => {
    if (!Buffer.isBuffer(chunkRemote)) chunkRemote = Buffer.from(chunkRemote, encoding);
    let chunk = Buffer.from(chunkRemote);
    if (__locked === false) {
      // console.log("[Ar]: Fist chunk length: %f", chunk.length);
      if (waitMore) {
        chunk = Buffer.concat([waitMore, chunk]);
        waitMore = undefined;
      }
      if (chunk.length < 70) {
        waitMore = chunk;
        callback();
      }
      if (!chunk.subarray(0, 8).toString().trim().startsWith("!<arch>")) {
        __writed.destroy();
        return callback(new Error("Not an ar file"));
      }
      __locked = true;
      chunk = chunk.subarray(8);
    }
    if (entryStream) return __push(chunk, callback);
    const info = chunk.subarray(0, 60).toString().replace(/\s+\`(\n)?$/, "").trim();
    chunk = chunk.subarray(60);
    // debian-binary   1668505722  0     0     100644  4
    const dataMathc = info.match(/^([\w\s\S]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/);
    if (!dataMathc) {
      size = chunk.length;
      return __push(chunk, callback);
    }
    const [, name, time, owner, group, mode, sizeM] = dataMathc;
    const data: fileInfo = {
      name: name.trim(),
      time: new Date(parseInt(time)*1000),
      owner: parseInt(owner),
      group: parseInt(group),
      mode: parseInt(mode),
      size: parseInt(sizeM)
    };
    size = data.size;
    entryStream = new Readable({read() {}});
    fn(data, entryStream);
    return __push(chunk, callback);
    // process.exit(1);
  }
  __writed._final = (callback) => {return _final.call(this, callback);};
  __writed._destroy = (error, callback) => {return _destroy.call(this, error, callback);};
  return __writed;
}