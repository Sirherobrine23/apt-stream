import { EventEmitter} from "node:events";
import fs from "node:fs";
import path from "node:path";
// import util from "node:util";


/**
* Given something of size *size* bytes that needs to be aligned by *alignment*
* bytes, returns the total number of padding bytes that need to be appended to
* the end of the data.
*/
function getPaddingBytes(size, alignment) {
  return (alignment - (size % alignment)) % alignment;
}

function padWhitespace(str, width) {
while(str.length<width) {
  str += " ";
}
return str;
}
function padLF(width) {
var str = "";
while(str.length<width) {
  str += "\n";
}
return str;
}

function strictWidthField(str, width) {
if(str.length>width) {
  return str.substring(0, width);
} else {
  return padWhitespace(str, width);
}
}

/**
* Trims trailing whitespace from the given string (both ends, although we
* only really need the RHS).
*/
function trimWhitespace(str: string) {
  return String.prototype.trim ? str.trim() : str.replace(/^\s+|\s+$/gm, '');
}

/**
* Trims trailing NULL characters.
*/
function trimNulls(str) {
  return str.replace(/\0/g, '');
}

function buildHeader(name, ts, uid, gid, mode, size) {
var header = strictWidthField(name, 16)
  + strictWidthField(ts, 12)
  + strictWidthField(uid, 6)
  + strictWidthField(gid, 6)
  + strictWidthField(mode, 8)
  + strictWidthField(size, 10)
  + "`\n";
return Buffer.from(header, "ascii");
}

/**
* All archive variants share this header before files, but the variants differ
* in how they handle odd cases (e.g. files with spaces, long filenames, etc).
*
* char	ar_name[16]; File name
* char	ar_date[12]; file member date
* char	ar_uid[6]	file member user identification
* char	ar_gid[6]	file member group identification
* char	ar_mode[8]   file member mode (octal)
* char	ar_size[10]; file member size
* char	ar_fmag[2];  header trailer string
*/
class ArEntry {
  public header: Buffer;
  public archive: ArReader|ArWriter;
  public bsd: boolean;
  public bsdName: string;
  public streamParam?: {file: string, start: number, end: number};
  public data?: Buffer;
  constructor(header: Buffer, archive: ArReader|ArWriter) {
    this.header = header;
    this.archive = archive;
    if(this.fmag() !== "`\n") {
      throw new Error("Record is missing header trailer string; instead, it has: " + this.fmag());
    }
    this.bsd = this.name().slice(0, 3) === "#1/";
  }
  name(): string {
    // The name field is padded by whitespace, so trim any lingering whitespace.
    return trimWhitespace(this.header.toString('utf8', 0, 16));
  };
  realName(): string {
    var name = this.name();
    if(this.bsd) {
      this.nameSizeBSD();
      // Unfortunately, even though they give us the *explicit length*, they add
      // NULL bytes and include that in the length, so we must strip them out.
      name = this.bsdName;
    } else if(this.archive && this.archive.isGNU() && name.indexOf("/")===0) {
      name = this.archive.resolveNameGNU(name);
    }
    return name;
  };
  /**
  * Returns the number of bytes that the resolved BSD-style name takes up in the
  * content section.
  */
  nameSizeBSD() {
    if (this.bsd) {
      return parseInt(this.name().substr(3), 10);
    } else {
      return 0;
    }
  };
  fileName() {
    var n = this.realName();
    if(n.lastIndexOf("/")==n.length-1) {
      n = n.substring(0, n.length-1);
    }
    return n;
  };
  date() {
    return new Date(parseInt(this.header.toString('ascii', 16, 28), 10));
  };
  uid() {
    return parseInt(this.header.toString('ascii', 28, 34), 10);
  };
  gid() {
    return parseInt(this.header.toString('ascii', 34, 40), 10);
  };
  mode() {
    return parseInt(this.header.toString('ascii', 40, 48), 8);
  };

  /**
  * Total size of the data section in the record. Does not include padding bytes.
  */
  dataSize() {
    return parseInt(this.header.toString('ascii', 48, 58), 10);
  };

  /**
  * Total size of the *file* data in the data section of the record. This is
  * not always equal to dataSize.
  */
  fileSize() {
    if(this.bsd) {
      return this.dataSize() - this.nameSizeBSD();
    } else {
      return this.dataSize();
    }
  };
  fmag() {
    return this.header.toString('ascii', 58, 60);
  };

  /**
  * Total size of the header, including padding bytes.
  */
  headerSize() {
    // The common header is already two-byte aligned.
    return 60;
  };

  /**
  * Total size of this file record (header + header padding + file data +
  * padding before next archive member).
  */
  totalSize() {
    var headerSize = this.headerSize(), dataSize = this.dataSize();

    // All archive members are 2-byte aligned, so there's padding bytes after
    // the data section.
    return headerSize + dataSize + getPaddingBytes(dataSize, 2);
  };

}

export declare interface ArReader {
  on(act: "entry", fn: (entry: ArEntry, next?: () => void) => void): this;
  once(act: "entry", fn: (entry: ArEntry, next?: () => void) => void): this;

  on(act: "end"|"close", fn: () => void): this;
  once(act: "end"|"close", fn: () => void): this;
}

export class ArReader extends EventEmitter {
  private file: string;
  public size: number;
  public fd: number;
  private gnuEntry?: ArEntry;
  constructor(file: string) {
    super({captureRejections: true});
    this.file = file;
    fs.stat(this.file, (sErr, stats) => {
      if(sErr) this.emit("error", sErr);
      else {
        this.size = stats.size;
        fs.open(this.file, "r", (oErr, fd) => {
          if(oErr) this.emit("error", oErr);
          else {
            this.emit("open");
            this.fd = fd;
            var readChunks = (buf: Buffer, off: number, pos: number, left: number, cb: (data?: Buffer) => void) => {
              if(pos>=this.size && left>0) cb();
              else if(left<=0) cb(buf);
              else {
                var chunkSize = Math.max(Math.min(left, 1024), 0);
                fs.read(fd, buf, off, chunkSize, pos, (rErr, read, b) => {
                  if(!rErr) readChunks(buf, off+read, pos+read, left-read, cb);
                  else {
                    this.emit("error", rErr);
                    cb();
                  }
                });
              }
            };
            var readEntry = (offset: number) => {
              readChunks(Buffer.alloc(60), 0, offset, 60, (header) => {
                if(!header) {
                  this.emit("end");
                  fs.close(fd, (cErr) => {
                    if(cErr) this.emit("error", cErr);
                    this.fd = undefined;
                    this.emit("close");
                  });
                } else {
                  var entry = new ArEntry(header, this);
                  var bsdNameSize = entry.nameSizeBSD();
                  readChunks(Buffer.alloc(bsdNameSize), 0, offset+60, bsdNameSize, (bsdNameData) => {
                    if(bsdNameData) {
                      entry.bsdName = trimNulls(bsdNameData.toString('utf8', 0, bsdNameSize));
                      var nextOffset = entry.totalSize()+offset;
                      var nexted = false;
                      var next = () => {
                        if(!nexted) { //prevent repeat calls
                          entry = undefined;
                          readEntry(nextOffset);
                          nexted = true;
                        }
                      };
                      if(entry.name()==="//") {
                        this.gnuEntry = entry;
                        var size = entry.fileSize();
                        readChunks(Buffer.alloc(size), 0, offset+60+bsdNameSize, size, (gnuData) => {
                          this.gnuEntry.data = gnuData;
                          next();
                        });
                      } else {
                        entry.streamParam = {
                          file: this.file,
                          start: offset+60+bsdNameSize,
                          end: offset+60+entry.dataSize()-1
                        };
                        this.emit("entry", entry, next);
                      }
                    }
                  });
                }
              });
            };
            readEntry(8);
          }
        });
      }
    });
  }

  isGNU() {
    return (this.gnuEntry!==undefined);
  };

  resolveNameGNU(shortName: string): string|void {
    if(this.isGNU()) {
      try {
        var start = parseInt(shortName.replace("/", ""), 10);
        var resolved = this.gnuEntry.data.toString('utf8', start);
        return resolved.substring(0, resolved.indexOf("\n"));
      } catch(e) {
        return shortName;
      }
    }
  };
}

export type ArWriterOptions = {
  variant?: "bsd"|"gnu",
  uid?: number,
  gid?: number,
  mode?: number
};
export class ArWriter extends EventEmitter {
  public file: string;
  public uid?: number;
  public gid?: number;
  public mode?: number;
  public gnu: boolean;
  public bsd: boolean;
  public data: Buffer;
  public gnuMap?: {[key: string]: string};
  public gnuEntry?: ArEntry
  constructor(file: string, opts?: ArWriterOptions) {
    super({captureRejections: true});
    this.file = file;
    if(opts) {
      if(opts.uid) this.uid = opts.uid;
      if(opts.gid) this.gid = opts.gid;
      if(opts.mode) this.mode = opts.mode;
      if(opts.variant) {
        if(opts.variant.toLowerCase() === "bsd") this.bsd = true;
        else if(opts.variant.toLowerCase() === "gnu") this.gnu = true;
      }
    }
    if(fs.existsSync(this.file)) {
      fs.unlinkSync(this.file);
    }
    fs.open(this.file, "w", (oErr, fd) => {
      if(oErr) {
        this.emit("error", oErr);
      } else {
        this.emit("open");
        fs.write(fd, Buffer.from("!<arch>\n", "ascii"), 0, 8, null, (archErr, writ, b) => {
          if(archErr) {
            this.emit("error", archErr);
          } else {
            var writeEntry = (entry: ArEntry, off: number, cb: (data?: number) => void) => {
              fs.write(fd, entry.header, 0, entry.headerSize(), null, (wErr1, w, b) => {
                if(wErr1) {
                  this.emit("error", wErr1);
                } else {
                  var dataSize = entry.dataSize();
                  var paddedData = entry.data;
                  var paddSize = getPaddingBytes(dataSize, 2);
                  if(paddSize>0) {
                    paddedData = Buffer.concat([entry.data, Buffer.from(padLF(paddSize), "ascii")], dataSize+paddSize);
                  }
                  fs.write(fd, paddedData, 0, dataSize+paddSize, null, (wErr2, w2, b2) => {
                    if(wErr2) {
                      this.emit("error", wErr2);
                    } else {
                      var total = entry.totalSize();
                      entry = undefined;
                      cb(off+total);
                    }
                  });
                }
              });
            };
            var processFile = (fList: any[], off: number, cb: (data?: Buffer) => void) => {
              if(fList.length<=0) cb();
              else {
                var curr = fList.shift();
                fs.stat(curr, (statErr, currStat) => {
                  if(statErr) this.emit("error", statErr);
                  else {
                    fs.readFile(curr, (rfErr, data) => {
                      if(rfErr) this.emit("error", rfErr);
                      else {
                        var currName = path.basename(curr) + "/";
                        var currSize = currStat.size;
                        if(this.gnu && this.gnuMap[currName]) {
                          currName = this.gnuMap[currName];
                        } else if(this.bsd && currName.length>16) {
                          currSize += currName.length;
                          data = Buffer.concat([Buffer.from(currName, "ascii"), data], currSize);
                          currName = "#1/" + currName.length;
                        }
                        var currHeader = buildHeader(currName,
                            (currStat.mtime.getTime()/1000) + "",
                            ((this.uid!==undefined) ? this.uid : currStat.uid) + "",
                            ((this.gid!==undefined) ? this.gid : currStat.gid) + "",
                            ((this.mode!==undefined) ? this.mode : currStat.mode).toString(8),
                            currSize + "");
                        var arEntry = new ArEntry(currHeader, this);
                        arEntry.data = data;
                        writeEntry(arEntry, off, (newOff) => {
                          this.emit("entry", arEntry);
                          arEntry = undefined;
                          processFile(fList, newOff, cb);
                        })
                      }
                    });
                  }
                });
              }
            };
            var finished = () => {
              fs.close(fd, (cwErr) => {
                if(cwErr) {
                  this.emit("error", cwErr);
                } else {
                  this.emit("finish");
                  // callback && callback();
                }
              });
            };
            if(this.gnu) {
              this.gnuMap = {};
              var gnuContent = "";
              var entries = entries;
              for(var i=0; i<entries.length; i++) {
                var base = path.basename(entries[i]) + "/";
                if(base.length>16) {
                  this.gnuMap[base] = "/" + gnuContent.length;
                  gnuContent += base + "\n";
                }
              }
              if(Object.keys(this.gnuMap).length>0) {
                var gnuHeader = buildHeader("//", "", "", "", "", gnuContent.length + "");
                this.gnuEntry = new ArEntry(gnuHeader, this);
                this.gnuEntry.data = Buffer.from(gnuContent);
                writeEntry(this.gnuEntry, 8, (newOffset) => {
                  processFile(entries, newOffset, finished);
                });
              } else {
                processFile(entries, 8, finished);
              }
            } else {
              processFile(entries, 8, finished);
            }
          }
        });
      }
    });
  }

  isGNU() {
    return this.gnu;
  };

  isBSD() {
    return this.bsd;
  };

  resolveNameGNU(shortName: string) {
    return ArReader.prototype.resolveNameGNU.call(this, shortName);
  };
}