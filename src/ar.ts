import { Readable, Writable } from "node:stream";

type fileInfo = {
  name: string,
  time: Date,
  owner: number,
  group: number,
  mode: number,
  size: number
};
export interface gnuExtract extends Writable {
  on<U extends Parameters<Writable["on"]>>(...args: U): this;
  once<U extends Parameters<Writable["on"]>>(...args: U): this;
  // once<U extends Parameters<Writable["once"]>>(event: U[0], listener: U[1]): this;

  on(event: "entry", listener: (info: fileInfo, stream: Readable) => void): this;
  once(event: "entry", listener: (info: fileInfo, stream: Readable) => void): this;
}

export class gnuExtract extends Writable {
  #__locked = false;
  #entryStream?: Readable;
  #size = 0;
  async #__push(chunk: Buffer, callback?: (error?: Error | null) => void) {
    if (this.#check_new_file(chunk.subarray(this.#size))) {
      const silpChuck = chunk.subarray(0, this.#size);
      chunk = chunk.subarray(this.#size);
      this.#entryStream.push(silpChuck, "binary");
      this.#entryStream.push(null);
      this.#entryStream = undefined;
      this.#size = 0;
      return this._write(chunk, "binary", callback);
    }
    this.#size -= chunk.length;
    this.#entryStream.push(chunk, "binary");
    return callback();
  }
  #check_new_file(chunk: Buffer) {
    return !!(chunk.subarray(0, 60).toString().replace(/\s+\`(\n)?$/, "").trim().match(/^([\w\s\S]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/));
  }
  _final(callback: (error?: Error) => void): void {
    if (this.#entryStream) {
      this.#entryStream.push(null);
      this.#entryStream = undefined;
    }
    return callback();
  }
  _destroy(error: Error, callback: (error?: Error) => void): void {
    if (this.#entryStream) {
      this.#entryStream.push(null);
      this.#entryStream = undefined;
    }
    return callback(error);
  }
  async _write(chunk: Buffer, encoding, callback?: (error?: Error | null) => void) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk, encoding);
    if (!this.#__locked) {
      if (!chunk.subarray(0, 8).toString().trim().startsWith("!<arch>")) {
        this.emit("error", new Error("Not an ar file"));
        this.destroy();
        return;
      }
      this.#__locked = true;
      chunk = chunk.subarray(8);
    }
    if (this.#entryStream) return this.#__push(chunk, callback);
    const info = chunk.subarray(0, 60).toString().replace(/\s+\`(\n)?$/, "").trim();
    chunk = chunk.subarray(60);
    // debian-binary   1668505722  0     0     100644  4
    const dataMathc = info.match(/^([\w\s\S]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/);
    if (!dataMathc) {
      this.#size = chunk.length;
      return this.#__push(chunk, callback);
    }
    const [, name, time, owner, group, mode, size] = dataMathc;
    const data: fileInfo = {
      name: name.trim(),
      time: new Date(parseInt(time)*1000),
      owner: parseInt(owner),
      group: parseInt(group),
      mode: parseInt(mode),
      size: parseInt(size)
    };
    this.#size = data.size;
    this.#entryStream = new Readable({read() {}});
    this.emit("entry", data, this.#entryStream);
    return this.#__push(chunk, callback);
    // process.exit(1);
  }
}