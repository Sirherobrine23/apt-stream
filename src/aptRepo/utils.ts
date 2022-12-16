import { WriteStream } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import zlib from "node:zlib";

/*
Package: 1oom
Version: 1.0-2
Installed-Size: 1873
Maintainer: Debian Games Team <pkg-games-devel@lists.alioth.debian.org>
Architecture: amd64
Depends: libc6 (>= 2.14), libsamplerate0 (>= 0.1.7), libsdl2-2.0-0 (>= 2.0.12), libsdl2-mixer-2.0-0 (>= 2.0.2)
Description: Master of Orion engine
Homepage: https://kilgoretroutmaskreplicant.gitlab.io/plain-html/
Description-md5: 5f91cd9d6749d593ed0c26e4ada69fa4
Section: contrib/games
Priority: optional
Filename: pool/contrib/1/1oom/1oom_1.0-2_amd64.deb
Size: 506180
MD5sum: d6ddb9189f14e76d7336246104cd0d2c
SHA256: b560619040f13626efcb02903d14a5b204b01f1cac78c6a76d6cb590dd60ffe8


Breaks
Build-Ids
Built-Using
Conflicts
Depends
Description
Enhances
Multi-Arch
Pre-Depends
Priority
Provides
Recommends
Replaces
Section
Source
Suggests
Tag

*/

export type packageGzObject = {
  Package: string
  Version: string,
  /** endpoint folder file */
  Filename: string,
  InstalledSize: number,
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

export async function createPackagegz(res: WriteStream|Writable, Packages: packageGzObject[]) {
  const ReadStream = new PassThrough();
  ReadStream._read = (_size) => {};
  ReadStream.pipe(zlib.createGzip()).pipe(res);
  for (const packageInfo of Packages) {
    let packageData = ["package: "+packageInfo.Package];
    packageData.push("Version: "+packageInfo.Version);
    packageData.push("Filename: "+packageInfo.Filename);
    packageData.push("Maintainer: "+packageInfo.Maintainer);
    packageData.push("Architecture: "+packageInfo.Architecture);
    if (packageInfo.InstalledSize) packageData.push("Installed-Size: "+packageInfo.InstalledSize);
    if (packageInfo.Depends) packageData.push("Depends: "+packageInfo.Depends);
    packageData.push("MD5sum: "+packageInfo.MD5sum);
    packageData.push("SHA256: "+packageInfo.SHA256);

    ReadStream.push(packageData.join("\n")+"\n\n");
  }
  ReadStream.end();
  ReadStream.destroy();
}

export type ReleaseOptions = {
  Origin: string,
  Suite?: string,
  Archive?: string,
  lebel?: string,
  Codename?: string,
  Architectures: string[],
  Components: string[],
  Description?: string
};

export function mountRelease(repo: ReleaseOptions) {
  let data = [`Origin: ${repo.Origin}\nLebel: ${repo.lebel||repo.Origin}`];
  if (repo.Suite) data.push(`Suite: ${repo.Suite}`);
  else if (repo.Archive) data.push(`Archive: ${repo.Archive}`);
  if (repo.Codename) data.push(`Codename: ${repo.Codename}`);
  data.push(`Architectures: ${repo.Architectures.join(" ")}\nComponents: ${repo.Components.join(" ")}`);
  if (repo.Description) data.push(`Description: ${repo.Description}`);
  return data.join("\n")+"\n";
}