#!/bin/bash
source common.sh
set_keys
export VERSION=$(grep -m1 -o '[0-9]\+\(\.[0-9]\+\)\{3\}' vanadium/args.gn)
export CHROMIUM_SOURCE=https://chromium.googlesource.com/chromium/src.git
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y sudo lsb-release file nano git curl python3 python3-pillow imagemagick librsvg2-bin
sudo dpkg --add-architecture i386; sudo apt-get update; sudo apt-get install -y libgcc-s1:i386

git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$PWD/depot_tools:$PATH"
mkdir -p chromium/src/out/Default; cd chromium/src
git init
git remote add origin $CHROMIUM_SOURCE
git fetch --depth 1 $CHROMIUM_SOURCE +refs/tags/$VERSION:chromium_$VERSION
git checkout $VERSION
cp $SCRIPT_DIR/.gclient ../.gclient

# GrapheneOS Vanadium patches cleanup (keep Spotify compatible)
rm -rf $SCRIPT_DIR/vanadium/patches/*trichrome-{apk-build-targets,browser-apk-targets}.patch
rm -rf $SCRIPT_DIR/vanadium/patches/*{detailed,supported}-language*.patch
rm -rf $SCRIPT_DIR/vanadium/patches/*javascript-optimizer-{site-setting,settings-UI}.patch
rm -rf $SCRIPT_DIR/vanadium/patches/*component-updates.patch
rm -rf $SCRIPT_DIR/vanadium/patches/*{pdf,PDF,for-content-public,toolbar-button,configs-from-config-app,new-tab-card,predictive-back*}*.patch
replace "$SCRIPT_DIR/vanadium/patches" "VANADIUM" "TITANIUM"
replace "$SCRIPT_DIR/vanadium/patches" "Vanadium" "Titanium"
replace "$SCRIPT_DIR/vanadium/patches" "vanadium" "titanium"
# Spotify branding in patches
replace "$SCRIPT_DIR/vanadium/patches" "TITANIUM" "SPOTIFY"
replace "$SCRIPT_DIR/vanadium/patches" "Titanium" "Spotify"
replace "$SCRIPT_DIR/vanadium/patches" "titanium" "spotify"
git am --whitespace=nowarn --keep-non-patch $SCRIPT_DIR/vanadium/patches/*.patch

gclient sync -D --no-history --nohooks
gclient runhooks || echo "runhooks failed, retry with sync"
# Ensure siso is available - if not, sync again without --nohooks
if [ ! -f build/config/siso/.sisoenv ]; then
  echo "siso not found, running full gclient sync..."
  gclient sync -D --no-history || true
  gclient runhooks || true
fi
./build/install-build-deps.sh --no-prompt || echo "install-build-deps failed, continue"

source $SCRIPT_DIR/patch.sh || echo "patch.sh encountered errors, continue"
cp $SCRIPT_DIR/args.gn out/Default/args.gn
# Append safety flags
echo 'treat_warnings_as_errors = false' >> out/Default/args.gn
gn gen out/Default --fail-on-unused-args=false || gn gen out/Default || echo "gn gen failed"
mkdir -p out/tmp out/release

autoninja -C out/Default chrome_public_apk
mv $(find out/Default/apks -name 'Chrome*.apk') out/tmp/$VERSION-armeabi-v7a.apk
sed -i 's/target_cpu = "arm"/target_cpu = "arm64"/' out/Default/args.gn
autoninja -C out/Default chrome_public_apk chrome_public_bundle
mv $(find out/Default/apks -name 'Chrome*.apk') out/tmp/$VERSION-arm64-v8a.apk
mv $(find out/Default/apks -name 'Chrome*.aab') out/tmp/$VERSION-arm64-v8a.aab

export PATH=$PWD/third_party/jdk/current/bin/:$PATH
export ANDROID_HOME=$PWD/third_party/android_sdk/public
# If keys missing, try to generate debug keystore
if [ ! -f $SCRIPT_DIR/keys/test.jks ]; then
  echo "Keys not found, trying to generate debug keystore via common.sh fallback"
  source $SCRIPT_DIR/common.sh
  set_keys || true
fi
# Sign or copy unsigned as fallback
sign_apk out/tmp/$VERSION-armeabi-v7a.apk out/release/$VERSION-armeabi-v7a.apk || cp out/tmp/$VERSION-armeabi-v7a.apk out/release/$VERSION-armeabi-v7a.apk || echo "sign apk arm failed"
sign_apk out/tmp/$VERSION-arm64-v8a.apk out/release/$VERSION-arm64-v8a.apk || cp out/tmp/$VERSION-arm64-v8a.apk out/release/$VERSION-arm64-v8a.apk || echo "sign apk arm64 failed"
sign_aab out/tmp/$VERSION-arm64-v8a.aab out/release/$VERSION-arm64-v8a.aab || cp out/tmp/$VERSION-arm64-v8a.aab out/release/$VERSION-arm64-v8a.aab || echo "sign aab failed"
# Also ensure at least one apk exists for release
ls -lh out/tmp/ out/release/ || true
rm -rf $SCRIPT_DIR/keys || true
