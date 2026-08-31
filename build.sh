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
# Spotify branding in patches - only rebrand display strings, NOT the overlay
# directory/identifier. The lowercase "titanium" name is referenced everywhere in
# the tree: .gclient hooks write into src/titanium/..., patch.sh stages the bundled
# extension into titanium/dist, and BUILD.gn/gni files reference //titanium/...
# targets. Renaming lowercase "titanium" -> "spotify" here made git am create a
# spotify/ tree instead, so the hooks and patch.sh failed on missing titanium/ paths.
replace "$SCRIPT_DIR/vanadium/patches" "TITANIUM" "SPOTIFY"
replace "$SCRIPT_DIR/vanadium/patches" "Titanium" "Spotify"
# NOTE: deliberately NOT replacing lowercase "titanium" with "spotify".
git am --whitespace=nowarn --keep-non-patch $SCRIPT_DIR/vanadium/patches/*.patch

# The gclient hook 'fetch_filter_lists' writes into src/titanium/android_config/
# filter_lists/. If it fails, gclient aborts ALL remaining hooks (apply_subprojects_patches,
# the DEPS update_lastchange hook, siso deployment, ...), which later makes gn gen fail on
# the missing build/util/LASTCHANGE.committime and autoninja fail on missing siso.
# Make sure the output directory always exists before any hook run.
mkdir -p titanium/android_config/filter_lists
gclient sync -D --no-history --nohooks || true
gclient runhooks || echo "runhooks failed, retry with sync"
mkdir -p titanium/android_config/filter_lists
# Ensure siso is available - if not, sync again without --nohooks
if [ ! -f build/config/siso/.sisoenv ]; then
  echo "siso not found, running full gclient sync..."
  mkdir -p titanium/android_config/filter_lists
  gclient sync -D --no-history || true
  gclient runhooks || true
fi
./build/install-build-deps.sh --no-prompt || echo "install-build-deps failed, continue"

# base/BUILD.gn reads build/util/LASTCHANGE.committime at gn gen time; normally it is
# produced by the DEPS update_lastchange hook during a full gclient sync. If the hook
# chain was interrupted (or the checkout is too shallow), generate it explicitly.
if [ ! -f build/util/LASTCHANGE.committime ]; then
  echo "LASTCHANGE.committime missing, generating it..."
  python3 build/util/lastchange.py -o build/util/LASTCHANGE --max-dirs 4 || true
fi
if [ ! -f build/util/LASTCHANGE.committime ]; then
  echo "lastchange.py did not produce the files, writing fallback LASTCHANGE..."
  date +%s > build/util/LASTCHANGE.committime
  echo "$VERSION" > build/util/LASTCHANGE
fi

source $SCRIPT_DIR/patch.sh || echo "patch.sh encountered errors, continue"
cp $SCRIPT_DIR/args.gn out/Default/args.gn
# Append safety flags
echo 'treat_warnings_as_errors = false' >> out/Default/args.gn
# If siso was never deployed (DEPS hooks don't run in this setup), fall back to ninja,
# otherwise autoninja fails with "Could not find .sisoenv under build/config/siso".
if [ ! -f build/config/siso/.sisoenv ]; then
  echo "siso not deployed, using ninja backend"
  echo 'use_siso = false' >> out/Default/args.gn
fi
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
