# apt-stream

Create your apt repository with nodejs without having to save files or even take care of storage.

## Storages

You can host an apt rapida repository with the following storages:

- Docker and OCI images (find `.deb` files in diff's)
- Github Releases

## Config file

As a good part of the server will be configured by this file that includes, PGP key port, together with the repositories and their distributions.

Example file:

```yaml
apt-config:
  portListen: 8025
  pgpKey:
    private: ./private.key
    public: ./public.key
repositories:
  main:
    targets:
    # Example to github release
    - from: github_release
      repository: cli
      owner: cli
      takeUpTo: 3
      removeOld: true
      suite: cli_cli

    # Example to docker/OCI images
    - from: oci
      image: example/content
      enableLocalCache: true
      cachePath: "example"
      removeOld: true
      suite: oci_large
      platfom_target:
        platform: linux
        arch:
        - x64
        - arm64
  old:
    targets:
    # Github repository tree
    - from: github_tree
      repository: APT_bysh23
      owner: Sirherobrine23
      suite: main
      path:
      - "/package/main"
      - path: "/package/not-bysh23"
        suite: not_by_sirherobrine
```
