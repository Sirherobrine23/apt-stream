/**
Package: 0ad
Binary: 0ad
Version: 0.0.26-3
Maintainer: Debian Games Team <pkg-games-devel@lists.alioth.debian.org>
Uploaders: Vincent Cheng <vcheng@debian.org>, Ludovic Rousseau <rousseau@debian.org>
Build-Depends: autoconf, automake, cargo, cmake, debhelper-compat (= 13), dh-exec (>= 0.1), dpkg-dev (>= 1.15.5), git, libboost-dev (>= 1.57.0.1), libboost-filesystem-dev (>= 1.57.0.1), libcurl4-gnutls-dev (>= 7.32.0) | libcurl4-dev (>= 7.32.0), libenet-dev (>= 1.3), libfmt-dev (>= 4.0.0), libfreetype-dev, libgloox-dev (>= 1.0.10), libicu-dev (>= 67.1-4~), libminiupnpc-dev (>= 1.6), libogg-dev, libopenal-dev, libpng-dev, libsdl2-dev (>= 2.0.5), libsodium-dev (>= 1.0.14), libvorbis-dev, libwxgtk3.2-dev, libxcursor-dev, libxml2-dev, llvm, pkg-config, python3, rustc (>= 1.41), tzdata, zlib1g-dev (>= 1:1.2.3)
Architecture: amd64 arm64 armhf i386 kfreebsd-amd64 kfreebsd-i386
Standards-Version: 4.6.2
Format: 3.0 (quilt)
Files:
 4d5f452a06bcdba6907f3350219a63db 2565 0ad_0.0.26-3.dsc
 11b79970197c19241708e2a6cadb416d 78065537 0ad_0.0.26.orig.tar.gz
 ef7590961dc6e47d913d9bcec038f52e 5078552 0ad_0.0.26-3.debian.tar.xz
Vcs-Browser: https://salsa.debian.org/games-team/0ad
Vcs-Git: https://salsa.debian.org/games-team/0ad.git
Checksums-Sha256:
 c2d4b91d9d20a27b4989495d3b370635e79e2f7a4ed1f9031abc89e9c1d50952 2565 0ad_0.0.26-3.dsc
 4a9905004e220d774ff07fd31fe5caab3ada3807eeb7bf664b2904583711421c 78065537 0ad_0.0.26.orig.tar.gz
 2efd0a143ce83496c8984ed3b3e20f2ab84dbc391fcf3d02229d1f1053a1b75c 5078552 0ad_0.0.26-3.debian.tar.xz
Homepage: https://play0ad.com/
Package-List:
 0ad deb games optional arch=amd64,arm64,armhf,i386,kfreebsd-amd64,kfreebsd-i386
Directory: pool/main/0/0ad
Priority: source
Section: games
*/

export interface packageSource {
  Package: string;
  Binary: string;
  Version: string;
  Maintainer?: string;
  Uploaders?: string;
  "Build-Depends": string[];
  "Standards-Version": string
  Format: "3.0 (quilt)"
  Files: {hash: string, size: number, filePath: string}[];
  "Vcs-Browser": string;
  "Vcs-Git": string;
  "Checksums-Sha256":{hash: string, size: number, filePath: string}[];
  Homepage: string;
  "Package-List": string[]; // 0ad deb games optional arch=amd64,arm64,armhf,i386,kfreebsd-amd64,kfreebsd-i386
  Directory: string;
  Priority: "source";
  Section: string
}