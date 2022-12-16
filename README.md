# node-apt

Crie seu repositorio apt com o nodejs sem precisas salvar arquivos ou mesmo cuidar do armazenamento.

## Storages

Como esse projeto voçe hospedar um repositorio do apt rapida com os seguintes storages:

- Docker and OCI images (find `.deb` files in diff's)
- Github Releases
- Local folders

## Endpoints

Esse projeto foi feito com base nas rotas do `archive.ubuntu.com` e do `ftp.debian.org`.

* `GET` /dists/:package-name/Release
* `GET` /dists/:package-name/main/binary-:arch/Packages
* `GET` /dists/:package-name/main/binary-:arch/Packages.gz
* `GET` /dists/:package-name/main/binary-:arch/Releases

### Download .deb and package info

* `GET` /pool/:package_name/:version/:arch.deb - `Download .deb file`
* `GET` /pool/:package_name/:version/:arch - `Config package if exists`
* `GET` /pool/:package_name/:version - `Get version with config`
* `GET` /pool/:package_name - `Get all versions with config`
* `GET` /pool - `Get packages registred to packages registry`