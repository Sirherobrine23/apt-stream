# apt-stream

Create your apt repository with nodejs without having to save files or even take care of storage.

## Storages

You can host an apt fast repository with the following storages:

- Docker and OCI images (find `.deb` files in diff's)
- Github Releases and Tree
- Google Driver
- Oracle Cloud Bucket, another driver soon

## Setup

The configuration will be very simple, the first time you run the server or even just run `apt-stream` it will look for the file in the current folder if not the one informed by the cli by the `--config/-c <path>` argument .

you can also create the file manually after running `apt-stream` it will make a pretty of the settings, and if there is something wrong it will ignore it or it will crash the whole program.