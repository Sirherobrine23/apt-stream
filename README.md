# apt-stream

Create your apt repository with nodejs without having to save files or even take care of storage.

## Storages

You can host an apt rapida repository with the following storages:

- Docker and OCI images (find `.deb` files in diff's)
- Github Releases

## Config file

Estou ainda mexendo com o arquivo de configuração dos repositorios, e do servidor por enquanto está com está até eu poder mexer direito nele.

```yaml
# Global apt config
apt-config:
  origin: ""
  enableHash: true # if it is enabled, it may freeze the request a little because I have to wait for the hashes of the "Packages" files
  sourcesHost: http://localhost:3000
  # If you want to use a custom sources.list
  sourcesList: deb [trusted=yes] %s://%s %s main

repositories:
# Example to docker and OCI image
- from: oci
  image: ghcr.io/sirherobrine23/nodeaptexample
  # Release endpoint config
  apt-config:
    origin: github.com/cli/cli
    lebel: github-cli
    description: |
      This is example
      is this second line of description.

# Example to github release
- from: github_release
  repository: cli/cli

- from: github_release
  owner: cli
  repository: cli
  token: ""
```

## Endpoints

This project was made based on the `archive.ubuntu.com` and `ftp.debian.org` routes.

* `GET` /dists/:package-name/Release
* `GET` /dists/:package-name/main/binary-:arch/Packages
* `GET` /dists/:package-name/main/binary-:arch/Packages.gz
* `GET` /dists/:package-name/main/binary-:arch/Releases

### Download .deb and package info

* `GET` /pool/:package_name/:version/:arch.deb - `Download .deb file`
* `GET` /pool and / - `Get packages registred to packages registry`