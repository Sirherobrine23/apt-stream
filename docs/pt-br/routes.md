Este projeto é totalmente pesornalizado, mas devemos manter sim um padrão do APT para seu funcionamento correto como por exemple sua rotas `/dists`.

## Dist path's

* `/dists/:distName/:componentName/binary-:Arch/Packages(.(gz|xz))?`
* `/dists/:distName/((InRelease|Release(.gpg)?)?)`

## Pool path

* `/pool/:packageName/(:version)-(:arch).deb`