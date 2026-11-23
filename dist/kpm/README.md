# Coop Reader as a KPM package

KPM (Kindle Package Manager, KindleModding) is the installer for newer jailbreaks where KUAL is not available (firmware 5.19.4 and later).
This folder is the *source* of a KPM package: `manifest.json`, `install.sh`, `launch.sh`, `uninstall.sh`. `build-kindle.sh` copies the plugin
into `payload/` and writes the ready-to-pack folder to `dist/kpm/coop-reader/`.

**Packing is done with KindleModding's own tool** (this repository does not guess the `.kpkg` format):

```sh
git clone https://github.com/KindleModding/KPM && cd KPM
python3 kpm-helper.py --help               # see the package / repo sub-commands of your version
# pack dist/kpm/coop-reader with the package command, then publish the result in a KPM repository
# (a KPM repository is a static manifest.json, so the web app's GitHub Pages site can host it: see "Creating a Repository" on kindlemodding.org).
```

Before packing run `python3 kpm-helper.py` `package init` once in an empty folder and compare its `manifest.json` with ours: field names are
taken from the public documentation and may differ between KPM versions.

What the package does on the Kindle
* **install** puts the plugin into `koreader/plugins/` (and the KUAL extension into `extensions/` when KUAL exists),
* **launch** (the entry KPM shows) opens KOReader straight into the Coop Reader **home screen**; `launch.sh host|join|join:<PIN>|settings|test` jumps to a screen,
* **uninstall** removes both and keeps your settings.
