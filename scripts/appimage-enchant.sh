#!/usr/bin/env bash
# Builds the enchant the AppImage bundles for WebKitGTK spell checking.
# The distro libenchant loads providers only from its compiled-in directory
# (/usr/lib/x86_64-linux-gnu/enchant-2 on Ubuntu), which does not exist on
# other distros, and ships no providers in the AppImage. This build loads
# providers from enchant-2 next to the library instead (appimage-enchant.patch)
# and keeps only hunspell, which reads the system's dictionaries.
#
# Usage: appimage-enchant.sh <output-dir>
#   <output-dir>/libenchant-2.so.2                 replaces the system copy so
#                                                  linuxdeploy bundles it
#   <output-dir>/enchant-2/enchant_hunspell.so     -> AppDir usr/lib/enchant-2
#   <output-dir>/libhunspell-1.7.so.0              -> AppDir usr/lib
set -euo pipefail

version=2.3.2
sha256=ce9ba47fd4d34031bd69445598a698a6611602b2b0e91d705e91a6f5099ead6e
patch_file=$(realpath "$(dirname "$0")/appimage-enchant.patch")
output=$(realpath -m "$1")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/enchant.tar.gz" "https://github.com/AbiWord/enchant/releases/download/v$version/enchant-$version.tar.gz"
echo "$sha256  $work/enchant.tar.gz" | sha256sum -c --quiet -
tar -xzf "$work/enchant.tar.gz" -C "$work"
cd "$work/enchant-$version"
patch -p1 < "$patch_file"
./configure --prefix=/usr --libdir=/usr/lib --disable-static \
	--with-hunspell --with-hunspell-dir=/usr/share/hunspell \
	--without-nuspell --without-aspell --without-hspell --without-voikko
make -j"$(nproc)"
make install DESTDIR="$work/install"

rm -rf "$output"
mkdir -p "$output/enchant-2"
lib="$work/install/usr/lib"
cp -L "$lib/libenchant-2.so.2" "$output/"
cp "$lib/enchant-2/enchant_hunspell.so" "$output/enchant-2/"
cp -L "$(ldd "$output/enchant-2/enchant_hunspell.so" | awk '$1 == "libhunspell-1.7.so.0" {print $3}')" "$output/"
# Find the bundled libenchant and libhunspell rather than the system's.
patchelf --set-rpath '$ORIGIN/..' "$output/enchant-2/enchant_hunspell.so"
